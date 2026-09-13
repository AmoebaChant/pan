#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { isCliEntry, loadTaskBackend, writeJson } from './pan-task-backend.js';

const HELP = `Pan Todoist attention-lifecycle migration

Usage:
  pan-attention-migrate preview --config <backend.json> [--request-attention <task-id> ...]
  pan-attention-migrate apply --config <backend.json> --confirm-writers-stopped [--request-attention <task-id> ...]

Preview is read-only. Apply preserves native title, project, dates, priority,
recurrence, and unrelated labels. Legacy ready-for-ai state is not dispatch
authority: only an id named by --request-attention receives that label.
`;

export function parseAttentionMigrationCli(argv) {
  const [command, ...rest] = argv;
  if (!command || command === 'help' || command === '--help') return { help: true };
  if (!['preview', 'apply'].includes(command)) throw new Error(`unknown command: ${command}`);
  const { values } = parseArgs({
    args: rest,
    options: {
      config: { type: 'string' },
      'request-attention': { type: 'string', multiple: true, default: [] },
      'confirm-writers-stopped': { type: 'boolean', default: false },
    },
    strict: true,
  });
  if (!values.config || !path.isAbsolute(values.config)) {
    throw new Error('--config must be an absolute path');
  }
  if (command === 'apply' && !values['confirm-writers-stopped']) {
    throw new Error('apply requires --confirm-writers-stopped');
  }
  return {
    help: false,
    command,
    config: values.config,
    requestAttention: new Set(values['request-attention'].map(String)),
  };
}

export async function runAttentionMigration(options, dependencies = {}) {
  const config = dependencies.backendConfig
    ?? JSON.parse(await readFile(options.config, 'utf8'));
  if (config.backend !== 'todoist') throw new Error('migration requires a Todoist backend');
  const backend = await loadTaskBackend(options.config, {
    ...dependencies,
    backendConfig: { ...config, lifecycleMode: 'legacy-metadata-v1' },
  });
  await backend.initialize();
  await backend.validateAttentionLabels();
  const nativeTasks = [];
  let cursor = null;
  do {
    const query = new URLSearchParams({ limit: '200' });
    if (cursor) query.set('cursor', cursor);
    const page = await backend.request('GET', `/tasks?${query}`);
    const results = Array.isArray(page) ? page : (page.results ?? []);
    nativeTasks.push(...results.filter((task) => backend.inScope(task)));
    cursor = Array.isArray(page) ? null : (page.next_cursor ?? null);
  } while (cursor);
  const plans = nativeTasks.map((nativeTask) => backend.planAttentionMigration(
    { nativeTask },
    { requestAttention: options.requestAttention.has(String(nativeTask.id)) },
  ));
  const plannedIds = new Set(plans.map((plan) => plan.id));
  const unmatchedRequestAttention = [...options.requestAttention]
    .filter((id) => !plannedIds.has(id))
    .sort();
  const result = {
    format: 'pan-attention-migration',
    version: 1,
    mode: options.command,
    plans,
    unmatchedRequestAttention,
    applied: [],
    failures: [],
  };
  if (options.command === 'apply') {
    for (const plan of plans) {
      if (plan.action !== 'migrate') continue;
      try {
        const task = await backend.migrateAttentionTask(plan);
        result.applied.push({
          id: task.id,
          attentionState: task.attentionState,
          sessionId: task.sessionId,
          machineId: task.machineId,
        });
      } catch (error) {
        result.failures.push({ id: plan.id, error: error.message });
      }
    }
  }
  result.partial = plans.some((plan) => plan.action === 'conflict')
    || result.failures.length > 0
    || unmatchedRequestAttention.length > 0;
  return result;
}

if (isCliEntry(import.meta.url)) {
  const options = parseAttentionMigrationCli(process.argv.slice(2));
  if (options.help) process.stdout.write(HELP);
  else {
    runAttentionMigration(options)
      .then((result) => {
        writeJson({ ok: !result.partial, result }, result.partial ? process.stderr : process.stdout);
        if (result.partial) process.exitCode = 2;
      })
      .catch((error) => {
        writeJson({ ok: false, error: { message: error.message } }, process.stderr);
        process.exitCode = 1;
      });
  }
}
