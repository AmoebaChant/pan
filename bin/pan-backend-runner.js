#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  mkdir,
  open,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { inspectProcess } from './pan-runner-runtime.js';
import { isCliEntry, loadTaskBackend, writeJson } from './pan-task-backend.js';

const RUN_VERSION = 1;

export function selectReadyForAi(tasks) {
  return tasks.filter((task) =>
    task.status === 'ready-for-ai'
    && task.nextAction === 'execute'
    && task.executionAuthorized === true
    && task.dependencies.length === 0
    && task.worker == null
    && task.recurring !== true,
  );
}

export async function pollBackendTasks({
  backend,
  capacity,
  activeTaskIds = new Set(),
  allowedTaskIds = new Set(),
  workspaceBusy = false,
  dryRun = false,
  launch,
}) {
  const tasks = await backend.list();
  const selected = selectReadyForAi(tasks).filter((task) =>
    !activeTaskIds.has(task.id)
    && (allowedTaskIds.size === 0 || allowedTaskIds.has(String(task.id))),
  );
  const launched = [];
  if (!dryRun && !workspaceBusy) {
    for (const task of selected.slice(0, Math.max(0, capacity))) {
      if (await launch(task) !== false) launched.push(task.id);
    }
  }
  return {
    observed: tasks.length,
    candidates: selected.length,
    selected: selected.map((task) => task.id),
    launched,
    workspaceBusy,
  };
}

function runDirectory(stateRoot, taskId) {
  return path.join(stateRoot, 'runs', encodeURIComponent(taskId));
}

function lockPath(stateRoot, taskId) {
  return path.join(stateRoot, 'locks', `${encodeURIComponent(taskId)}.lock`);
}

function runnerLockPath(stateRoot) {
  return path.join(stateRoot, 'runner.lock');
}

async function readJson(filename) {
  return JSON.parse(await readFile(filename, 'utf8'));
}

function parseCopilotConfig(raw) {
  const lines = raw.split('\n');
  let index = 0;
  while (
    index < lines.length
    && (lines[index].trimStart().startsWith('//') || lines[index].trim() === '')
  ) {
    index += 1;
  }
  const header = lines.slice(0, index).join('\n');
  const body = lines.slice(index).join('\n').trim();
  const config = body ? JSON.parse(body) : {};
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('Copilot config must contain a JSON object');
  }
  if (config.trustedFolders !== undefined && !Array.isArray(config.trustedFolders)) {
    throw new Error('Copilot config trustedFolders must be an array');
  }
  return { header, config };
}

export async function trustCopilotFolders(
  configPath,
  folderPaths,
  dependencies = {},
) {
  const read = dependencies.readFile || readFile;
  const write = dependencies.writeFile || writeFile;
  const makeDirectory = dependencies.mkdir || mkdir;
  let raw = '';
  try {
    raw = await read(configPath, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const { header, config } = parseCopilotConfig(raw);
  const trusted = config.trustedFolders ?? [];
  const requested = [...new Set(folderPaths.map((folder) => path.resolve(folder)))];
  const added = requested.filter((folder) => !trusted.includes(folder));
  if (added.length > 0) {
    config.trustedFolders = [...trusted, ...added];
    const output = `${header ? `${header}\n` : ''}${JSON.stringify(config, null, 2)}\n`;
    await makeDirectory(path.dirname(configPath), { recursive: true, mode: 0o700 });
    await write(configPath, output, { mode: 0o600 });
  }
  const verified = parseCopilotConfig(await read(configPath, 'utf8')).config;
  if (!requested.every((folder) => verified.trustedFolders?.includes(folder))) {
    throw new Error(`could not verify Copilot trustedFolders in ${configPath}`);
  }
  return {
    configPath,
    added,
    alreadyTrusted: requested.filter((folder) => !added.includes(folder)),
  };
}

async function prepareCopilotHome(sourceConfigPath, stateDir, folderPaths) {
  const raw = await readFile(sourceConfigPath, 'utf8');
  const { header, config } = parseCopilotConfig(raw);
  config.memory = false;
  const copilotHome = path.join(stateDir, 'copilot-home');
  const targetConfigPath = path.join(copilotHome, 'config.json');
  await mkdir(copilotHome, { recursive: true, mode: 0o700 });
  await writeFile(
    targetConfigPath,
    `${header ? `${header}\n` : ''}${JSON.stringify(config, null, 2)}\n`,
    { mode: 0o600 },
  );
  const trust = await trustCopilotFolders(targetConfigPath, folderPaths);
  return { copilotHome, sourceConfigPath, ...trust };
}

export async function inspectLocalRuns(
  stateRoot,
  { inspect = inspectProcess } = {},
) {
  const runsRoot = path.join(stateRoot, 'runs');
  let entries;
  try {
    entries = await readdir(runsRoot, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return { live: [], stale: [], uncertain: [] };
    throw error;
  }
  const result = { live: [], stale: [], uncertain: [] };
  for (const entry of entries.filter((candidate) => candidate.isDirectory())) {
    const dir = path.join(runsRoot, entry.name);
    let run;
    try {
      run = await readJson(path.join(dir, 'run.json'));
      if (
        run.version !== RUN_VERSION
        || typeof run.taskId !== 'string'
        || typeof run.sessionId !== 'string'
      ) {
        throw new Error('invalid run record');
      }
    } catch (error) {
      result.uncertain.push({ dir, reason: error.message });
      continue;
    }
    let owner;
    try {
      owner = await readJson(path.join(dir, 'owner.json'));
      if (!Number.isInteger(owner.pid) || typeof owner.processStart !== 'string') {
        throw new Error('invalid owner record');
      }
    } catch (error) {
      if (error.code === 'ENOENT') {
        try {
          const exit = await readJson(path.join(dir, 'exit.json'));
          if (
            typeof exit.exitedAt !== 'string'
            || (typeof exit.error !== 'string' && !Number.isInteger(exit.code))
          ) {
            throw new Error('invalid exit record');
          }
          result.stale.push({
            ...run,
            dir,
            owner: null,
            exit,
            observed: { state: 'dead', identity: null },
          });
          continue;
        } catch (exitError) {
          result.uncertain.push({ ...run, dir, reason: exitError.message });
          continue;
        }
      }
      result.uncertain.push({ ...run, dir, reason: error.message });
      continue;
    }
    const observed = await inspect(owner.pid);
    const record = { ...run, dir, owner, observed };
    if (observed.state === 'live' && observed.identity === owner.processStart) {
      result.live.push(record);
    } else if (observed.state === 'dead' || observed.identity !== owner.processStart) {
      result.stale.push(record);
    } else {
      result.uncertain.push(record);
    }
  }
  return result;
}

export async function reconcileStaleRuns(stateRoot, stale, backend) {
  const reconciled = [];
  for (const run of stale) {
    try {
      const task = await backend.get(run.taskId);
      if (task.worker?.sessionId === run.sessionId) {
        await backend.update(run.taskId, {
          expectedRevision: task.revision,
          worker: {
            ...task.worker,
            state: 'stopped',
            stoppedAt: new Date().toISOString(),
          },
        });
        await backend.report(run.taskId, {
          content: `Pan runner observed that local session ${run.sessionId} is no longer running.`,
        });
      }
      await rm(lockPath(stateRoot, run.taskId), { force: true });
      reconciled.push(run.taskId);
    } catch {
      // Leave the lock in place. A failed observation write must fail closed.
    }
  }
  return reconciled;
}

async function acquireTaskLock(stateRoot, taskId) {
  const locks = path.join(stateRoot, 'locks');
  await mkdir(locks, { recursive: true, mode: 0o700 });
  const filename = lockPath(stateRoot, taskId);
  try {
    const handle = await open(filename, 'wx', 0o600);
    return { handle, filename };
  } catch (error) {
    if (error.code === 'EEXIST') return null;
    throw error;
  }
}

async function releaseTaskLock(lock) {
  if (!lock) return;
  await lock.handle.close().catch(() => {});
  await rm(lock.filename, { force: true });
}

async function acquireRunnerLock(stateRoot, inspect = inspectProcess) {
  await mkdir(stateRoot, { recursive: true, mode: 0o700 });
  const filename = runnerLockPath(stateRoot);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(filename, 'wx', 0o600);
      const observed = await inspect(process.pid);
      if (observed.state !== 'live' || typeof observed.identity !== 'string') {
        await handle.close();
        await rm(filename, { force: true });
        throw new Error('cannot establish runner process identity');
      }
      await handle.writeFile(`${JSON.stringify({
        pid: process.pid,
        processStart: observed.identity,
        recordedAt: new Date().toISOString(),
      }, null, 2)}\n`);
      await handle.sync();
      return { handle, filename };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let owner;
      try {
        owner = await readJson(filename);
      } catch {
        throw new Error(`another backend runner holds ${filename}`);
      }
      const observed = await inspect(owner.pid);
      if (
        observed.state === 'live'
        && observed.identity === owner.processStart
      ) {
        throw new Error(`another backend runner holds ${filename}`);
      }
      await rm(filename, { force: true });
    }
  }
  throw new Error(`could not acquire backend runner lock ${filename}`);
}

async function releaseRunnerLock(lock) {
  if (!lock) return;
  await lock.handle.close().catch(() => {});
  await rm(lock.filename, { force: true });
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function appleScriptEscape(value) {
  return String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

function spawnAndWait(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options);
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited ${code ?? signal ?? 'unknown'}`));
    });
  });
}

function launcherSource({
  command,
  promptPath,
  stateDir,
  workingDirectory,
  additionalDirectories,
  copilotHome,
}) {
  return `import { execFileSync, spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const stateDir=${JSON.stringify(stateDir)};
const command=${JSON.stringify(command)};
const prompt=readFileSync(${JSON.stringify(promptPath)},'utf8');
function identity(){
  if(process.platform==='darwin'){
    return 'darwin:'+execFileSync('/bin/ps',['-p',String(process.pid),'-o','lstart=']).toString().trim();
  }
  if(process.platform==='linux'){
    const stat=readFileSync('/proc/'+process.pid+'/stat','utf8');
    const fields=stat.slice(stat.lastIndexOf(')')+1).trim().split(/\\s+/);
    return 'linux:'+readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim()+':'+fields[19];
  }
  throw new Error('unsupported launcher platform');
}
writeFileSync(path.join(stateDir,'owner.json'),JSON.stringify({pid:process.pid,processStart:identity(),recordedAt:new Date().toISOString()},null,2)+'\\n',{flag:'wx',mode:0o600});
const args=command.slice(1).filter((value)=>value!=='--interactive'&&value!=='-i');
const allowedDirectories=[
  ${JSON.stringify(workingDirectory)},
  stateDir,
  ...${JSON.stringify(additionalDirectories)},
];
for(const directory of allowedDirectories){
  args.push('--add-dir',directory);
}
const child=spawn(command[0],[...args,'--interactive',prompt],{
  cwd:${JSON.stringify(workingDirectory)},
  stdio:'inherit',
  env:{...process.env,COPILOT_HOME:${JSON.stringify(copilotHome)},PAN_STATE_DIR:stateDir,PAN_WORKING_DIRECTORY:${JSON.stringify(workingDirectory)}},
});
child.once('error',(error)=>{
  writeFileSync(path.join(stateDir,'exit.json'),JSON.stringify({exitedAt:new Date().toISOString(),error:error.message},null,2)+'\\n',{mode:0o600});
  process.exit(1);
});
child.once('exit',(code,signal)=>{
  writeFileSync(path.join(stateDir,'exit.json'),JSON.stringify({exitedAt:new Date().toISOString(),code,signal},null,2)+'\\n',{mode:0o600});
  process.exit(code??1);
});
`;
}

async function launchTerminal(stateDir, workingDirectory, terminalKind) {
  const launcher = path.join(stateDir, 'launch.mjs');
  if (terminalKind === 'macos-terminal') {
    const command = `cd ${shellQuote(workingDirectory)} && exec ${shellQuote(process.execPath)} ${shellQuote(launcher)}`;
    await spawnAndWait('osascript', [
      '-e', `tell application "Terminal" to do script "${appleScriptEscape(command)}"`,
      '-e', 'tell application "Terminal" to activate',
    ]);
    return;
  }
  if (terminalKind === 'windows-terminal') {
    await spawnAndWait('wt.exe', ['-w', '0', 'nt', '-d', workingDirectory, process.execPath, launcher]);
    return;
  }
  throw new Error(`unsupported terminal kind: ${terminalKind}`);
}

async function waitForOwner(stateDir, inspect, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const owner = await readJson(path.join(stateDir, 'owner.json'));
      const observed = await inspect(owner.pid);
      if (observed.state === 'live' && observed.identity === owner.processStart) {
        return owner;
      }
      throw new Error('launcher owner identity does not match the live process');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('launcher did not establish durable process ownership');
}

export async function launchTask(task, config, backend, dependencies = {}) {
  const stateRoot = path.resolve(config.stateRoot);
  const allowedTaskIds = new Set((config.taskIds ?? []).map(String));
  if (allowedTaskIds.size > 0 && !allowedTaskIds.has(String(task.id))) {
    throw new Error(`task ${task.id} is outside the runner taskIds allowlist`);
  }
  await mkdir(path.join(stateRoot, 'runs'), { recursive: true, mode: 0o700 });
  const lock = await acquireTaskLock(stateRoot, task.id);
  if (!lock) return false;
  const sessionId = randomUUID();
  const stateDir = runDirectory(stateRoot, task.id);
  const command = config.launchCommand;
  let starting;
  let terminalStarted = false;
  try {
    if (!Array.isArray(command) || !command.length || command.some((part) => typeof part !== 'string')) {
      throw new Error('launchCommand must be a non-empty array of strings');
    }
    const modelIndex = command.indexOf('--model');
    if (modelIndex < 0 || command[modelIndex + 1] !== 'gpt-5.6-sol') {
      throw new Error('launchCommand must select --model gpt-5.6-sol');
    }
    if (task.playbook !== config.playbookName) {
      throw new Error(`task playbook must be ${config.playbookName}`);
    }
    for (const field of ['panTaskCommand', 'playbookPath', 'domainInstructionsPath']) {
      if (!path.isAbsolute(config[field] || '')) {
        throw new Error(`${field} must be an absolute path`);
      }
    }
    await rm(stateDir, { recursive: true, force: true });
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    const [playbook, domainInstructions, reports] = await Promise.all([
      readFile(config.playbookPath, 'utf8'),
      readFile(config.domainInstructionsPath, 'utf8'),
      backend.reports ? backend.reports(task.id) : [],
    ]);
    const run = {
      version: RUN_VERSION,
      taskId: task.id,
      sessionId,
      machine: config.machine,
      workingDirectory: path.resolve(config.workingDirectory),
      createdAt: new Date().toISOString(),
    };
    await writeFile(path.join(stateDir, 'run.json'), `${JSON.stringify(run, null, 2)}\n`, { mode: 0o600 });
    await writeFile(path.join(stateDir, 'task.json'), `${JSON.stringify(task, null, 2)}\n`, { mode: 0o600 });
    await writeFile(path.join(stateDir, 'playbook.md'), playbook, { mode: 0o600 });
    await writeFile(path.join(stateDir, 'pan.md'), domainInstructions, { mode: 0o600 });
    await writeFile(
      path.join(stateDir, 'reports.json'),
      `${JSON.stringify(reports, null, 2)}\n`,
      { mode: 0o600 },
    );
    const trust = await prepareCopilotHome(
      path.resolve(config.copilotConfigPath || path.join(os.homedir(), '.copilot', 'config.json')),
      stateDir,
      [path.resolve(config.workingDirectory), stateDir],
    );
    await writeFile(
      path.join(stateDir, 'trust.json'),
      `${JSON.stringify({ ...trust, recordedAt: new Date().toISOString() }, null, 2)}\n`,
      { mode: 0o600 },
    );
    const taskCommand = `${process.execPath} ${config.panTaskCommand}`;
    const reportInputPath = path.join(stateDir, 'report-request.json');
    const prompt = [
      `Execute Pan task ${task.id}: ${task.title}`,
      `Read ${path.join(stateDir, 'task.json')}, ${path.join(stateDir, 'playbook.md')}, ${path.join(stateDir, 'pan.md')}, and ${path.join(stateDir, 'reports.json')}.`,
      `Read current task state with: ${taskCommand} --config ${JSON.stringify(config.backendConfig)} get ${JSON.stringify(task.id)}`,
      `Read durable reports with: ${taskCommand} --config ${JSON.stringify(config.backendConfig)} reports ${JSON.stringify(task.id)}`,
      `Write the report request JSON only to ${reportInputPath}, then record it with: ${taskCommand} --config ${JSON.stringify(config.backendConfig)} report ${JSON.stringify(task.id)} --input @${reportInputPath}`,
      'Do not complete the backend task; the coordinating Pan session completes it after verifying your report and files.',
      `Task URL: ${task.url}`,
    ].join('\n');
    const promptPath = path.join(stateDir, 'launch-prompt.txt');
    await writeFile(promptPath, `${prompt}\n`, { mode: 0o600 });
    await writeFile(
      path.join(stateDir, 'launch.mjs'),
      launcherSource({
        command,
        promptPath,
        stateDir,
        workingDirectory: path.resolve(config.workingDirectory),
        additionalDirectories: [
          path.dirname(process.execPath),
          path.dirname(path.resolve(config.panTaskCommand)),
          path.dirname(path.resolve(config.backendConfig)),
        ],
        copilotHome: trust.copilotHome,
      }),
      { mode: 0o600 },
    );
    starting = await backend.update(task.id, {
      expectedRevision: task.revision,
      worker: { state: 'starting', machine: config.machine, sessionId },
    });
    if (allowedTaskIds.size > 0 && !allowedTaskIds.has(String(task.id))) {
      throw new Error(`task ${task.id} is outside the runner taskIds allowlist`);
    }
    await (dependencies.launchTerminal || launchTerminal)(
      stateDir,
      path.resolve(config.workingDirectory),
      config.terminal?.kind || (process.platform === 'darwin' ? 'macos-terminal' : 'windows-terminal'),
    );
    terminalStarted = true;
    const owner = await waitForOwner(
      stateDir,
      dependencies.inspect || inspectProcess,
      dependencies.ownerTimeoutMs,
    );
    await backend.update(task.id, {
      expectedRevision: starting.revision,
      worker: {
        state: 'running',
        machine: config.machine,
        sessionId,
        pid: owner.pid,
        processStart: owner.processStart,
      },
    });
    await lock.handle.close();
    return true;
  } catch (error) {
    if (starting) {
      await backend.update(task.id, {
        expectedRevision: starting.revision,
        worker: {
          state: terminalStarted ? 'uncertain' : 'stopped',
          machine: config.machine,
          sessionId,
          error: error.message,
        },
      }).catch(() => {});
      await backend.report(task.id, {
        content: `Pan runner launch failed on ${config.machine}: ${error.message}`,
      }).catch(() => {});
    }
    if (!terminalStarted) {
      await writeFile(
        path.join(stateDir, 'exit.json'),
        `${JSON.stringify({ exitedAt: new Date().toISOString(), error: error.message }, null, 2)}\n`,
        { mode: 0o600 },
      ).catch(() => {});
      await releaseTaskLock(lock);
    } else {
      await lock.handle.close().catch(() => {});
    }
    throw error;
  }
}

export async function runBackendRunner(argv, dependencies = {}) {
  const { values } = parseArgs({
    args: argv,
    options: {
      config: { type: 'string' },
      once: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
  });
  if (values.help) return { help: true };
  if (!values.config) throw new Error('--config is required');
  const config = JSON.parse(await readFile(path.resolve(values.config), 'utf8'));
  for (const field of ['backendConfig', 'machine', 'stateRoot', 'workingDirectory']) {
    if (!String(config[field] || '').trim()) throw new Error(`${field} is required`);
  }
  if (config.enabled !== true && !values['dry-run']) {
    throw new Error('backend runner is disabled; set enabled=true only after review');
  }
  if (!values['dry-run']) {
    for (const field of ['playbookName', 'panTaskCommand', 'playbookPath', 'domainInstructionsPath']) {
      if (!String(config[field] || '').trim()) throw new Error(`${field} is required`);
    }
  }
  const runnerLock = values['dry-run']
    ? null
    : await acquireRunnerLock(path.resolve(config.stateRoot), dependencies.inspect || inspectProcess);
  try {
    const backend = await loadTaskBackend(config.backendConfig, dependencies);
    await backend.initialize();
    const poll = async () => {
      const inventory = await inspectLocalRuns(path.resolve(config.stateRoot), {
        inspect: dependencies.inspect || inspectProcess,
      });
      if (!values['dry-run']) {
        await reconcileStaleRuns(path.resolve(config.stateRoot), inventory.stale, backend);
      }
      const activeTaskIds = new Set(inventory.live.map((run) => run.taskId));
      const workspace = path.resolve(config.workingDirectory);
      const workspaceBusy = inventory.live.some(
        (run) => path.resolve(run.workingDirectory) === workspace,
      ) || inventory.uncertain.some((run) =>
        run.workingDirectory == null || path.resolve(run.workingDirectory) === workspace,
      );
      // This pilot has one configured working directory rather than a workspace
      // pool, so at most one new task may enter it in a poll.
      const capacity = Math.min(
        1,
        Math.max(0, (config.maxConcurrent ?? 1) - inventory.live.length),
      );
      return pollBackendTasks({
        backend,
        capacity,
        activeTaskIds,
        workspaceBusy,
        dryRun: values['dry-run'],
        allowedTaskIds: new Set((config.taskIds ?? []).map(String)),
        launch: dependencies.launch || ((task) => launchTask(task, config, backend, dependencies)),
      });
    };
    if (values.once || values['dry-run']) return poll();
    const interval = Number(config.pollIntervalSeconds ?? 30);
    if (!Number.isFinite(interval) || interval <= 0) {
      throw new Error('pollIntervalSeconds must be greater than zero');
    }
    for (;;) {
      writeJson({ ok: true, result: await poll() }, process.stderr);
      await new Promise((resolve) => setTimeout(resolve, interval * 1000));
    }
  } finally {
    await releaseRunnerLock(runnerLock);
  }
}

if (isCliEntry(import.meta.url)) {
  runBackendRunner(process.argv.slice(2))
    .then((result) => writeJson({ ok: true, result }))
    .catch((error) => {
      writeJson({ ok: false, error: { message: error.message } }, process.stderr);
      process.exitCode = 1;
    });
}
