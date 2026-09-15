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
  const config = dependencies.backendConfig
    ?? JSON.parse(await readFile(absolute, 'utf8'));
  if (config.backend === 'todoist') {
    const { TodoistTaskBackend } = await import('./pan-todoist-task-backend.js');
    return new TodoistTaskBackend(config, dependencies);
  }
  if (config.backend === 'github') {
    const { GitHubTaskBackend } = await import('./pan-github-task-backend.js');
    return new GitHubTaskBackend(config, dependencies);
  }
  throw new TaskBackendError(`unsupported task backend: ${JSON.stringify(config.backend)}`, {
    code: 'unsupported-backend',
  });
}

export function writeJson(value, stream = process.stdout) {
  stream.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function isCliEntry(importMetaUrl) {
  return process.argv[1] && importMetaUrl === pathToFileURL(process.argv[1]).href;
}
