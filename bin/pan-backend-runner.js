#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { isCliEntry, loadTaskBackend, writeJson } from './pan-task-backend.js';
import {
  loadBackendPlaybooks,
  loadBackendWorkstream,
  resolvePlaybookWorkingDirectory,
} from './pan-backend-playbooks.js';

const RELEASE_FILE = 'worker-release.json';
const RUN_FILE = 'run.json';
const SYSTEM_DIR = fileURLToPath(new URL('../system', import.meta.url));
const RUNNER_MANAGED_LONG_OPTIONS = new Set([
  '--session-id',
  '--resume',
  '--continue',
  '--prompt',
  '--interactive',
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
      'launchCommand must not override the runner-managed session or prompt',
    );
  }
  const pollIntervalSeconds = Number(config.pollIntervalSeconds ?? 10);
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
  { command, cwd, env, prompt, sessionId },
  dependencies = {},
) {
  const args = [
    ...command.slice(1),
    '--session-id',
    sessionId,
    '--interactive',
    prompt,
  ];
  return new Promise((resolve, reject) => {
    const launch = dependencies.spawn ?? spawn;
    const child = launch(command[0], args, {
      cwd,
      env,
      detached: true,
      stdio: 'ignore',
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
  const inspectProcess = dependencies.processIsAlive ?? processIsAlive;
  const stopProcess = dependencies.stopProcess
    ?? ((pid) => defaultStopProcess(pid, { processIsAlive: inspectProcess }));
  const runs = await inspectManagedRuns(stateRoot);
  const live = [];
  const closed = [];
  for (const run of runs) {
    const task = await backend.get(run.taskId);
    if (!inspectProcess(run.pid)) {
      await clearClosedRun(run, task, backend);
      closed.push(run.taskId);
      continue;
    }
    const released = await fileExists(path.join(run.dir, RELEASE_FILE));
    if (released) {
      await stopProcess(run.pid, run);
      if (inspectProcess(run.pid)) {
        throw new Error(`managed process ${run.pid} is still running after release`);
      }
      await clearClosedRun(run, task, backend);
      closed.push(run.taskId);
      continue;
    }
    if (task.agentStatus !== 'running') {
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
  const launch = dependencies.launchProcess
    ?? ((options) => defaultLaunchProcess(options, dependencies));
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
  return { ...run, dir };
}

export async function pollRunner({
  backend,
  config,
  loadedDomain,
  dryRun = false,
  dependencies = {},
}) {
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
  const backend = dependencies.backend
    ?? await loadTaskBackend(config.backendConfig, dependencies);
  if (typeof backend.initialize === 'function') await backend.initialize();
  const loadDomain = dependencies.loadBackendPlaybooks ?? loadBackendPlaybooks;
  const poll = async () => {
    const loadedDomain = await loadDomain(config, dependencies);
    return pollRunner({
      backend,
      config,
      loadedDomain,
      dryRun: values['dry-run'] === true,
      dependencies,
    });
  };
  const first = await poll();
  if (values.once || values['dry-run']) return first;
  for (;;) {
    await new Promise((resolve) =>
      setTimeout(resolve, config.pollIntervalSeconds * 1000));
    await poll();
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
