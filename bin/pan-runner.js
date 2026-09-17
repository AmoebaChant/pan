#!/usr/bin/env node

import { isCliEntry, writeJson } from './pan-task-backend.js';
import { runRunner } from './pan-backend-runner.js';

export * from './pan-backend-runner.js';

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
