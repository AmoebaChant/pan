#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  mkdir,
  open,
  readFile,
  realpath,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { inspectProcess } from './pan-runner-runtime.js';
import { isCliEntry, loadTaskBackend, writeJson } from './pan-task-backend.js';
import {
  loadBackendPlaybooks,
  resolvePlaybookWorkspace,
} from './pan-backend-playbooks.js';

const RUN_VERSION = 1;
const RELEASE_SIGNAL = 'worker-release.json';
const RELEASE_RECEIPT = 'worker-release-consumed.json';
const RELEASE_TERMINATION = 'worker-release-termination.json';
const UNEXPECTED_EXIT_RECEIPT = 'unexpected-exit-observed.json';
const LAUNCH_FAILURE_RECEIPT = 'launch-failure.json';
const AWAITING_ANSWER = 'awaiting-answer.json';
const AWAITING_RECEIPT = 'awaiting-answer-projected.json';
const RUNNING_REQUEST_RECEIPT = 'attention-request-running.json';
const TASK_SESSION = 'task-session.json';
const WORKSPACE_CONTINUATION = 'workspace-continuation.json';
const CHILD_HANDSHAKE = 'child.json';
const ATTENTION_MODE = 'attention-labels-v1';
const PAN_CHECKOUT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

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

export function selectAttentionRequested(tasks, machine) {
  return tasks.filter((task) =>
    task.lifecycleMode === ATTENTION_MODE
    && task.attentionState === 'requested'
    && !task.recurring
    && (!task.machineId || task.machineId === machine),
  );
}

export function attentionRecoverySkips(inventory) {
  return (inventory.uncertain ?? []).map((run) => ({
    id: run.taskId || null,
    sessionId: run.sessionId || null,
    reason: `recovery required: ${run.reason || 'uncertain local launch state'}`,
  }));
}

export async function planBackendTasks({
  tasks,
  inventory,
  config,
  playbooks,
}) {
  const allowedTaskIds = new Set((config.taskIds ?? []).map(String));
  const candidates = selectReadyForAi(tasks).filter((task) =>
    !inventory.live.some((run) => run.taskId === task.id)
    && (allowedTaskIds.size === 0 || allowedTaskIds.has(String(task.id))),
  );
  const occupiedRuns = [
    ...inventory.live,
    ...inventory.uncertain,
    ...(inventory.unexpected ?? []),
    ...inventory.stale,
  ];
  const globalRemaining = Math.max(
    0,
    Number(config.maxConcurrent ?? 1) - occupiedRuns.length,
  );
  const playbookCounts = new Map();
  const busyPaths = new Set();
  const occupiedSlots = new Map();
  for (const run of occupiedRuns) {
    if (run.workingDirectory) busyPaths.add(path.resolve(run.workingDirectory));
    if (run.playbookName) {
      playbookCounts.set(run.playbookName, (playbookCounts.get(run.playbookName) || 0) + 1);
      if (run.workspaceSlot) {
        const slots = occupiedSlots.get(run.playbookName) || new Set();
        slots.add(run.workspaceSlot);
        occupiedSlots.set(run.playbookName, slots);
      }
    }
  }
  const plans = [];
  const skipped = [];
  for (const task of candidates) {
    if (plans.length >= globalRemaining) {
      skipped.push({ id: task.id, reason: 'global capacity is full' });
      continue;
    }
    const playbook = playbooks.get(task.playbook);
    if (!playbook) {
      skipped.push({ id: task.id, reason: `playbook ${JSON.stringify(task.playbook)} is missing` });
      continue;
    }
    const count = (playbookCounts.get(playbook.name) || 0)
      + plans.filter((plan) => plan.playbook.name === playbook.name).length;
    if (playbook.capacity === 0) {
      skipped.push({ id: task.id, reason: `playbook ${playbook.name} is disabled` });
      continue;
    }
    if (count >= playbook.capacity) {
      skipped.push({ id: task.id, reason: `playbook ${playbook.name} capacity is full` });
      continue;
    }
    const workspace = resolvePlaybookWorkspace(playbook, task.id, {
      workspaceRoot: config.workspaceRoot,
      occupiedSlots,
    });
    if (!workspace) {
      skipped.push({ id: task.id, reason: `playbook ${playbook.name} has no available workspace` });
      continue;
    }
    if (busyPaths.has(workspace.workingDirectory)
      || plans.some((plan) => plan.workingDirectory === workspace.workingDirectory)) {
      skipped.push({ id: task.id, reason: `workspace ${workspace.workingDirectory} is busy` });
      continue;
    }
    plans.push({ task, playbook, ...workspace });
  }
  return { candidates, plans, skipped };
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

async function readOptionalJson(filename) {
  try {
    return await readJson(filename);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function inspectReleaseSignal(dir) {
  try {
    const contents = await readFile(path.join(dir, RELEASE_SIGNAL));
    if (contents.length !== 0) {
      throw new Error(`${RELEASE_SIGNAL} must be empty`);
    }
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function validateReceipt(receipt, run, kind) {
  if (
    receipt?.version !== 1
    || receipt.kind !== kind
    || receipt.taskId !== run.taskId
    || receipt.sessionId !== run.sessionId
    || typeof receipt.recordedAt !== 'string'
  ) {
    throw new Error(`invalid ${kind} receipt`);
  }
}

async function writeReceipt(filename, receipt) {
  try {
    await writeFile(filename, `${JSON.stringify(receipt, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const persisted = await readJson(filename);
  validateReceipt(persisted, receipt, receipt.kind);
  return persisted;
}

function validateAttentionReceipt(receipt, run) {
  if (
    receipt?.version !== 1
    || receipt.taskId !== run.taskId
    || receipt.sessionId !== run.sessionId
    || typeof receipt.checkpointId !== 'string'
    || !receipt.checkpointId
    || typeof receipt.projectedAt !== 'string'
    || !Number.isFinite(Date.parse(receipt.projectedAt))
  ) {
    throw new Error('invalid awaiting-answer projection receipt');
  }
}

async function writeAttentionReceipt(filename, receipt, run) {
  const existing = await readOptionalJson(filename);
  if (existing) {
    validateAttentionReceipt(existing, run);
    if (existing.checkpointId === receipt.checkpointId) return existing;
    await writeFile(filename, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  } else {
    await writeFile(filename, `${JSON.stringify(receipt, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
  }
  const persisted = await readJson(filename);
  validateAttentionReceipt(persisted, run);
  return persisted;
}

function validateTerminationJournal(journal, run) {
  if (
    journal?.version !== 1
    || journal.kind !== 'release-termination'
    || journal.taskId !== run.taskId
    || journal.sessionId !== run.sessionId
    || journal.owner?.pid !== run.owner?.pid
    || journal.owner?.processStart !== run.owner?.processStart
    || !Array.isArray(journal.descendants)
    || journal.descendants.some((entry) =>
      !Number.isInteger(entry?.pid)
      || entry.pid <= 0
      || typeof entry.processStart !== 'string'
      || !entry.processStart)
  ) {
    throw new Error('invalid release-termination journal');
  }
}

async function writeTerminationJournal(run, captured) {
  const filename = path.join(run.dir, RELEASE_TERMINATION);
  let journal = {
    version: 1,
    kind: 'release-termination',
    taskId: run.taskId,
    sessionId: run.sessionId,
    owner: captured.owner,
    descendants: captured.descendants,
    recordedAt: new Date().toISOString(),
  };
  try {
    await writeFile(filename, `${JSON.stringify(journal, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const persisted = await readJson(filename);
  validateTerminationJournal(persisted, run);
  const descendants = new Map(
    [...persisted.descendants, ...captured.descendants]
      .map((entry) => [`${entry.pid}:${entry.processStart}`, entry]),
  );
  if (descendants.size !== persisted.descendants.length) {
    journal = {
      ...persisted,
      descendants: [...descendants.values()],
      updatedAt: new Date().toISOString(),
    };
    await writeFile(filename, `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600 });
  } else {
    journal = persisted;
  }
  validateTerminationJournal(journal, run);
  return journal;
}

async function requireTerminationComplete(run, inspect) {
  const journal = await readOptionalJson(path.join(run.dir, RELEASE_TERMINATION));
  const owner = await inspect(run.owner.pid);
  if (owner.state === 'unknown') {
    throw new Error(`release termination PID ${run.owner.pid} identity is uncertain`);
  }
  if (owner.state === 'live' && owner.identity === run.owner.processStart) {
    throw new Error(`release termination PID ${run.owner.pid} is still live`);
  }
  if (!journal) {
    if (owner.state === 'live') {
      throw new Error('worker owner PID was replaced without verified termination evidence');
    }
    return;
  }
  validateTerminationJournal(journal, run);
  for (const processRecord of journal.descendants) {
    const observed = await inspect(processRecord.pid);
    if (observed.state === 'unknown') {
      throw new Error(`release termination PID ${processRecord.pid} identity is uncertain`);
    }
    if (observed.state === 'live' && observed.identity === processRecord.processStart) {
      throw new Error(`release termination PID ${processRecord.pid} is still live`);
    }
  }
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
    if (error.code === 'ENOENT') entries = [];
    else throw error;
  }
  const result = {
    live: [], stale: [], uncertain: [], released: [], unexpected: [], failed: [],
    recoverable: [], orphanLocks: [],
  };
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
    try {
      const releaseReceipt = await readOptionalJson(path.join(dir, RELEASE_RECEIPT));
      if (releaseReceipt) {
        validateReceipt(releaseReceipt, run, 'released');
        result.released.push({ ...run, dir, receipt: releaseReceipt });
        continue;
      }
      const unexpectedReceipt = await readOptionalJson(
        path.join(dir, UNEXPECTED_EXIT_RECEIPT),
      );
      if (unexpectedReceipt) {
        validateReceipt(unexpectedReceipt, run, 'unexpected-stop');
        result.unexpected.push({ ...run, dir, receipt: unexpectedReceipt });
        continue;
      }
      const launchFailure = await readOptionalJson(path.join(dir, LAUNCH_FAILURE_RECEIPT));
      if (launchFailure) {
        validateReceipt(launchFailure, run, 'launch-failure');
        result.failed.push({ ...run, dir, receipt: launchFailure });
        continue;
      }
    } catch (error) {
      result.uncertain.push({ ...run, dir, reason: error.message });
      continue;
    }
    let releaseRequested;
    try {
      releaseRequested = await inspectReleaseSignal(dir);
    } catch (error) {
      result.uncertain.push({ ...run, dir, reason: error.message });
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
            releaseRequested,
            observed: { state: 'dead', identity: null },
          });
          continue;
        } catch (exitError) {
          if (run.lifecycleMode === ATTENTION_MODE && run.runnerOwner) {
            const runnerObserved = await inspect(run.runnerOwner.pid);
            const runnerDead = runnerObserved.state === 'dead'
              || (
                runnerObserved.state === 'live'
                && runnerObserved.identity !== run.runnerOwner.processStart
              );
            if (runnerDead && ['prepared', 'associated'].includes(run.phase)) {
              result.recoverable.push({
                ...run,
                dir,
                owner: null,
                observed: runnerObserved,
                reason: `runner died during ${run.phase} launch phase before terminal request`,
              });
              continue;
            }
            result.uncertain.push({
              ...run,
              dir,
              reason: `launch phase ${run.phase || 'unknown'} has no owner/exit; runner identity is ${runnerObserved.state}`,
            });
            continue;
          }
          result.uncertain.push({ ...run, dir, reason: exitError.message });
          continue;
        }
      }
      result.uncertain.push({ ...run, dir, reason: error.message });
      continue;
    }
    const observed = await inspect(owner.pid);
    const record = { ...run, dir, owner, observed, releaseRequested };
    if (observed.state === 'live' && observed.identity === owner.processStart) {
      if (run.lifecycleMode === ATTENTION_MODE) {
        try {
          const child = await readJson(path.join(dir, CHILD_HANDSHAKE));
          if (
            !Number.isInteger(child.pid)
            || !child.processStart
            || child.sessionId !== run.sessionId
          ) {
            throw new Error('invalid worker child handshake');
          }
          const childObserved = await inspect(child.pid);
          if (childObserved.state !== 'live' || childObserved.identity !== child.processStart) {
            throw new Error('worker child handshake is not live');
          }
          result.live.push({ ...record, child, childObserved });
        } catch (error) {
          result.uncertain.push({
            ...record,
            reason: error.code === 'ENOENT'
              ? 'launcher is live but worker child handshake is missing'
              : error.message,
          });
        }
        continue;
      }
      result.live.push(record);
    } else if (observed.state === 'dead' || observed.identity !== owner.processStart) {
      result.stale.push(record);
    } else {
      result.uncertain.push(record);
    }
  }
  const runTaskIds = new Set([
    ...result.live,
    ...result.stale,
    ...result.uncertain,
    ...result.released,
    ...result.unexpected,
    ...result.failed,
    ...result.recoverable,
  ].map((run) => run.taskId).filter(Boolean));
  let lockEntries = [];
  try {
    lockEntries = await readdir(path.join(stateRoot, 'locks'), { withFileTypes: true });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  for (const entry of lockEntries.filter((candidate) =>
    candidate.isFile() && candidate.name.endsWith('.lock'))) {
    const taskId = decodeURIComponent(entry.name.slice(0, -'.lock'.length));
    if (runTaskIds.has(taskId)) continue;
    const filename = path.join(stateRoot, 'locks', entry.name);
    try {
      const owner = await readJson(filename);
      if (
        owner.version !== 1
        || !Number.isInteger(owner.pid)
        || !owner.processStart
      ) {
        throw new Error('invalid orphan task-lock owner');
      }
      const observed = await inspect(owner.pid);
      const originalDead = observed.state === 'dead'
        || (observed.state === 'live' && observed.identity !== owner.processStart);
      const record = { taskId, filename, owner, observed };
      if (originalDead) result.orphanLocks.push(record);
      else result.uncertain.push({
        ...record,
        reason: `orphan task lock owner is ${observed.state}`,
      });
    } catch (error) {
      result.uncertain.push({ taskId, filename, reason: error.message });
    }
  }
  return result;
}

export async function reconcileRecoverableLaunches(stateRoot, inventory, backend) {
  const result = { reconciled: [], failures: [] };
  for (const lock of inventory.orphanLocks ?? []) {
    try {
      await rm(lock.filename, { force: true });
      result.reconciled.push(lock.taskId);
    } catch (error) {
      result.failures.push({ taskId: lock.taskId, error: error.message });
    }
  }
  for (const run of inventory.recoverable ?? []) {
    try {
      const task = await backend.get(run.taskId);
      if (task.lifecycleMode !== ATTENTION_MODE) {
        throw new Error('recoverable prelaunch cleanup is attention-mode only');
      }
      if (
        task.sessionId
        && (task.sessionId !== run.sessionId || task.machineId !== run.machine)
      ) {
        throw new Error('task association changed after interrupted launch');
      }
      if (!['requested', 'needsHelp', 'externalWaiting', 'onHold'].includes(task.attentionState)) {
        throw new Error(`task status ${task.attentionState} is not safe for prelaunch recovery`);
      }
      if (task.sessionId) {
        await backend.report(run.taskId, workerReport(
          task,
          run,
          `Pan runner recovered interrupted launch ${run.sessionId} on ${run.machine}.\n\n`
          + `${run.reason}. No terminal request or worker handshake was recorded. `
          + `Runner owner was PID ${run.runnerOwner.pid} at ${run.runnerOwner.processStart}. `
          + 'The attention request and established session association were preserved.',
        ));
      }
      await writeReceipt(path.join(run.dir, LAUNCH_FAILURE_RECEIPT), {
        version: 1,
        kind: 'launch-failure',
        taskId: run.taskId,
        sessionId: run.sessionId,
        recordedAt: new Date().toISOString(),
        resuming: run.resuming,
        phase: run.phase,
        definitelyNotStarted: true,
      });
      await rm(lockPath(stateRoot, run.taskId), { force: true });
      result.reconciled.push(run.taskId);
    } catch (error) {
      result.failures.push({ taskId: run.taskId, sessionId: run.sessionId, error: error.message });
    }
  }
  return result;
}

function workerMatchesRun(task, run) {
  if (task?.lifecycleMode === ATTENTION_MODE) {
    return task.id === run.taskId
      && task.sessionId === run.sessionId
      && task.machineId === run.machine;
  }

  return (
    task?.id === run.taskId
    && task.worker?.sessionId === run.sessionId
    && Number(task.worker?.pid) === run.owner?.pid
    && task.worker?.processStart === run.owner?.processStart
  );
}

function workerReport(task, run, content) {
  return task.lifecycleMode === ATTENTION_MODE ? {
    content,
    expectedSessionId: run.sessionId,
    expectedMachineId: run.machine,
  } : { content };
}

async function readWorkspaceContinuation(stateRoot, run, config) {
  const request = await readOptionalJson(path.join(run.dir, WORKSPACE_CONTINUATION));
  if (!request) return null;
  if (!config) throw new Error('workspace continuation requires runner config');
  for (const field of [
    'sessionId', 'machineId', 'runCreatedAt', 'playbookName', 'workingDirectory', 'requestedAt',
  ]) {
    if (!String(request[field] || '').trim()) {
      throw new Error(`workspace continuation ${field} is required`);
    }
  }
  if (
    request.version !== 1
    || request.sessionId !== run.sessionId
    || request.machineId !== run.machine
    || request.runCreatedAt !== run.createdAt
    || !Number.isFinite(Date.parse(request.requestedAt))
  ) {
    throw new Error('workspace continuation does not match the current run');
  }
  const target = await resolveAttentionWorkspace(stateRoot, run.taskId, config);
  if (
    request.playbookName !== target.playbookName
    || await canonicalizeProspectivePath(request.workingDirectory) !== target.workingDirectory
  ) {
    throw new Error('workspace continuation does not match task-session target');
  }
  if (!config.attentionPlaybooks?.has(target.playbookName)) {
    throw new Error(`workspace continuation playbook ${target.playbookName} is unavailable`);
  }
  return { request, target };
}

async function updateReleasedTask(task, run, backend, continuation) {
  if (task.lifecycleMode === ATTENTION_MODE) {
    const current = await backend.get(run.taskId);
    if (!workerMatchesRun(current, run)) {
      throw new Error('task association changed before released-state update');
    }
    if (continuation) {
      if (await readOptionalJson(path.join(run.dir, AWAITING_ANSWER))) {
        if (current.attentionState === 'requested') {
          throw new Error(
            'workspace continuation is blocked by an unanswered marker on an already-requested task',
          );
        }
        if (current.attentionState === 'open') {
          await backend.update(run.taskId, {
            expectedRevision: current.revision,
            attentionState: 'needsHelp',
          });
          return { updated: true, continuation: 'blocked-awaiting-answer' };
        }
        return { updated: false, continuation: 'blocked-awaiting-answer' };
      }
      if (current.recurring === true) {
        if (current.attentionState === 'open') {
          await backend.update(run.taskId, {
            expectedRevision: current.revision,
            attentionState: 'none',
          });
          return { updated: true, continuation: 'blocked-recurring' };
        }
        return { updated: false, continuation: 'blocked-recurring' };
      }
      if (current.attentionState === 'open') {
        await backend.update(run.taskId, {
          expectedRevision: current.revision,
          attentionState: 'requested',
        });
        return { updated: true, continuation: 'requested' };
      }
      if (current.attentionState === 'requested') {
        return { updated: false, continuation: 'already-requested' };
      }
      return { updated: false, continuation: `preserved-${current.attentionState}` };
    }
    if (current.attentionState === 'open') {
      await backend.update(run.taskId, {
        expectedRevision: current.revision,
        attentionState: 'none',
      });
      return { updated: true, continuation: null };
    }
    return { updated: false, continuation: null };
  }
  if (task.worker.state !== 'released') {
    await backend.update(run.taskId, {
      expectedRevision: task.revision,
      worker: {
        ...task.worker,
        state: 'released',
        releasedAt: new Date().toISOString(),
      },
    });
    return { updated: true, continuation: null };
  }
  return { updated: false, continuation: null };
}

async function reconcileReleasedRun(stateRoot, run, backend, inspect, config) {
  if (!await inspectReleaseSignal(run.dir)) {
    throw new Error('release signal disappeared before reconciliation');
  }
  if (!run.owner) {
    throw new Error('release reconciliation requires the durable owner identity');
  }
  await requireTerminationComplete(run, inspect);
  const task = await backend.get(run.taskId);
  if (!workerMatchesRun(task, run)) {
    throw new Error('backend worker identity does not match the release request');
  }
  const continuation = task.lifecycleMode === ATTENTION_MODE
    ? await readWorkspaceContinuation(stateRoot, run, config)
    : null;
  const reports = backend.reports ? await backend.reports(run.taskId) : [];
  const released = await updateReleasedTask(task, run, backend, continuation);
  await writeReceipt(path.join(run.dir, RELEASE_RECEIPT), {
    version: 1,
    kind: 'released',
    taskId: run.taskId,
    sessionId: run.sessionId,
    recordedAt: new Date().toISOString(),
    backendWorkerUpdated: released.updated,
    workspaceContinuation: released.continuation,
    reportsObserved: reports.length,
  });
  await rm(lockPath(stateRoot, run.taskId), { force: true });
}

export async function reconcileLiveReleaseRequests(
  stateRoot,
  live,
  backend,
  dependencies = {},
) {
  const inspect = dependencies.inspect || inspectProcess;
  const terminate = dependencies.terminateProcessTree || terminateOwnedProcessTree;
  const result = { terminated: [], reconciled: [], failures: [] };
  for (const run of live) {
    if (!run.releaseRequested) continue;
    try {
      if (!await inspectReleaseSignal(run.dir)) {
        throw new Error('release signal disappeared before termination');
      }
      if (!run.owner) throw new Error('live release request has no durable owner identity');
      const task = await backend.get(run.taskId);
      if (!workerMatchesRun(task, run)) {
        throw new Error('backend worker identity does not match the live release request');
      }
      const observed = await inspect(run.owner.pid);
      if (
        observed.state === 'live'
        && observed.identity !== run.owner.processStart
      ) {
        throw new Error('worker owner identity changed before release termination');
      }
      if (observed.state === 'unknown') {
        throw new Error('worker owner identity is uncertain before release termination');
      }
      if (observed.state === 'live') {
        await terminate(run.owner, {
          ...dependencies,
          inspect,
          onCaptured: async (captured) => writeTerminationJournal(run, captured),
        });
        result.terminated.push(run.taskId);
      }
      const after = await inspect(run.owner.pid);
      if (after.state === 'unknown') {
        throw new Error('worker owner identity is uncertain after release termination');
      }
      if (after.state === 'live' && after.identity === run.owner.processStart) {
        throw new Error('worker owner remained live after release termination');
      }
      await reconcileReleasedRun(stateRoot, run, backend, inspect, dependencies.config);
      result.reconciled.push(run.taskId);
    } catch (error) {
      result.failures.push({
        taskId: run.taskId,
        sessionId: run.sessionId,
        error: error.message,
      });
    }
  }
  return result;
}

export async function reconcileStaleRuns(
  stateRoot,
  stale,
  backend,
  dependencies = {},
) {
  const inspect = dependencies.inspect || inspectProcess;
  const failures = dependencies.failures || [];
  const reconciled = [];
  for (const run of stale) {
    try {
      const releaseRequested = await inspectReleaseSignal(run.dir);
      if (releaseRequested) {
        await reconcileReleasedRun(stateRoot, run, backend, inspect, dependencies.config);
        reconciled.push(run.taskId);
        continue;
      }
      const task = await backend.get(run.taskId);
      const marker = `Pan worker observation: unexpected-stop session ${run.sessionId}`;
      if (workerMatchesRun(task, run)) {
        const reports = backend.reports ? await backend.reports(run.taskId) : [];
        if (task.lifecycleMode === ATTENTION_MODE) {
          if (!['needsHelp', 'externalWaiting', 'onHold'].includes(task.attentionState)) {
            await backend.update(run.taskId, {
              expectedRevision: task.revision,
              attentionState: 'needsHelp',
            });
          }
        } else if (task.worker.state !== 'unexpected-stop') {
          await backend.update(run.taskId, {
            expectedRevision: task.revision,
            worker: {
              ...task.worker,
              state: 'unexpected-stop',
              stoppedAt: run.exit?.exitedAt || new Date().toISOString(),
              error: run.exit?.error || `process exited ${run.exit?.code ?? 'without a code'}`,
            },
          });
        }
        if (!reports.some((report) => report.content?.includes(marker))) {
          await backend.report(run.taskId, workerReport(
            task,
            run,
            `${marker}\n\nThe worker exited without ${RELEASE_SIGNAL}. `
              + 'Pan did not infer task completion or another lifecycle state, and the '
              + 'local workspace remains reserved for inspection or explicit recovery.',
          ));
        }
      }
      await writeReceipt(path.join(run.dir, UNEXPECTED_EXIT_RECEIPT), {
        version: 1,
        kind: 'unexpected-stop',
        taskId: run.taskId,
        sessionId: run.sessionId,
        recordedAt: new Date().toISOString(),
        backendWorkerMatched: workerMatchesRun(task, run),
      });
      reconciled.push(run.taskId);
    } catch (error) {
      failures.push({
        taskId: run.taskId,
        sessionId: run.sessionId,
        error: error.message,
      });
      // Leave the lock and run evidence in place. Reconciliation must fail closed.
    }
  }
  return reconciled;
}

function validateAwaitingAnswer(marker, run) {
  if (!marker || marker.version !== 1) throw new Error('awaiting-answer marker version must be 1');
  for (const field of ['sessionId', 'checkpointId', 'action', 'question', 'timestamp']) {
    if (!String(marker[field] || '').trim()) throw new Error(`awaiting-answer ${field} is required`);
  }
  if (!['clarify', 'discuss', 'approve', 'review'].includes(marker.action)) {
    throw new Error('awaiting-answer action is invalid');
  }
  if (marker.sessionId !== run.sessionId) {
    throw new Error('awaiting-answer sessionId does not match this run');
  }
  const timestamp = Date.parse(marker.timestamp);
  if (!Number.isFinite(timestamp)) throw new Error('awaiting-answer timestamp is invalid');
  return { ...marker, timestampMs: timestamp };
}

async function sameAwaitingCheckpoint(run, expected) {
  const current = await readOptionalJson(path.join(run.dir, AWAITING_ANSWER));
  if (!current) return false;
  const checked = validateAwaitingAnswer(current, run);
  return checked.checkpointId === expected.checkpointId
    && checked.timestamp === expected.timestamp
    && checked.action === expected.action;
}

export async function reconcileAttentionMarkers(
  live,
  backend,
  { now = Date.now(), graceSeconds = 120 } = {},
) {
  const result = { projected: [], cleared: [], skipped: [], failures: [] };
  for (const run of live) {
    try {
      const marker = await readOptionalJson(path.join(run.dir, AWAITING_ANSWER));
      const receiptPath = path.join(run.dir, AWAITING_RECEIPT);
      const receipt = await readOptionalJson(receiptPath);
      if (receipt) validateAttentionReceipt(receipt, run);
      const task = await backend.get(run.taskId);
      if (task.lifecycleMode !== ATTENTION_MODE || !workerMatchesRun(task, run)) {
        result.skipped.push({ taskId: run.taskId, reason: 'session association changed' });
        continue;
      }
      if (task.attentionState === 'requested') {
        const requestReceipt = path.join(run.dir, RUNNING_REQUEST_RECEIPT);
        if (!await readOptionalJson(requestReceipt)) {
          await backend.report(task.id, workerReport(
            task,
            run,
            `Pan attention routing: session ${run.sessionId} is already running.\n\n`
              + 'Pan did not launch a duplicate or inject into the live CLI process. '
              + 'Continue in the task worker terminal.',
          ));
          await writeReceipt(requestReceipt, {
            version: 1,
            kind: 'attention-request-running',
            taskId: run.taskId,
            sessionId: run.sessionId,
            recordedAt: new Date(now).toISOString(),
          });
        }
      } else {
        await rm(path.join(run.dir, RUNNING_REQUEST_RECEIPT), { force: true });
      }
      if (marker) {
        const checked = validateAwaitingAnswer(marker, run);
        const immediate = ['approve', 'review'].includes(checked.action)
          || marker.immediate === true;
        if (!immediate && now - checked.timestampMs < graceSeconds * 1000) {
          if (
            receipt
            && receipt.checkpointId !== checked.checkpointId
            && task.attentionState === 'needsHelp'
          ) {
            if (!await sameAwaitingCheckpoint(run, checked)) {
              result.skipped.push({ taskId: run.taskId, reason: 'question changed during reconciliation' });
              continue;
            }
            await backend.update(task.id, {
              expectedRevision: task.revision,
              attentionState: 'open',
            });
            await rm(receiptPath, { force: true });
          }
          result.skipped.push({ taskId: run.taskId, reason: 'question grace period remains' });
          continue;
        }
        if (task.attentionState === 'open') {
          if (!await sameAwaitingCheckpoint(run, checked)) {
            result.skipped.push({ taskId: run.taskId, reason: 'question changed during reconciliation' });
            continue;
          }
          await backend.update(task.id, {
            expectedRevision: task.revision,
            attentionState: 'needsHelp',
          });
          result.projected.push(task.id);
        } else if (task.attentionState !== 'needsHelp') {
          result.skipped.push({ taskId: run.taskId, reason: 'human status override preserved' });
          continue;
        }
        await writeAttentionReceipt(receiptPath, {
          version: 1,
          taskId: run.taskId,
          sessionId: run.sessionId,
          checkpointId: checked.checkpointId,
          projectedAt: new Date(now).toISOString(),
        }, run);
      } else if (receipt) {
        if (await readOptionalJson(path.join(run.dir, AWAITING_ANSWER))) {
          result.skipped.push({ taskId: run.taskId, reason: 'question changed during reconciliation' });
          continue;
        }
        if (
          receipt.sessionId === run.sessionId
          && task.attentionState === 'needsHelp'
        ) {
          await backend.update(task.id, {
            expectedRevision: task.revision,
            attentionState: 'open',
          });
          result.cleared.push(task.id);
        } else {
          result.skipped.push({ taskId: run.taskId, reason: 'newer human status preserved' });
        }
        await rm(receiptPath, { force: true });
      }
    } catch (error) {
      result.failures.push({ taskId: run.taskId, error: error.message });
    }
  }
  return result;
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

async function recordTaskLockOwner(lock, inspect) {
  const observed = await inspect(process.pid);
  if (observed.state !== 'live' || !observed.identity) {
    throw new Error('cannot establish task-lock runner identity');
  }
  const owner = {
    version: 1,
    pid: process.pid,
    processStart: observed.identity,
    recordedAt: new Date().toISOString(),
  };
  await lock.handle.writeFile(`${JSON.stringify(owner, null, 2)}\n`);
  await lock.handle.sync();
  return owner;
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

function runCapture(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) {
        resolve(Buffer.concat(stdout).toString('utf8'));
      } else {
        reject(new Error(
          `${command} exited ${code}: ${Buffer.concat(stderr).toString('utf8').trim()}`,
        ));
      }
    });
  });
}

async function processTable(platform = process.platform) {
  if (platform === 'win32') {
    const output = await runCapture('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId'
        + ' | ConvertTo-Json -Compress',
    ]);
    const parsed = JSON.parse(output || '[]');
    return (Array.isArray(parsed) ? parsed : [parsed]).map((entry) => ({
      pid: Number(entry.ProcessId),
      ppid: Number(entry.ParentProcessId),
    }));
  }
  const output = await runCapture('/bin/ps', ['-axo', 'pid=,ppid=']);
  return output.split(/\r?\n/).map((line) => {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    return { pid, ppid };
  }).filter((entry) => Number.isInteger(entry.pid) && Number.isInteger(entry.ppid));
}

function descendantsFromTable(entries, rootPid) {
  const children = new Map();
  for (const entry of entries) {
    const values = children.get(entry.ppid) ?? [];
    values.push(entry.pid);
    children.set(entry.ppid, values);
  }
  const descendants = [];
  const visit = (pid, depth) => {
    for (const child of children.get(pid) ?? []) {
      descendants.push({ pid: child, depth });
      visit(child, depth + 1);
    }
  };
  visit(rootPid, 1);
  return descendants.sort((left, right) => right.depth - left.depth).map((entry) => entry.pid);
}

function signalPid(pid, signal) {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

async function waitForOwnedExit(owner, {
  inspect = inspectProcess,
  trackedDescendants = [],
  timeoutMs = 5000,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
} = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const observed = await inspect(owner.pid);
    const ownerGone = (
      observed.state === 'dead'
      || (observed.state === 'live' && observed.identity !== owner.processStart)
    );
    if (ownerGone) {
      let descendantsGone = true;
      for (const descendant of trackedDescendants) {
        const child = await inspect(descendant.pid);
        if (child.state === 'unknown') {
          throw new Error(`worker descendant PID ${descendant.pid} identity is uncertain`);
        }
        if (child.state === 'live' && child.identity === descendant.processStart) {
          descendantsGone = false;
          break;
        }
      }
      if (descendantsGone) return;
    }
    await sleep(50);
  }
  throw new Error(`worker process tree rooted at PID ${owner.pid} did not exit`);
}

export async function terminateOwnedProcessTree(owner, dependencies = {}) {
  const inspect = dependencies.inspect || inspectProcess;
  const listProcesses = dependencies.listProcesses || processTable;
  const kill = dependencies.kill || signalPid;
  const observed = await inspect(owner.pid);
  if (observed.state === 'dead') return { alreadyExited: true };
  if (observed.state !== 'live' || observed.identity !== owner.processStart) {
    throw new Error('worker owner identity changed before termination');
  }
  const initialTable = await listProcesses();
  const descendants = descendantsFromTable(initialTable, owner.pid);
  const trackedDescendants = [];
  for (const pid of descendants) {
    const child = await inspect(pid);
    if (child.state !== 'live' || !child.identity) {
      throw new Error(`worker descendant PID ${pid} identity could not be verified`);
    }
    trackedDescendants.push({ pid, processStart: child.identity });
  }
  if (dependencies.onCaptured) {
    await dependencies.onCaptured({
      owner: { pid: owner.pid, processStart: owner.processStart },
      descendants: trackedDescendants,
    });
  }
  for (const descendant of trackedDescendants) {
    const current = await inspect(descendant.pid);
    if (current.state === 'unknown') {
      throw new Error(`worker descendant PID ${descendant.pid} identity is uncertain`);
    }
    if (
      current.state === 'live'
      && current.identity === descendant.processStart
    ) {
      kill(descendant.pid, 'SIGTERM');
    }
  }
  const beforeOwnerSignal = await inspect(owner.pid);
  if (
    beforeOwnerSignal.state === 'live'
    && beforeOwnerSignal.identity === owner.processStart
  ) {
    kill(owner.pid, 'SIGTERM');
  } else if (beforeOwnerSignal.state !== 'dead') {
    throw new Error('worker owner identity changed before its termination signal');
  }
  try {
    await waitForOwnedExit(owner, {
      inspect,
      trackedDescendants,
      timeoutMs: dependencies.terminateTimeoutMs ?? 5000,
      sleep: dependencies.sleep,
    });
  } catch (error) {
    let escalated = false;
    for (const descendant of trackedDescendants) {
      const child = await inspect(descendant.pid);
      if (child.state === 'unknown') {
        throw new Error(`worker descendant PID ${descendant.pid} identity is uncertain`);
      }
      if (child.state === 'live' && child.identity === descendant.processStart) {
        kill(descendant.pid, 'SIGKILL');
        escalated = true;
      }
    }
    const beforeEscalation = await inspect(owner.pid);
    if (
      beforeEscalation.state === 'live'
      && beforeEscalation.identity === owner.processStart
    ) {
      kill(owner.pid, 'SIGKILL');
      escalated = true;
    } else if (
      beforeEscalation.state === 'unknown'
      || (
        beforeEscalation.state === 'live'
        && beforeEscalation.identity !== owner.processStart
      )
    ) {
      throw error;
    }
    if (!escalated) throw error;
    await waitForOwnedExit(owner, {
      inspect,
      trackedDescendants,
      timeoutMs: dependencies.killTimeoutMs ?? 5000,
      sleep: dependencies.sleep,
    });
    return { alreadyExited: false, escalated: true };
  }
  return { alreadyExited: false, escalated: false };
}

function launcherSource({
  command,
  promptPath,
  stateDir,
  workingDirectory,
  additionalDirectories,
  copilotHome,
  sessionId,
}) {
  return `import { execFileSync, spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const stateDir=${JSON.stringify(stateDir)};
const command=${JSON.stringify(command)};
const prompt=readFileSync(${JSON.stringify(promptPath)},'utf8');
function identity(pid=process.pid){
  if(process.platform==='darwin'){
    return 'darwin:'+execFileSync('/bin/ps',['-p',String(pid),'-o','lstart=']).toString().trim();
  }
  if(process.platform==='linux'){
    const stat=readFileSync('/proc/'+pid+'/stat','utf8');
    const fields=stat.slice(stat.lastIndexOf(')')+1).trim().split(/\\s+/);
    return 'linux:'+readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim()+':'+fields[19];
  }
  throw new Error('unsupported launcher platform');
}
writeFileSync(path.join(stateDir,'owner.json'),JSON.stringify({pid:process.pid,processStart:identity(),recordedAt:new Date().toISOString()},null,2)+'\\n',{flag:'wx',mode:0o600});
const args=command.slice(1).filter((value)=>value!=='--interactive'&&value!=='-i');
const managedSessionId=${JSON.stringify(sessionId)};
if(managedSessionId&&!args.includes('--session-id')) args.push('--session-id',managedSessionId);
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
  env:{...process.env,COPILOT_HOME:${JSON.stringify(copilotHome)},PAN_STATE_DIR:stateDir,PAN_SYSTEM_DIR:${JSON.stringify(path.join(PAN_CHECKOUT, 'system'))},PAN_WORKING_DIRECTORY:${JSON.stringify(workingDirectory)}},
});
child.once('spawn',()=>{
  try{
    writeFileSync(path.join(stateDir,${JSON.stringify(CHILD_HANDSHAKE)}),JSON.stringify({pid:child.pid,processStart:identity(child.pid),sessionId:managedSessionId,recordedAt:new Date().toISOString()},null,2)+'\\n',{flag:'wx',mode:0o600});
  }catch(error){
    writeFileSync(path.join(stateDir,'exit.json'),JSON.stringify({exitedAt:new Date().toISOString(),error:'child handshake failed: '+error.message},null,2)+'\\n',{mode:0o600});
    child.kill('SIGTERM');
    process.exit(1);
  }
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

async function waitForChildHandshake(
  stateDir,
  sessionId,
  inspect,
  { timeoutMs = 5000, settleMs = 100, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {},
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const exit = await readOptionalJson(path.join(stateDir, 'exit.json'));
    if (exit) throw new Error(`worker exited before launch acknowledgement: ${exit.error || exit.code}`);
    try {
      const child = await readJson(path.join(stateDir, CHILD_HANDSHAKE));
      if (
        !Number.isInteger(child.pid)
        || child.pid <= 0
        || typeof child.processStart !== 'string'
        || !child.processStart
        || child.sessionId !== sessionId
      ) {
        throw new Error('invalid worker child handshake');
      }
      const first = await inspect(child.pid);
      if (first.state !== 'live' || first.identity !== child.processStart) {
        throw new Error('worker child is not live with the recorded identity');
      }
      await sleep(settleMs);
      const afterExit = await readOptionalJson(path.join(stateDir, 'exit.json'));
      if (afterExit) {
        throw new Error(`worker exited before launch acknowledgement: ${afterExit.error || afterExit.code}`);
      }
      const second = await inspect(child.pid);
      if (second.state !== 'live' || second.identity !== child.processStart) {
        throw new Error('worker child did not remain live through launch acknowledgement');
      }
      return child;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await sleep(50);
  }
  throw new Error('worker child did not establish a durable launch handshake');
}

function pathInside(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function canonicalizeProspectivePath(candidate) {
  let existing = path.resolve(candidate);
  const suffix = [];
  for (;;) {
    try {
      const canonical = await realpath(existing);
      return path.join(canonical, ...suffix.reverse());
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(existing);
      if (parent === existing) throw error;
      suffix.push(path.basename(existing));
      existing = parent;
    }
  }
}

export async function resolveAttentionWorkspace(stateRoot, taskId, config) {
  const stateDir = runDirectory(stateRoot, taskId);
  const session = await readOptionalJson(path.join(stateDir, TASK_SESSION));
  const fallback = path.join(stateRoot, 'task-homes', encodeURIComponent(taskId));
  const workingDirectory = path.resolve(session?.workingDirectory || fallback);
  const canonicalStateRoot = await realpath(stateRoot);
  const configuredRoots = await Promise.all(
    (config.attentionLifecycle?.allowedWorkspaceRoots ?? [])
      .map((root) => canonicalizeProspectivePath(path.resolve(root))),
  );
  const allowedRoots = [path.join(canonicalStateRoot, 'task-homes'), ...configuredRoots];
  const canonicalWorkingDirectory = await canonicalizeProspectivePath(workingDirectory);
  if (!allowedRoots.some((root) => pathInside(canonicalWorkingDirectory, root))) {
    throw new Error(`task-session workingDirectory is outside allowedWorkspaceRoots: ${workingDirectory}`);
  }
  return {
    workingDirectory: canonicalWorkingDirectory,
    playbookName: String(session?.playbookName || ''),
    resumptionNote: String(session?.resumptionNote || ''),
  };
}

async function requirePersistedSession(copilotHome, sessionId) {
  const sessionDir = path.join(copilotHome, 'session-state', sessionId);
  let directory;
  let events;
  try {
    [directory, events] = await Promise.all([
      stat(sessionDir),
      stat(path.join(sessionDir, 'events.jsonl')),
    ]);
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(
        `associated Copilot session ${sessionId} is missing from ${path.join(copilotHome, 'session-state')}`,
      );
    }
    throw error;
  }
  if (!directory.isDirectory() || !events.isFile() || events.size === 0) {
    throw new Error(`associated Copilot session ${sessionId} has no persisted conversation`);
  }
  return sessionDir;
}

async function mayInitializeAssociatedSession(stateDir, task) {
  const run = await readOptionalJson(path.join(stateDir, 'run.json'));
  const receipt = await readOptionalJson(path.join(stateDir, LAUNCH_FAILURE_RECEIPT));
  if (!run || !receipt) return false;
  try {
    validateReceipt(receipt, run, 'launch-failure');
  } catch {
    return false;
  }
  const [owner, child] = await Promise.all([
    readOptionalJson(path.join(stateDir, 'owner.json')),
    readOptionalJson(path.join(stateDir, CHILD_HANDSHAKE)),
  ]);
  return run.lifecycleMode === ATTENTION_MODE
    && run.resuming === false
    && receipt.resuming === false
    && receipt.definitelyNotStarted === true
    && receipt.phase === run.phase
    && ['prepared', 'associated'].includes(run.phase)
    && !owner
    && !child
    && run.taskId === task.id
    && run.sessionId === task.sessionId
    && run.machine === task.machineId;
}

async function resetRunFiles(stateDir) {
  for (const name of [
    'owner.json',
    CHILD_HANDSHAKE,
    'exit.json',
    RELEASE_SIGNAL,
    RELEASE_RECEIPT,
    RELEASE_TERMINATION,
    UNEXPECTED_EXIT_RECEIPT,
    LAUNCH_FAILURE_RECEIPT,
    RUNNING_REQUEST_RECEIPT,
    WORKSPACE_CONTINUATION,
    'launch.mjs',
    'launch-prompt.txt',
    'task.json',
    'reports.json',
    'playbook.md',
    'pan.md',
    'trust.json',
  ]) {
    await rm(path.join(stateDir, name), { force: true });
  }
}

export async function launchTask(task, config, backend, dependencies = {}) {
  const stateRoot = path.resolve(config.stateRoot);
  const attentionMode = config.lifecycleMode === ATTENTION_MODE;
  const allowedTaskIds = new Set((config.taskIds ?? []).map(String));
  if (allowedTaskIds.size > 0 && !allowedTaskIds.has(String(task.id))) {
    throw new Error(`task ${task.id} is outside the runner taskIds allowlist`);
  }
  await mkdir(path.join(stateRoot, 'runs'), { recursive: true, mode: 0o700 });
  const lock = await acquireTaskLock(stateRoot, task.id);
  if (!lock) return false;
  let sessionId = '';
  const stateDir = runDirectory(stateRoot, task.id);
  let attentionWorkspace = null;
  let attentionPlaybook = null;
  let workingDirectory = '';
  let runnerOwner = null;
  let run = null;
  let command = config.launchCommand;
  let starting;
  let terminalStarted = false;
  let terminalInvoked = false;
  try {
    if (attentionMode) {
      runnerOwner = await recordTaskLockOwner(lock, dependencies.inspect || inspectProcess);
    }
    if (attentionMode && task.machineId && task.machineId !== config.machine) {
      await releaseTaskLock(lock);
      return false;
    }
    if (attentionMode && Boolean(task.sessionId) !== Boolean(task.machineId)) {
      throw new Error(`task ${task.id} has a partial session association`);
    }
    sessionId = attentionMode && task.sessionId ? task.sessionId : randomUUID();
    attentionWorkspace = attentionMode
      ? await resolveAttentionWorkspace(stateRoot, task.id, config)
      : null;
    attentionPlaybook = attentionWorkspace?.playbookName
      ? config.attentionPlaybooks?.get(attentionWorkspace.playbookName)
      : null;
    if (attentionWorkspace?.playbookName && !attentionPlaybook) {
      throw new Error(`selected session playbook ${attentionWorkspace.playbookName} is unavailable`);
    }
    workingDirectory = attentionWorkspace?.workingDirectory
      ?? path.resolve(config.workingDirectory);
    if (!Array.isArray(command) || !command.length || command.some((part) => typeof part !== 'string')) {
      throw new Error('launchCommand must be a non-empty array of strings');
    }
    const modelIndex = command.indexOf('--model');
    if (modelIndex < 0 || command[modelIndex + 1] !== 'gpt-5.6-sol') {
      throw new Error('launchCommand must select --model gpt-5.6-sol');
    }
    const agentIndex = command.indexOf('--agent');
    if (agentIndex >= 0 && command[agentIndex + 1] !== 'pan-worker') {
      throw new Error('launchCommand must select --agent pan-worker');
    }
    if (agentIndex < 0) command = [...command, '--agent', 'pan-worker'];
    const workerDefinition = await readFile(
      path.join(PAN_CHECKOUT, '.github', 'agents', 'pan-worker.agent.md'),
      'utf8',
    );
    if (!workerDefinition.trim()) {
      throw new Error('packaged pan-worker agent definition is empty');
    }
    if (
      attentionMode
      && command.some((part) => ['--session-id', '--resume', '-r', '--continue'].includes(part))
    ) {
      throw new Error('launchCommand must not override runner-managed session identity');
    }
    if (!attentionMode && task.playbook !== config.playbookName) {
      throw new Error(`task playbook must be ${config.playbookName}`);
    }
    for (const field of ['panTaskCommand']) {
      if (!path.isAbsolute(config[field] || '')) {
        throw new Error(`${field} must be an absolute path`);
      }
    }
    if (!attentionMode && config.playbookText == null && !path.isAbsolute(config.playbookPath || '')) {
      throw new Error('playbookPath must be absolute when playbookText is not provided');
    }
    if (
      config.domainInstructionsText == null
      && !path.isAbsolute(config.domainInstructionsPath || '')
    ) {
      throw new Error(
        'domainInstructionsPath must be absolute when domainInstructionsText is not provided',
      );
    }
    if (
      attentionMode
      && task.sessionId
      && !await mayInitializeAssociatedSession(stateDir, task)
    ) {
      await requirePersistedSession(path.join(stateDir, 'copilot-home'), sessionId);
    }
    if (attentionMode) await resetRunFiles(stateDir);
    else await rm(stateDir, { recursive: true, force: true });
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    await mkdir(workingDirectory, { recursive: true });
    if (attentionMode) {
      const recheckedWorkspace = await resolveAttentionWorkspace(stateRoot, task.id, config);
      if (recheckedWorkspace.workingDirectory !== workingDirectory) {
        throw new Error('task-session workingDirectory changed during launch');
      }
      attentionWorkspace = recheckedWorkspace;
    }
    const [playbook, domainInstructions, reports] = await Promise.all([
      attentionMode
        ? Promise.resolve(
            attentionPlaybook
              ? attentionPlaybook.text
              : 'No playbook is selected. Begin as a conversation and select one only if needed.\n',
          )
        : (config.playbookText ?? readFile(config.playbookPath, 'utf8')),
      config.domainInstructionsText ?? readFile(config.domainInstructionsPath, 'utf8'),
      backend.reports ? backend.reports(task.id) : [],
    ]);
    run = {
      version: RUN_VERSION,
      taskId: task.id,
      sessionId,
      machine: config.machine,
      playbookName: attentionMode ? attentionWorkspace.playbookName : config.playbookName,
      playbookSha: config.playbookSha ?? null,
      domainSha: config.domainSha ?? null,
      workspaceSlot: config.workspaceSlot ?? null,
      workingDirectory,
      lifecycleMode: attentionMode ? ATTENTION_MODE : 'legacy-metadata-v1',
      runnerOwner,
      resuming: attentionMode ? Boolean(task.sessionId) : false,
      phase: 'prepared',
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
      [workingDirectory, stateDir],
    );
    const agentDirectory = path.join(trust.copilotHome, 'agents');
    await mkdir(agentDirectory, { recursive: true, mode: 0o700 });
    await writeFile(
      path.join(agentDirectory, 'pan-worker.agent.md'),
      workerDefinition,
      { mode: 0o600 },
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
      'This headed terminal is a worker session. Apply general and worker-scoped pan.md instructions, but ignore main chief-of-staff scheduling, portfolio review or reconciliation, task triage or backlog management, and session scheduling.',
      ...(attentionMode ? [
        `This is persistent Pan session ${sessionId}. Continue this same conversation for every phase and playbook.`,
        `Record a selected playbook, workingDirectory, and resumptionNote in ${path.join(stateDir, TASK_SESSION)}; request release before the runner restarts this same session in that allowed workspace.`,
        `To continue this same authorized task after a workspace change, write ${path.join(stateDir, WORKSPACE_CONTINUATION)} with version 1, sessionId ${sessionId}, machineId ${config.machine}, runCreatedAt from run.json, and the exact playbookName/workingDirectory from task-session.json plus requestedAt. Then create the exact empty release signal and exit. Do not write this continuation signal for a normal release or while awaiting an answer.`,
        `Before blocking for the user, write ${path.join(stateDir, AWAITING_ANSWER)} with version 1, sessionId, a unique checkpointId, timestamp, action, question, detail, and immediate=true for explicit approval/review gates. Delete it only after the answer is received.`,
        'Routine clarify/discuss questions remain AI Session Open during the configured grace period; approval/review gates become AI Needs Help immediately.',
        'Do not create recurring schedules. The runner mechanically projects durable attention state.',
        attentionWorkspace.resumptionNote
          ? `Prior resumption note: ${attentionWorkspace.resumptionNote}`
          : 'There is no prior resumption note.',
      ] : []),
      `Read current task state with: ${taskCommand} --config ${JSON.stringify(config.backendConfig)} get ${JSON.stringify(task.id)}`,
      `Read durable reports with: ${taskCommand} --config ${JSON.stringify(config.backendConfig)} reports ${JSON.stringify(task.id)}`,
      attentionMode
        ? `Write report JSON only to ${reportInputPath} with content, expectedSessionId=${JSON.stringify(sessionId)}, and expectedMachineId=${JSON.stringify(config.machine)}, then record it with: ${taskCommand} --config ${JSON.stringify(config.backendConfig)} report ${JSON.stringify(task.id)} --input @${reportInputPath}`
        : `Write the report request JSON only to ${reportInputPath}, then record it with: ${taskCommand} --config ${JSON.stringify(config.backendConfig)} report ${JSON.stringify(task.id)} --input @${reportInputPath}`,
      'Do not complete the backend task; the coordinating Pan session completes it after verifying your report and files.',
      `A report or backend status change does not release this worker. When the process, terminal, and workspace may be released, first record any needed report, then create an empty ${path.join(stateDir, RELEASE_SIGNAL)} and exit Copilot.`,
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
        workingDirectory,
        additionalDirectories: [
          PAN_CHECKOUT,
          path.dirname(process.execPath),
          path.dirname(path.resolve(config.panTaskCommand)),
          path.dirname(path.resolve(config.backendConfig)),
          ...(config.additionalDirectories ?? []).map((directory) => path.resolve(directory)),
        ],
        copilotHome: trust.copilotHome,
        sessionId: attentionMode ? sessionId : null,
      }),
      { mode: 0o600 },
    );
    starting = await backend.update(task.id, attentionMode ? {
      expectedRevision: task.revision,
      association: { machineId: config.machine, sessionId },
    } : {
      expectedRevision: task.revision,
      worker: { state: 'starting', machine: config.machine, sessionId },
    });
    if (attentionMode) {
      run.phase = 'associated';
      await writeFile(path.join(stateDir, 'run.json'), `${JSON.stringify(run, null, 2)}\n`, { mode: 0o600 });
    }
    if (allowedTaskIds.size > 0 && !allowedTaskIds.has(String(task.id))) {
      throw new Error(`task ${task.id} is outside the runner taskIds allowlist`);
    }
    if (attentionMode) {
      run.phase = 'terminal-requested';
      await writeFile(path.join(stateDir, 'run.json'), `${JSON.stringify(run, null, 2)}\n`, { mode: 0o600 });
    }
    terminalInvoked = true;
    await (dependencies.launchTerminal || launchTerminal)(
      stateDir,
      workingDirectory,
      config.terminal?.kind || (process.platform === 'darwin' ? 'macos-terminal' : 'windows-terminal'),
    );
    terminalStarted = true;
    const owner = await waitForOwner(
      stateDir,
      dependencies.inspect || inspectProcess,
      dependencies.ownerTimeoutMs,
    );
    if (attentionMode) {
      await waitForChildHandshake(
        stateDir,
        sessionId,
        dependencies.inspect || inspectProcess,
        {
          timeoutMs: dependencies.ownerTimeoutMs,
          settleMs: dependencies.childSettleMs,
          sleep: dependencies.sleep,
        },
      );
    }
    await backend.update(task.id, attentionMode ? {
      expectedRevision: starting.revision,
      attentionState: 'open',
    } : {
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
      await backend.update(task.id, attentionMode ? {
        expectedRevision: starting.revision,
        attentionState: 'requested',
      } : {
        expectedRevision: starting.revision,
        worker: {
          state: terminalStarted ? 'uncertain' : 'stopped',
          machine: config.machine,
          sessionId,
          error: error.message,
        },
      }).catch(() => {});
      await backend.report(
        task.id,
        workerReport(starting, { sessionId, machine: config.machine },
          `Pan runner launch failed on ${config.machine}: ${error.message}`),
      ).catch(() => {});
    } else if (attentionMode) {
      await backend.report(
        task.id,
        workerReport(task, { sessionId, machine: config.machine },
          `Pan runner resume failed on ${config.machine}: ${error.message}`),
      ).catch(() => {});
    }
    if (!terminalStarted && (!attentionMode || !terminalInvoked)) {
      await writeFile(
        path.join(stateDir, 'exit.json'),
        `${JSON.stringify({ exitedAt: new Date().toISOString(), error: error.message }, null, 2)}\n`,
        { mode: 0o600 },
      ).catch(() => {});
      await writeReceipt(path.join(stateDir, LAUNCH_FAILURE_RECEIPT), {
        version: 1,
        kind: 'launch-failure',
        taskId: task.id,
        sessionId,
        recordedAt: new Date().toISOString(),
        resuming: run?.resuming ?? Boolean(task.sessionId),
        phase: run?.phase ?? 'before-run',
        definitelyNotStarted: !await readOptionalJson(path.join(stateDir, 'owner.json'))
          && !await readOptionalJson(path.join(stateDir, CHILD_HANDSHAKE)),
      }).catch(() => {});
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
  const attentionMode = config.lifecycleMode === ATTENTION_MODE;
  for (const field of ['backendConfig', 'machine', 'stateRoot']) {
    if (!String(config[field] || '').trim()) throw new Error(`${field} is required`);
  }
  if (config.enabled !== true && !values['dry-run']) {
    throw new Error('backend runner is disabled; set enabled=true only after review');
  }
  if (attentionMode && config.singleRunnerDomain !== true) {
    throw new Error(
      'attention lifecycle requires singleRunnerDomain=true; Todoist cannot atomically claim blank associations',
    );
  }
  const dynamicPlaybooks = Boolean(config.domainRepo);
  if (!values['dry-run'] && !String(config.panTaskCommand || '').trim()) {
    throw new Error('panTaskCommand is required');
  }
  if (!attentionMode && !dynamicPlaybooks && !String(config.workingDirectory || '').trim()) {
    throw new Error('workingDirectory is required');
  }
  if (!attentionMode && !dynamicPlaybooks && !values['dry-run']) {
    for (const field of ['playbookName', 'playbookPath', 'domainInstructionsPath']) {
      if (!String(config[field] || '').trim()) throw new Error(`${field} is required`);
    }
  }
  const runnerLock = values['dry-run']
    ? null
    : await acquireRunnerLock(path.resolve(config.stateRoot), dependencies.inspect || inspectProcess);
  try {
    const backend = await loadTaskBackend(config.backendConfig, dependencies);
    await backend.initialize();
    const backendAttentionMode = backend.lifecycleMode === ATTENTION_MODE;
    if (attentionMode !== backendAttentionMode) {
      throw new Error(
        `runner and backend lifecycleMode must both ${attentionMode ? 'set' : 'omit'} ${ATTENTION_MODE}`,
      );
    }
    if (attentionMode) await backend.validateAttentionLabels();
    const poll = async () => {
      const attentionLoaded = attentionMode && dynamicPlaybooks
        ? await loadBackendPlaybooks(config, dependencies)
        : null;
      const reconciliationConfig = attentionLoaded ? {
        ...config,
        domainInstructionsText: attentionLoaded.domainInstructions,
        domainSha: attentionLoaded.domainSha,
        attentionPlaybooks: attentionLoaded.playbooks,
      } : config;
      let inventory = await inspectLocalRuns(path.resolve(config.stateRoot), {
        inspect: dependencies.inspect || inspectProcess,
      });
      const runReconciliation = { terminated: [], reconciled: [], failures: [] };
      if (!values['dry-run']) {
        const interrupted = await reconcileRecoverableLaunches(
          path.resolve(config.stateRoot),
          inventory,
          backend,
        );
        runReconciliation.reconciled.push(...interrupted.reconciled);
        runReconciliation.failures.push(...interrupted.failures);
        const liveRelease = await reconcileLiveReleaseRequests(
          path.resolve(config.stateRoot),
          inventory.live,
          backend,
          { ...dependencies, config: reconciliationConfig },
        );
        runReconciliation.terminated.push(...liveRelease.terminated);
        runReconciliation.reconciled.push(...liveRelease.reconciled);
        runReconciliation.failures.push(...liveRelease.failures);
        const staleFailures = [];
        runReconciliation.reconciled.push(...await reconcileStaleRuns(
          path.resolve(config.stateRoot),
          inventory.stale,
          backend,
          {
            inspect: dependencies.inspect || inspectProcess,
            failures: staleFailures,
            config: reconciliationConfig,
          },
        ));
        runReconciliation.failures.push(...staleFailures);
        for (const run of inventory.released) {
          await rm(lockPath(path.resolve(config.stateRoot), run.taskId), { force: true })
            .catch((error) => runReconciliation.failures.push({
              taskId: run.taskId,
              sessionId: run.sessionId,
              error: `could not remove released task lock: ${error.message}`,
            }));
        }
        inventory = await inspectLocalRuns(path.resolve(config.stateRoot), {
          inspect: dependencies.inspect || inspectProcess,
        });
        if (attentionMode) {
          runReconciliation.attention = await reconcileAttentionMarkers(
            inventory.live,
            backend,
            {
              graceSeconds: Number(config.attentionLifecycle?.questionGraceSeconds ?? 120),
            },
          );
        }
      }
      if (attentionMode) {
        let attentionConfig = config;
        if (attentionLoaded) {
          attentionConfig = {
            ...config,
            domainInstructionsText: attentionLoaded.domainInstructions,
            domainSha: attentionLoaded.domainSha,
            attentionPlaybooks: attentionLoaded.playbooks,
          };
        }
        const tasks = await backend.list();
        const activeTaskIds = new Set([
          ...inventory.live,
          ...inventory.uncertain,
          ...(inventory.unexpected ?? []),
          ...inventory.stale,
          ...(inventory.recoverable ?? []),
          ...(inventory.orphanLocks ?? []),
        ].map((run) => run.taskId));
        const allowedTaskIds = new Set((config.taskIds ?? []).map(String));
        const selected = selectAttentionRequested(tasks, config.machine).filter((task) =>
          !activeTaskIds.has(task.id)
          && (allowedTaskIds.size === 0 || allowedTaskIds.has(String(task.id))));
        const capacity = Math.max(
          0,
          Number(config.maxConcurrent ?? 1) - activeTaskIds.size,
        );
        const launched = [];
        const skipped = [
          ...attentionRecoverySkips(inventory),
          ...tasks
          .filter((task) => task.attentionState === 'requested' && task.machineId
            && task.machineId !== config.machine)
          .map((task) => ({ id: task.id, reason: `associated with machine ${task.machineId}` })),
        ];
        runReconciliation.uncertain = attentionRecoverySkips(inventory);
        if (!values['dry-run']) {
          for (const task of selected.slice(0, capacity)) {
            if (await (dependencies.launch || ((candidate) =>
              launchTask(candidate, attentionConfig, backend, dependencies)))(task) !== false) {
              launched.push(task.id);
            }
          }
        }
        return {
          observed: tasks.length,
          candidates: selected.length,
          selected: selected.slice(0, capacity).map((task) => task.id),
          launched,
          skipped,
          runReconciliation,
        };
      }
      if (dynamicPlaybooks) {
        const loaded = await loadBackendPlaybooks(config, dependencies);
        const tasks = await backend.list();
        const planned = await planBackendTasks({
          tasks,
          inventory,
          config,
          playbooks: loaded.playbooks,
        });
        const launched = [];
        if (!values['dry-run']) {
          for (const plan of planned.plans) {
            const perPlaybookCommand = config.playbookLaunchCommands?.[plan.playbook.name];
            const launchConfig = {
              ...config,
              workingDirectory: plan.workingDirectory,
              workspaceSlot: plan.workspaceSlot,
              playbookName: plan.playbook.name,
              playbookText: plan.playbook.text,
              playbookSha: plan.playbook.sha,
              domainInstructionsText: loaded.domainInstructions,
              domainSha: loaded.domainSha,
              launchCommand: perPlaybookCommand || config.launchCommand,
            };
            if (await (dependencies.launch || ((task) =>
              launchTask(task, launchConfig, backend, dependencies)))(plan.task) !== false) {
              launched.push(plan.task.id);
            }
          }
        }
        return {
          observed: tasks.length,
          candidates: planned.candidates.length,
          selected: planned.plans.map((plan) => plan.task.id),
          launched,
          skipped: planned.skipped,
          playbooks: [...loaded.playbooks.values()].map((playbook) => ({
            name: playbook.name,
            capacity: playbook.capacity,
            sha: playbook.sha,
          })),
          domainSha: loaded.domainSha,
          runReconciliation,
        };
      }
      const activeTaskIds = new Set(inventory.live.map((run) => run.taskId));
      const workspace = path.resolve(config.workingDirectory);
      const workspaceBusy = inventory.live.some(
        (run) => path.resolve(run.workingDirectory) === workspace,
      ) || inventory.uncertain.some((run) =>
        run.workingDirectory == null || path.resolve(run.workingDirectory) === workspace,
      ) || (inventory.unexpected ?? []).some((run) =>
        run.workingDirectory == null || path.resolve(run.workingDirectory) === workspace,
      ) || inventory.stale.some((run) =>
        run.workingDirectory == null || path.resolve(run.workingDirectory) === workspace,
      );
      // This pilot has one configured working directory rather than a workspace
      // pool, so at most one new task may enter it in a poll.
      const capacity = Math.min(
        1,
        Math.max(0, (config.maxConcurrent ?? 1) - inventory.live.length),
      );
      return {
        ...await pollBackendTasks({
          backend,
          capacity,
          activeTaskIds,
          workspaceBusy,
          dryRun: values['dry-run'],
          allowedTaskIds: new Set((config.taskIds ?? []).map(String)),
          launch: dependencies.launch || ((task) => launchTask(task, config, backend, dependencies)),
        }),
        runReconciliation,
      };
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
