#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { isCliEntry, loadTaskBackend, TaskBackendError, writeJson } from './pan-task-backend.js';

const HELP = `Pan task backend CLI

Usage:
  pan-task --config <path> list
  pan-task --config <path> get <task-id>
  pan-task --config <path> create --input <json-or-@file>
  pan-task --config <path> update <task-id> --input <json-or-@file>
  pan-task --config <path> report <task-id> --input <json-or-@file>
  pan-task --config <path> complete <task-id> [--input <json-or-@file>]
  pan-task --config <path> delete <task-id>
`;

async function inputValue(value) {
  if (!value) return {};
  const text = value.startsWith('@') ? await readFile(value.slice(1), 'utf8') : value;
  return JSON.parse(text);
}

export async function runTaskCli(argv, dependencies = {}) {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      config: { type: 'string' },
      input: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
    strict: true,
  });
  if (values.help) return { help: true };
  if (!values.config) throw new TaskBackendError('--config is required', { code: 'invalid-input' });
  const [command, id] = positionals;
  const backend = await loadTaskBackend(values.config, dependencies);
  await backend.initialize();
  if (command === 'list' && !id) return backend.list();
  if (command === 'get' && id) return backend.get(id);
  if (command === 'create' && !id) return backend.create(await inputValue(values.input));
  if (command === 'update' && id) return backend.update(id, await inputValue(values.input));
  if (command === 'report' && id) return backend.report(id, await inputValue(values.input));
  if (command === 'complete' && id) return backend.complete(id, await inputValue(values.input));
  if (command === 'delete' && id) return backend.remove(id);
  throw new TaskBackendError('invalid command or arguments', { code: 'invalid-input' });
}

if (isCliEntry(import.meta.url)) {
  runTaskCli(process.argv.slice(2))
    .then((result) => {
      if (result?.help) process.stdout.write(HELP);
      else writeJson({ ok: true, result });
    })
    .catch((error) => {
      writeJson({
        ok: false,
        error: {
          code: error.code || 'error',
          message: error.message,
          status: error.status ?? null,
          details: error.details ?? null,
        },
      }, process.stderr);
      process.exitCode = 1;
    });
}
