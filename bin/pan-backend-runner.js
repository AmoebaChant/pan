#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { isCliEntry, loadTaskBackend, writeJson } from './pan-task-backend.js';

export function selectReadyForAi(tasks) {
  return tasks.filter((task) =>
    task.status === 'ready-for-ai'
    && task.nextAction === 'execute'
    && task.executionAuthorized === true
    && task.dependencies.length === 0
    && task.worker == null,
  );
}

export async function pollBackendTasks({ backend, capacity, activeTaskIds = new Set(), launch }) {
  const tasks = await backend.list();
  const candidates = selectReadyForAi(tasks).filter((task) => !activeTaskIds.has(task.id));
  const launched = [];
  for (const task of candidates.slice(0, Math.max(0, capacity))) {
    if (await launch(task) !== false) launched.push(task.id);
  }
  return { observed: tasks.length, candidates: candidates.length, launched };
}

async function defaultLaunch(task, config) {
  const stateRoot = path.resolve(config.stateRoot);
  await mkdir(stateRoot, { recursive: true, mode: 0o700 });
  const lockPath = path.join(stateRoot, `${encodeURIComponent(task.id)}.launch`);
  let lock;
  try {
    lock = await open(lockPath, 'wx', 0o600);
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  }
  const command = config.launchCommand;
  if (!Array.isArray(command) || !command.length || command.some((part) => typeof part !== 'string')) {
    await lock.close();
    await rm(lockPath, { force: true });
    throw new Error('launchCommand must be a non-empty array of strings');
  }
  const modelIndex = command.indexOf('--model');
  if (modelIndex < 0 || command[modelIndex + 1] !== 'gpt-5.6-sol') {
    await lock.close();
    await rm(lockPath, { force: true });
    throw new Error('launchCommand must select --model gpt-5.6-sol');
  }
  const prompt = [
    `Execute Pan task ${task.id}: ${task.title}`,
    `Read current task state with: pan-task --config ${JSON.stringify(config.backendConfig)} get ${JSON.stringify(task.id)}`,
    'Use pan-task report/update/complete to record durable progress and outcomes.',
    `Task URL: ${task.url}`,
  ].join('\n');
  const child = spawn(command[0], [...command.slice(1), prompt], {
    cwd: config.workingDirectory,
    stdio: 'ignore',
  });
  await writeFile(lockPath, `${child.pid}\n`, { mode: 0o600 });
  child.once('exit', async () => {
    await lock.close().catch(() => {});
    await rm(lockPath, { force: true }).catch(() => {});
  });
  child.unref();
  return true;
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
  const configPath = path.resolve(values.config);
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  if (!config.backendConfig) throw new Error('backendConfig is required');
  if (!String(config.machine || '').trim()) throw new Error('machine is required');
  if (config.enabled !== true && !values['dry-run']) {
    throw new Error('backend runner is disabled; set enabled=true only after review');
  }
  const backend = await loadTaskBackend(config.backendConfig, dependencies);
  await backend.initialize();
  const launch = values['dry-run']
    ? async () => true
    : (dependencies.launch || (async (task) => {
        const worker = {
          state: 'starting',
          machine: config.machine,
          startedAt: new Date().toISOString(),
        };
        await backend.update(task.id, {
          expectedRevision: task.revision,
          worker,
        });
        try {
          return await defaultLaunch(task, config);
        } catch (error) {
          await backend.report(task.id, {
            content: `Pan runner launch failed on ${config.machine}: ${error.message}`,
          }).catch(() => {});
          throw error;
        }
      }));
  const poll = () => pollBackendTasks({
    backend,
    capacity: config.maxConcurrent ?? 1,
    activeTaskIds: dependencies.activeTaskIds ?? new Set(),
    launch,
  });
  if (values.once || values['dry-run']) return poll();
  const interval = Number(config.pollIntervalSeconds ?? 30);
  if (!Number.isFinite(interval) || interval <= 0) {
    throw new Error('pollIntervalSeconds must be greater than zero');
  }
  for (;;) {
    const result = await poll();
    writeJson({ ok: true, result }, process.stderr);
    await new Promise((resolve) => setTimeout(resolve, interval * 1000));
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
