import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export class TaskBackendError extends Error {
  constructor(message, { code = 'backend-error', status = null, details = null } = {}) {
    super(message);
    this.name = 'TaskBackendError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export async function loadTaskBackend(configPath, dependencies = {}) {
  const absolute = path.resolve(configPath);
  const config = JSON.parse(await readFile(absolute, 'utf8'));
  if (config.backend !== 'todoist') {
    throw new TaskBackendError(`unsupported task backend: ${JSON.stringify(config.backend)}`, {
      code: 'unsupported-backend',
    });
  }
  const { TodoistTaskBackend } = await import('./pan-todoist-task-backend.js');
  return new TodoistTaskBackend(config, {
    configPath: absolute,
    ...dependencies,
  });
}

export function writeJson(value, stream = process.stdout) {
  stream.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function isCliEntry(importMetaUrl) {
  return process.argv[1] && importMetaUrl === pathToFileURL(process.argv[1]).href;
}
