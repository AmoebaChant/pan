#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import {
  GitHubTaskStore,
  loadTaskServiceBinding,
} from './pan-github-task-store.js';
import {
  applyLifecycleMigration,
  applyLifecycleRollback,
  parseMigrationAuthorizations,
  planLifecycleMigration,
  planLifecycleRollback,
} from './pan-lifecycle-migration.js';

const HELP = `Pan additive lifecycle migration

Usage:
  node bin/pan-lifecycle-migrate.js plan --config <path> --checkout <path> [--authorization <path>] [--report <path>]
  node bin/pan-lifecycle-migrate.js apply --config <path> --checkout <path> --authorization <path> --confirm-writers-stopped [--report <path>]
  node bin/pan-lifecycle-migrate.js rollback-plan --config <path> --checkout <path> [--report <path>]
  node bin/pan-lifecycle-migrate.js rollback-apply --config <path> --checkout <path> --confirm-writers-stopped [--report <path>]

Plan is read-only. Agent-owned work is not authorized by legacy owner alone:
the authorization file must explicitly approve each item and exactly match its
playbook and dependency text. Version 1 also accepts explicit non-execution
classifications "verifiedHumanCheckpoint" and "verifiedDeliberateHold". Those
entries must bind the exact plan projection, owner, Status, Issue state,
worker/resource fields, needs-human-since, requested action/detail, and target
worker state, with executionAuthorized=false, verifiedDeadProcess=true, and
verifiedWritersStopped=true. Detail must already be one canonical non-empty
line of at most 2,000 characters, with no control characters and no whitespace
normalization required. They never authorize execution.

Apply refuses live or uncertain workers and ambiguous retained sessions. Before
authorizing a legacy checkpoint or hold, the operator must verify the named
process is dead and every possible runner, worker, UI, briefing session, and
other Project writer is stopped. An expired lease alone is not death evidence.
Apply clears an exactly matched stale claim/lease only for such an authorization
and preserves machine, session, needs-human-since, and the unresolved action.
A CLOSED terminal item may retain a historical machine/session pair only when
claim-generation is empty. A complete machine/session/generation tuple remains
operational evidence and is invalid even without a claim or lease. Before
apply, verify terminal provenance has no pending result, checkpoint, or release
journal.
Apply never changes the retained owner field/options.
Rollback is generated from current live pilot state, preserves all work and
resource evidence, changes only the retained legacy owner/Status projection,
and refuses active, uncertain, stale, or externally inconsistent items.
`;

export function parseLifecycleCli(argv) {
  const [command, ...rest] = argv;
  if (!command || command === '--help' || command === 'help') return { help: true };
  if (!['plan', 'apply', 'rollback-plan', 'rollback-apply'].includes(command)) {
    throw new Error(`unknown command: ${command}`);
  }
  const { values } = parseArgs({
    args: rest,
    options: {
      config: { type: 'string' },
      checkout: { type: 'string' },
      authorization: { type: 'string' },
      report: { type: 'string' },
      'confirm-writers-stopped': { type: 'boolean', default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  if (!values.config || !values.checkout) {
    throw new Error(`${command} requires --config and --checkout`);
  }
  for (const field of ['config', 'checkout', 'authorization', 'report']) {
    if (values[field] && !path.isAbsolute(values[field])) {
      throw new Error(`--${field} must be an absolute path`);
    }
  }
  if (command === 'apply' && !values.authorization) {
    throw new Error('apply requires --authorization');
  }
  if (['apply', 'rollback-apply'].includes(command) && !values['confirm-writers-stopped']) {
    throw new Error(`${command} requires --confirm-writers-stopped`);
  }
  return {
    help: false,
    command,
    config: values.config,
    checkout: values.checkout,
    authorization: values.authorization,
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
  const authorizations = options.authorization
    ? parseMigrationAuthorizations(JSON.parse(await readFile(options.authorization, 'utf8')))
    : [];
  const rollback = options.command.startsWith('rollback-');
  const plan = rollback
    ? planLifecycleRollback(current.tasks)
    : planLifecycleMigration(current.tasks, { authorizations });
  if (options.command.endsWith('plan')) {
    await emit(plan, options.report);
    return {
      exitCode: plan.actions.some((action) =>
        ['requires-cutover-hold', 'requires-authorization', 'invalid-state']
          .includes(action.action)) ? 2 : 0,
    };
  }
  const report = rollback
    ? await applyLifecycleRollback(plan, store)
    : await applyLifecycleMigration(plan, store);
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
