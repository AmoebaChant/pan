#!/usr/bin/env node

import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import {
  GitHubTaskStore,
  loadTaskServiceBinding,
} from './pan-github-task-store.js';
import {
  applyLifecycleMigration,
  planLifecycleMigration,
} from './pan-lifecycle-migration.js';

const HELP = `Pan additive lifecycle migration

Usage:
  node bin/pan-lifecycle-migrate.js plan --config <path> --checkout <path> [--report <path>]
  node bin/pan-lifecycle-migrate.js apply --config <path> --checkout <path> --confirm-runners-stopped [--report <path>]

Plan is read-only. Apply refuses every legacy in-progress item (a stale lease
does not prove its process/workspace free) and never changes the retained owner
field/options. Stop every old/new runner for the Domain and complete the
reviewed operational cutover before applying.
`;

export function parseLifecycleCli(argv) {
  const [command, ...rest] = argv;
  if (!command || command === '--help' || command === 'help') return { help: true };
  if (!['plan', 'apply'].includes(command)) throw new Error(`unknown command: ${command}`);
  const { values } = parseArgs({
    args: rest,
    options: {
      config: { type: 'string' },
      checkout: { type: 'string' },
      report: { type: 'string' },
      'confirm-runners-stopped': { type: 'boolean', default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  if (!values.config || !values.checkout) {
    throw new Error(`${command} requires --config and --checkout`);
  }
  for (const field of ['config', 'checkout', 'report']) {
    if (values[field] && !path.isAbsolute(values[field])) {
      throw new Error(`--${field} must be an absolute path`);
    }
  }
  if (command === 'apply' && !values['confirm-runners-stopped']) {
    throw new Error('apply requires --confirm-runners-stopped');
  }
  return {
    help: false,
    command,
    config: values.config,
    checkout: values.checkout,
    report: values.report,
  };
}

async function emit(value, reportPath) {
  const rendered = `${JSON.stringify(value, null, 2)}\n`;
  process.stdout.write(rendered);
  if (reportPath) await writeFile(reportPath, rendered, { mode: 0o600 });
}

export async function runLifecycleCommand(options) {
  const binding = await loadTaskServiceBinding(options.config, options.checkout);
  const store = await new GitHubTaskStore(binding).initialize();
  const current = await store.list();
  const plan = planLifecycleMigration(current.tasks);
  if (options.command === 'plan') {
    await emit(plan, options.report);
    return {
      exitCode: plan.actions.some((action) => action.action === 'requires-cutover-hold') ? 2 : 0,
    };
  }
  const report = await applyLifecycleMigration(plan, store);
  await emit(report, options.report);
  return { exitCode: report.partial ? 2 : 0 };
}

async function main() {
  const options = parseLifecycleCli(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }
  const result = await runLifecycleCommand(options);
  process.exitCode = result.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`pan-lifecycle-migrate: ${error.message}\n`);
    process.exitCode = 1;
  });
}
