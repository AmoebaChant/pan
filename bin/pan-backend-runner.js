#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { isCliEntry, loadTaskBackend, writeJson } from './pan-task-backend.js';
import {
  loadBackendPlaybooks,
  loadBackendWorkstream,
  resolvePlaybookWorkingDirectory,
} from './pan-backend-playbooks.js';

const RELEASE_FILE = 'worker-release.json';
const RUN_FILE = 'run.json';
const RUNNER_LOCK_FILE = 'runner.lock';
const SYSTEM_DIR = fileURLToPath(new URL('../system', import.meta.url));
const execFileAsync = promisify(execFile);
const RUNNER_MANAGED_LONG_OPTIONS = new Set([
  '--session-id',
  '--resume',
  '--continue',
  '--prompt',
  '--interactive',
  '--allow-all-paths',
  '--add-dir',
]);
const RUNNER_MANAGED_SHORT_OPTIONS = new Set(['-r', '-p', '-i']);

function assertAbsolute(value, name) {
  if (!value || !path.isAbsolute(value)) throw new Error(`${name} must be absolute`);
  return path.resolve(value);
}

function isRunnerManagedOption(argument) {
  if (argument.startsWith('--')) {
    return RUNNER_MANAGED_LONG_OPTIONS.has(argument.split('=', 1)[0]);
  }
  return argument.length >= 2
    && RUNNER_MANAGED_SHORT_OPTIONS.has(argument.slice(0, 2));
}

export function validateRunnerConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('runner config must be an object');
  }
  const launchCommand = config.launchCommand;
  if (
    !Array.isArray(launchCommand)
    || launchCommand.length === 0
    || launchCommand.some((part) => typeof part !== 'string' || !part)
  ) {
    throw new Error('launchCommand must be a non-empty string array');
  }
  if (launchCommand.some(isRunnerManagedOption)) {
    throw new Error(
      'launchCommand must not override runner-managed launch options',
    );
  }
  const pollIntervalSeconds = Number(config.pollIntervalSeconds ?? 300);
  if (!Number.isFinite(pollIntervalSeconds) || pollIntervalSeconds < 1) {
    throw new Error('pollIntervalSeconds must be at least 1');
  }
  if (!String(config.machine || '').trim()) throw new Error('machine is required');
  return {
    ...config,
    backendConfig: assertAbsolute(config.backendConfig, 'backendConfig'),
    stateRoot: assertAbsolute(config.stateRoot, 'stateRoot'),
    workingDirectory: config.workingDirectory
      ? assertAbsolute(config.workingDirectory, 'workingDirectory')
      : '',
    pollIntervalSeconds,
    machine: String(config.machine).trim(),
    launchCommand: [...launchCommand],
  };
}

export async function loadConfig(configPath, dependencies = {}) {
  const absolute = path.resolve(configPath);
  const text = dependencies.readFile
    ? await dependencies.readFile(absolute, 'utf8')
    : await readFile(absolute, 'utf8');
  return validateRunnerConfig(JSON.parse(text));
}

function taskDirectory(stateRoot, taskId) {
  return path.join(stateRoot, 'tasks', encodeURIComponent(taskId));
}

function taskLabel(task) {
  const reference = Number.isInteger(task.number) ? `#${task.number}` : task.id;
  return `${reference} ${JSON.stringify(task.title)}`;
}

function workerWindowTitle(task) {
  return `Pan worker ${taskLabel(task)}`.replaceAll(/[\r\n]/g, ' ').slice(0, 120);
}

function defaultRunnerLog(message) {
  process.stdout.write(`[${new Date().toISOString()}] ${message}\n`);
}

export function waitForPollTrigger(
  timeoutMs,
  {
    input = process.stdin,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  } = {},
) {
  return new Promise((resolve) => {
    let timer;
    const finish = (trigger) => {
      if (timer !== undefined) clearTimer(timer);
      input?.removeListener?.('data', onData);
      resolve(trigger);
    };
    const onData = () => finish('manual');
    input?.once?.('data', onData);
    timer = setTimer(() => finish('timer'), timeoutMs);
  });
}

async function readOptionalJson(filename) {
  try {
    return JSON.parse(await readFile(filename, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function atomicWriteJson(filename, value) {
  const pending = `${filename}.${randomUUID()}.next`;
  await writeFile(pending, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
  await rename(pending, filename);
}

async function fileExists(filename) {
  try {
    await stat(filename);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

export function selectRequestedTasks(tasks) {
  return tasks.filter((task) => task.agentStatus === 'requested');
}

export function resolveRequestedPlaybook(assignment, loadedDomain, config) {
  const requestedName = String(assignment || '').trim();
  const assigned = requestedName
    ? loadedDomain.playbooks.get(requestedName)
    : null;
  const source = assigned
    ? 'assigned'
    : requestedName
      ? 'missing-default'
      : 'default';
  const playbook = assigned || loadedDomain.defaultPlaybook;
  try {
    resolvePlaybookWorkingDirectory(playbook, config);
    return {
      available: true,
      playbook,
      requestedName,
      source,
    };
  } catch (error) {
    return {
      available: false,
      requestedName,
      reason: error.message,
      source,
    };
  }
}

function configuredPlaybookAlternatives(loadedDomain, config) {
  return [...loadedDomain.playbooks.keys()]
    .sort()
    .map((name) => resolveRequestedPlaybook(name, loadedDomain, config))
    .filter((resolved) => resolved.available)
    .map((resolved) => ({
      description: resolved.playbook.description,
      name: resolved.playbook.name,
      workingDirectory: resolvePlaybookWorkingDirectory(resolved.playbook, config),
    }));
}

function domainSourceDescription(config, domainRevision) {
  if (config.domainPath) {
    return [
      `Domain source: local path ${config.domainPath}`,
      `Domain revision: ${domainRevision}`,
    ];
  }
  return [
    `Domain source: ${config.domainRepo}`,
    `Pinned Domain revision: ${config.domainRevision}`,
    `Loaded Domain instructions revision: ${domainRevision}`,
  ];
}

export function missingPlaybookRepairInstructions({
  requestedName,
  loadedDomain,
  config,
}) {
  const alternatives = configuredPlaybookAlternatives(loadedDomain, config);
  const configured = [
    `- Clear the assignment to use the general default (configured launch directory: ${resolvePlaybookWorkingDirectory(loadedDomain.defaultPlaybook, config)}): ${loadedDomain.defaultPlaybook.description}`,
    ...(alternatives.length
      ? alternatives.map(({ name, description, workingDirectory }) =>
          `- ${name} (configured launch directory: ${workingDirectory}): ${description}`)
      : ['- No named playbook definitions in this runner profile have a valid configured launch directory.']),
  ].join('\n');
  return [
    '# Requested playbook unavailable on this runner',
    '',
    `The task still requests the named playbook ${JSON.stringify(requestedName)}.`,
    'That name is absent from this configured runner. This does not prove the playbook is absent from other machines or Domain revisions.',
    ...domainSourceDescription(config, loadedDomain.domainRevision),
    '',
    'Configured playbook definitions in this runner profile:',
    configured,
    '',
    'These entries report profile configuration, not runtime readiness. If the user chooses one, verify any required checkout, dependencies, tools, or access before dependent work.',
    '',
    'Before doing work that depends on the missing specialist instructions:',
    `1. Tell the user that ${JSON.stringify(requestedName)} is unavailable on this runner.`,
    '2. Make this repair conversation the first task interaction. Ask whether to clear or correct the assignment to one of the configured alternatives, or help create the requested playbook through the normal Domain workflow.',
    `3. Set nextStep to a brief waiting state such as "Choose playbook: ${requestedName} unavailable on this runner".`,
    '4. Wait in this open session for the user choice.',
    '',
    'Do not rewrite the task playbook, guess a mapping, create a playbook, reopen or complete the task, or begin specialist-dependent work before the user decides. After approval, use the normal task API and Domain guidance for the selected correction or creation.',
  ].join('\n');
}

export async function inspectManagedRuns(stateRoot) {
  const root = path.join(stateRoot, 'tasks');
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const runs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    const run = await readOptionalJson(path.join(dir, RUN_FILE));
    if (!run) continue;
    if (
      run.version !== 1
      || typeof run.taskId !== 'string'
      || typeof run.sessionId !== 'string'
      || !Number.isInteger(run.pid)
      || run.pid < 1
    ) {
      throw new Error(`invalid managed run record: ${path.join(dir, RUN_FILE)}`);
    }
    runs.push({ ...run, dir });
  }
  return runs;
}

export function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    if (error.code === 'EPERM') return true;
    throw error;
  }
}

export async function acquireRunnerLock(stateRoot, dependencies = {}) {
  await mkdir(stateRoot, { recursive: true });
  const lockPath = path.join(stateRoot, RUNNER_LOCK_FILE);
  const inspectProcess = dependencies.processIsAlive ?? processIsAlive;
  const openFile = dependencies.open ?? open;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await openFile(lockPath, 'wx', 0o600);
      try {
        await handle.writeFile(`${JSON.stringify({ pid: process.pid })}\n`, 'utf8');
      } catch (error) {
        await handle.close();
        await rm(lockPath, { force: true });
        throw error;
      }
      return async () => {
        await handle.close();
        await rm(lockPath, { force: true });
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const existing = await readOptionalJson(lockPath);
      if (Number.isInteger(existing?.pid) && inspectProcess(existing.pid)) {
        throw new Error(
          `another runner is already active for this state root (pid ${existing.pid})`,
        );
      }
      await rm(lockPath, { force: true });
    }
  }
  throw new Error(`could not acquire runner lock: ${lockPath}`);
}

async function waitForExit(pid, inspectProcess, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (inspectProcess(pid)) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return true;
}

async function defaultStopProcess(pid, dependencies) {
  process.kill(pid, 'SIGTERM');
  if (!await waitForExit(pid, dependencies.processIsAlive ?? processIsAlive)) {
    throw new Error(`managed process ${pid} did not close after release`);
  }
}

async function defaultLaunchProcess(
  { command, cwd, env, prompt, sessionId, terminalTitle },
  dependencies = {},
) {
  const args = [
    ...command.slice(1),
    '--allow-all-paths',
    '--add-dir',
    cwd,
    '--session-id',
    sessionId,
    '--interactive',
    prompt,
  ];
  const platform = dependencies.platform ?? process.platform;
  if (platform === 'win32') {
    const launch = dependencies.spawn ?? spawn;
    const terminal = launch('wt.exe', [
      '-w',
      'new',
      'nt',
      '--title',
      terminalTitle,
      '-d',
      cwd,
      command[0],
      ...args,
    ], {
      cwd,
      env,
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    });
    await new Promise((resolve, reject) => {
      terminal.once('error', reject);
      terminal.once('spawn', resolve);
    });
    terminal.unref();
    const pid = await findWindowsWorkerPid(sessionId, dependencies);
    return {
      pid,
      processStart: new Date().toISOString(),
      command: [command[0], ...args],
    };
  }
  return new Promise((resolve, reject) => {
    const launch = dependencies.spawn ?? spawn;
    const child = launch(command[0], args, {
      cwd,
      env,
      detached: true,
      stdio: 'inherit',
      windowsHide: false,
    });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve({
        pid: child.pid,
        processStart: new Date().toISOString(),
        command: [command[0], ...args],
      });
    });
  });
}

async function findWindowsWorkerPid(sessionId, dependencies = {}) {
  const run = dependencies.execFile ?? execFileAsync;
  const inspectDelay = dependencies.inspectDelay
    ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const script = [
    '$sessionId = $env:PAN_WORKER_SESSION_ID',
    '$process = Get-CimInstance Win32_Process |',
    "  Where-Object { $_.CommandLine -and $_.CommandLine.Contains('--session-id') -and $_.CommandLine.Contains($sessionId) } |",
    '  Sort-Object CreationDate -Descending |',
    '  Select-Object -First 1',
    'if ($process) { [Console]::Out.Write($process.ProcessId) }',
  ].join('\n');
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const { stdout } = await run('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      script,
    ], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PAN_WORKER_SESSION_ID: sessionId,
      },
      windowsHide: true,
    });
    const pid = Number.parseInt(String(stdout).trim(), 10);
    if (Number.isInteger(pid) && pid > 0) return pid;
    await inspectDelay(100);
  }
  throw new Error(`worker window opened but session process was not found: ${sessionId}`);
}

async function clearClosedRun(run, task, backend) {
  if (task.agentStatus !== '') {
    await backend.update(task.id, { agentStatus: '' });
  }
  await rm(run.dir, { recursive: true, force: true });
}

export async function reconcileManagedRuns({
  backend,
  stateRoot,
  dependencies = {},
}) {
  const log = dependencies.log ?? (() => {});
  const inspectProcess = dependencies.processIsAlive ?? processIsAlive;
  const stopProcess = dependencies.stopProcess
    ?? ((pid) => defaultStopProcess(pid, { processIsAlive: inspectProcess }));
  const runs = await inspectManagedRuns(stateRoot);
  const live = [];
  const closed = [];
  for (const run of runs) {
    const task = await backend.get(run.taskId);
    if (!inspectProcess(run.pid)) {
      log(`worker exited: ${taskLabel(task)} (pid ${run.pid})`);
      await clearClosedRun(run, task, backend);
      closed.push(run.taskId);
      continue;
    }
    const released = await fileExists(path.join(run.dir, RELEASE_FILE));
    if (released) {
      log(`closing released worker: ${taskLabel(task)} (pid ${run.pid})`);
      await stopProcess(run.pid, run);
      if (inspectProcess(run.pid)) {
        throw new Error(`managed process ${run.pid} is still running after release`);
      }
      await clearClosedRun(run, task, backend);
      closed.push(run.taskId);
      continue;
    }
    if (task.agentStatus !== 'running') {
      log(`restoring running status: ${taskLabel(task)} (pid ${run.pid})`);
      await backend.update(task.id, { agentStatus: 'running' });
    }
    live.push(run);
  }
  return { live, closed };
}

function launchPrompt(task, files) {
  return [
    `Work on Pan task ${task.id}: ${task.title}`,
    `Read the task snapshot at ${files.task}, the playbook at ${files.playbook},`,
    `the Domain instructions at ${files.domain}, and comments at ${files.comments}.`,
    `Read workstream guidance at ${files.workstream} when that snapshot is non-empty.`,
    'Use task comments for progress and business decisions.',
    'Exit normally when the requested work is complete.',
    `Create an empty ${files.release} file only when the playbook or user explicitly directs an early close.`,
    'Changing the task work status does not close this session.',
  ].join('\n');
}

export async function launchTask({
  task,
  backend,
  config,
  playbook,
  domainInstructions,
  domainRevision,
  workstreamInstructions = '',
  playbookText = playbook.text,
  missingRequestedPlaybook = '',
  dependencies = {},
}) {
  let current = task;
  const sessionId = current.sessionId || randomUUID();
  if (!current.sessionId) {
    current = await backend.update(current.id, { sessionId });
  }
  const dir = taskDirectory(config.stateRoot, current.id);
  await mkdir(dir, { recursive: true });
  const files = {
    task: path.join(dir, 'task.json'),
    playbook: path.join(dir, 'playbook.md'),
    domain: path.join(dir, 'pan.md'),
    comments: path.join(dir, 'comments.json'),
    workstream: path.join(dir, 'workstream.md'),
    release: path.join(dir, RELEASE_FILE),
  };
  const comments = await backend.comments(current.id);
  await atomicWriteJson(files.task, current);
  await atomicWriteJson(files.comments, comments);
  await writeFile(files.playbook, playbookText, { encoding: 'utf8', mode: 0o600 });
  await writeFile(files.domain, domainInstructions, { encoding: 'utf8', mode: 0o600 });
  await writeFile(files.workstream, workstreamInstructions, {
    encoding: 'utf8',
    mode: 0o600,
  });
  const cwd = resolvePlaybookWorkingDirectory(playbook, config);
  const log = dependencies.log ?? (() => {});
  const launch = dependencies.launchProcess
    ?? ((options) => defaultLaunchProcess(options, dependencies));
  log(`opening worker window: ${taskLabel(current)} (session ${sessionId})`);
  const started = await launch({
    command: config.launchCommand,
    cwd,
    env: {
      ...process.env,
      PAN_SYSTEM_DIR: SYSTEM_DIR,
      PAN_STATE_DIR: dir,
      PAN_TASK_BACKEND_CONFIG: config.backendConfig,
      PAN_TASK_ID: current.id,
      PAN_SESSION_ID: sessionId,
    },
    prompt: [
      launchPrompt(current, files),
      ...(missingRequestedPlaybook
        ? [
            '',
            `The task's requested playbook ${JSON.stringify(missingRequestedPlaybook)} is unavailable on this configured runner.`,
            'Follow the repair instructions at the start of the playbook snapshot before specialist-dependent work.',
          ]
        : []),
    ].join('\n'),
    sessionId,
    terminalTitle: workerWindowTitle(current),
  });
  if (!Number.isInteger(started?.pid) || started.pid < 1) {
    throw new Error('launcher did not return a process id');
  }
  const run = {
    version: 1,
    taskId: current.id,
    sessionId,
    pid: started.pid,
    processStart: String(started.processStart || ''),
    playbook: playbook.name,
    workingDirectory: cwd,
    domainRevision,
    startedAt: new Date().toISOString(),
  };
  await atomicWriteJson(path.join(dir, RUN_FILE), run);
  await backend.update(current.id, { agentStatus: 'running' });
  log(`worker running: ${taskLabel(current)} (pid ${started.pid})`);
  return { ...run, dir };
}

export async function pollRunner({
  backend,
  config,
  loadedDomain,
  dryRun = false,
  dependencies = {},
}) {
  const log = dependencies.log ?? (() => {});
  await mkdir(config.stateRoot, { recursive: true });
  const reconciled = await reconcileManagedRuns({
    backend,
    stateRoot: config.stateRoot,
    dependencies,
  });
  const tasks = await backend.list();
  const liveTaskIds = new Set(reconciled.live.map((run) => run.taskId));
  const requested = selectRequestedTasks(tasks);
  const launched = [];
  const skipped = [];
  for (const task of requested) {
    if (liveTaskIds.has(task.id)) continue;
    const resolved = resolveRequestedPlaybook(task.playbook, loadedDomain, config);
    if (!resolved.available) {
      log(`skipping ${taskLabel(task)}: ${resolved.reason}`);
      skipped.push({ id: task.id, reason: resolved.reason });
      continue;
    }
    if (!dryRun) {
      let workstreamInstructions = '';
      if (resolved.source !== 'assigned' && task.workstream) {
        try {
          workstreamInstructions = (
            await loadBackendWorkstream(config, task.workstream, dependencies)
          ).text;
        } catch (error) {
          log(`skipping ${taskLabel(task)}: ${error.message}`);
          skipped.push({ id: task.id, reason: error.message });
          continue;
        }
      }
      const missingRequestedPlaybook = resolved.source === 'missing-default'
        ? resolved.requestedName
        : '';
      const playbookText = missingRequestedPlaybook
        ? `${missingPlaybookRepairInstructions({
            requestedName: missingRequestedPlaybook,
            loadedDomain,
            config,
          })}\n\n---\n\n${resolved.playbook.text}`
        : resolved.playbook.text;
      const run = await launchTask({
        task,
        backend,
        config,
        playbook: resolved.playbook,
        domainInstructions: loadedDomain.domainInstructions,
        domainRevision: loadedDomain.domainRevision,
        workstreamInstructions,
        playbookText,
        missingRequestedPlaybook,
        dependencies,
      });
      launched.push(run.taskId);
      liveTaskIds.add(run.taskId);
    }
  }
  return {
    observed: tasks.length,
    requested: requested.map((task) => task.id),
    live: reconciled.live.map((run) => run.taskId),
    closed: reconciled.closed,
    launched,
    skipped,
  };
}

export async function runRunner(argv, dependencies = {}) {
  const { values } = parseArgs({
    args: argv,
    options: {
      config: { type: 'string' },
      once: { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
  });
  if (values.help) {
    return {
      help: [
        'Usage: pan-runner --config <runner.json> [--once] [--dry-run]',
        'The runner opens or resumes tasks whose agentStatus is requested.',
      ].join('\n'),
    };
  }
  if (!values.config) throw new Error('--config is required');
  const config = await loadConfig(values.config, dependencies);
  const releaseRunnerLock = await acquireRunnerLock(config.stateRoot, dependencies);
  try {
    const log = dependencies.log ?? defaultRunnerLog;
    const runnerDependencies = { ...dependencies, log };
    log(
      `runner started: machine=${config.machine} stateRoot=${config.stateRoot} `
      + `poll=${config.pollIntervalSeconds}s`,
    );
    log('press Enter to poll now');
    const backend = dependencies.backend
      ?? await loadTaskBackend(config.backendConfig, dependencies);
    if (typeof backend.initialize === 'function') await backend.initialize();
    const loadDomain = dependencies.loadBackendPlaybooks ?? loadBackendPlaybooks;
    const poll = async () => {
      log('polling task backend');
      const loadedDomain = await loadDomain(config, dependencies);
      const result = await pollRunner({
        backend,
        config,
        loadedDomain,
        dryRun: values['dry-run'] === true,
        dependencies: runnerDependencies,
      });
      log(
        `poll complete: observed=${result.observed} requested=${result.requested.length} `
        + `live=${result.live.length + result.launched.length} launched=${result.launched.length} `
        + `closed=${result.closed.length} skipped=${result.skipped.length}`,
      );
      return result;
    };
    const now = dependencies.now ?? Date.now;
    let pollStartedAt = now();
    const first = await poll();
    if (values.once || values['dry-run']) return first;
    for (;;) {
      const nextPollAt = pollStartedAt + config.pollIntervalSeconds * 1000;
      const waitMs = Math.max(0, nextPollAt - now());
      log(`waiting for next poll at ${new Date(nextPollAt).toISOString()}`);
      const wait = dependencies.waitForPollTrigger
        ?? ((milliseconds) => waitForPollTrigger(milliseconds, dependencies));
      const trigger = await wait(waitMs);
      if (trigger === 'manual') log('manual poll requested');
      pollStartedAt = now();
      await poll();
    }
  } finally {
    await releaseRunnerLock();
  }
}

if (isCliEntry(import.meta.url)) {
  runRunner(process.argv.slice(2))
    .then((result) => {
      if (result?.help) process.stdout.write(`${result.help}\n`);
      else writeJson({ ok: true, result });
    })
    .catch((error) => {
      writeJson({
        ok: false,
        error: {
          code: error.code || 'runner-error',
          message: error.message,
          details: error.details ?? null,
        },
      }, process.stderr);
      process.exitCode = 1;
    });
}
