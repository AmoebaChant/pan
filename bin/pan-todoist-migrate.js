#!/usr/bin/env node

import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import {
  GitHubTaskStore,
  loadTaskServiceBinding,
} from './pan-github-task-store.js';
import {
  applyTodoistImport,
  planTodoistImport,
  readTodoistSnapshot,
  recoveryPlan,
  verifyTodoistImport,
} from './pan-todoist-migration.js';
import { applyLifecycleRollback } from './pan-lifecycle-migration.js';

const HELP = `Pan Todoist migration and recovery

Usage:
  node bin/pan-todoist-migrate.js snapshot --output <path> [--todoist-token-env TODOIST_API_TOKEN]
  node bin/pan-todoist-migrate.js plan --snapshot <path> --config <path> --checkout <path> [--report <path>]
  node bin/pan-todoist-migrate.js apply --snapshot <path> --config <path> --checkout <path> --confirm-import [--report <path>]
  node bin/pan-todoist-migrate.js verify --snapshot <path> --config <path> --checkout <path> [--report <path>]
  node bin/pan-todoist-migrate.js recovery-plan --config <path> --checkout <path> [--report <path>]
  node bin/pan-todoist-migrate.js recovery-apply --config <path> --checkout <path> --confirm-writers-stopped [--report <path>]

The tool never deletes or completes Todoist tasks, Issues, Project items, or
history. Apply continues independent tasks after a per-task failure, reports a
partial import, and exits nonzero. Recovery apply translates current live pilot
state only; it never restores Todoist or replays a stale baseline.
`;

export function parseMigrationCli(argv) {
  const [command, ...rest] = argv;
  if (!command || command === '--help' || command === 'help') return { help: true };
  if (!['snapshot', 'plan', 'apply', 'verify', 'recovery-plan', 'recovery-apply'].includes(command)) {
    throw new Error(`unknown command: ${command}`);
  }
  const { values } = parseArgs({
    args: rest,
    options: {
      snapshot: { type: 'string' },
      output: { type: 'string' },
      report: { type: 'string' },
      config: { type: 'string' },
      checkout: { type: 'string' },
      'todoist-token-env': { type: 'string', default: 'TODOIST_API_TOKEN' },
      'todoist-base-url': { type: 'string', default: 'https://api.todoist.com/api/v1/' },
      'confirm-import': { type: 'boolean', default: false },
      'confirm-writers-stopped': { type: 'boolean', default: false },
    },
    allowPositionals: false,
    strict: true,
  });
  if (command === 'snapshot' && !values.output) {
    throw new Error('snapshot requires --output');
  }
  if (!['snapshot', 'recovery-plan', 'recovery-apply'].includes(command) && !values.snapshot) {
    throw new Error(`${command} requires --snapshot`);
  }
  if (command !== 'snapshot' && (!values.config || !values.checkout)) {
    throw new Error(`${command} requires --config and --checkout`);
  }
  if (command === 'apply' && !values['confirm-import']) {
    throw new Error('apply requires --confirm-import');
  }
  if (command === 'recovery-apply' && !values['confirm-writers-stopped']) {
    throw new Error('recovery-apply requires --confirm-writers-stopped');
  }
  for (const field of ['snapshot', 'output', 'report', 'config', 'checkout']) {
    if (values[field] && !path.isAbsolute(values[field])) {
      throw new Error(`--${field} must be an absolute path`);
    }
  }
  return {
    help: false,
    command,
    snapshot: values.snapshot,
    output: values.output,
    report: values.report,
    config: values.config,
    checkout: values.checkout,
    tokenEnv: values['todoist-token-env'],
    baseUrl: values['todoist-base-url'],
  };
}

async function readSnapshot(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

async function writePrivateJson(file, rendered) {
  const temporary = `${file}.tmp-${process.pid}`;
  await writeFile(temporary, rendered, { mode: 0o600 });
  await rename(temporary, file);
}

async function output(value, reportPath) {
  const rendered = `${JSON.stringify(value, null, 2)}\n`;
  process.stdout.write(rendered);
  if (reportPath) await writePrivateJson(reportPath, rendered);
}

async function liveStore(options) {
  const binding = await loadTaskServiceBinding(options.config, options.checkout);
  return new GitHubTaskStore(binding).initialize();
}

export async function runMigrationCommand(options) {
  if (options.command === 'snapshot') {
    const token = process.env[options.tokenEnv];
    if (!token) throw new Error(`environment variable ${options.tokenEnv} is not set`);
    const snapshot = await readTodoistSnapshot({ token, baseUrl: options.baseUrl });
    await writeFile(options.output, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
    await output({
      outcome: 'snapshot-written',
      output: options.output,
      eligibleTasks: snapshot.tasks.length,
      excludedAssignees: snapshot.excluded.length,
    }, options.report);
    return { exitCode: 0 };
  }

  const store = await liveStore(options);
  if (options.command === 'recovery-plan' || options.command === 'recovery-apply') {
    const live = await store.list();
    const plan = recoveryPlan(live.tasks);
    if (options.command === 'recovery-plan') {
      await output(plan, options.report);
      return {
        exitCode: plan.actions.some((action) =>
          ['requires-cutover-hold', 'invalid-state'].includes(action.action)) ? 2 : 0,
      };
    }
    const report = await applyLifecycleRollback(plan, store);
    await output(report, options.report);
    return { exitCode: report.partial ? 2 : 0 };
  }

  const snapshot = await readSnapshot(options.snapshot);
  const index = await store.todoistSourceIndex();
  const plan = planTodoistImport(snapshot, index);
  if (options.command === 'plan') {
    await output(plan, options.report);
    return {
      exitCode: plan.actions.some((action) => action.action === 'conflict') ? 2 : 0,
    };
  }
  if (options.command === 'apply') {
    const report = await applyTodoistImport(plan, store, snapshot, {
      onProgress: options.report
        ? async (checkpoint) => {
            await writePrivateJson(
              options.report,
              `${JSON.stringify(checkpoint, null, 2)}\n`,
            );
          }
        : undefined,
    });
    await output(report, options.report);
    return { exitCode: report.partial ? 2 : 0 };
  }

  const report = await verifyTodoistImport(snapshot, store);
  await output(report, options.report);
  return { exitCode: report.complete ? 0 : 2 };
}

async function main() {
  const options = parseMigrationCli(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }
  const result = await runMigrationCommand(options);
  process.exitCode = result.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`pan-todoist-migrate: ${error.message}\n`);
    process.exitCode = 1;
  });
}
