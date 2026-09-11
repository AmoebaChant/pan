import { readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { TaskBackendError } from './pan-task-backend.js';

const METADATA_RE = /(?:\n\n)?<!-- pan-task:v1\n([\s\S]*?)\n-->\s*$/;
const PRIORITY_TO_NATIVE = { low: 1, normal: 2, high: 3, urgent: 4 };
const NATIVE_TO_PRIORITY = { 1: 'low', 2: 'normal', 3: 'high', 4: 'urgent' };

function expandHome(value) {
  if (value === '~') return os.homedir();
  return value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value;
}

function parseCredentialFile(text, keys) {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const equals = trimmed.indexOf('=');
    if (equals < 1) continue;
    const key = trimmed.slice(0, equals).trim();
    if (!keys.includes(key)) continue;
    let value = trimmed.slice(equals + 1).trim();
    if (
      value.length >= 2
      && ((value.startsWith('"') && value.endsWith('"'))
        || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    if (value) return value;
  }
  throw new TaskBackendError(
    `credential file does not contain ${keys.join(' or ')}`,
    { code: 'credentials-missing' },
  );
}

function metadataFrom(description = '') {
  const match = METADATA_RE.exec(description);
  if (!match) return { description, metadata: {} };
  try {
    const metadata = JSON.parse(match[1]);
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
      throw new Error('metadata must be an object');
    }
    return {
      description: description.slice(0, match.index).trimEnd(),
      metadata,
    };
  } catch (error) {
    throw new TaskBackendError(`invalid Pan metadata block: ${error.message}`, {
      code: 'invalid-metadata',
    });
  }
}

function descriptionWithMetadata(description, metadata) {
  const body = String(description ?? '').replace(METADATA_RE, '').trimEnd();
  const block = `<!-- pan-task:v1\n${JSON.stringify(metadata)}\n-->`;
  return body ? `${body}\n\n${block}` : block;
}

function assertObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TaskBackendError(`${name} must be an object`, { code: 'invalid-input' });
  }
}

export class TodoistTaskBackend {
  constructor(config, { configPath, fetchImpl = globalThis.fetch, readFileImpl = readFile } = {}) {
    assertObject(config, 'backend config');
    this.config = config;
    this.configPath = configPath;
    this.fetch = fetchImpl;
    this.readFile = readFileImpl;
    this.baseUrl = String(config.baseUrl || 'https://api.todoist.com/api/v1').replace(/\/$/, '');
    this.user = null;
    this.token = null;
  }

  async initialize() {
    const credentialFile = expandHome(
      this.config.credentialsFile || path.join(os.homedir(), 'todoist.cfg'),
    );
    const token = parseCredentialFile(
      await this.readFile(credentialFile, 'utf8'),
      ['TODOIST_API_KEY', 'TODOIST_API_TOKEN'],
    );
    this.token = token;
    this.user = await this.request('GET', '/user');
    return this;
  }

  async request(method, pathname, body = undefined) {
    if (!this.token) {
      throw new TaskBackendError('backend must be initialized before use', {
        code: 'not-initialized',
      });
    }
    const response = await this.fetch(`${this.baseUrl}${pathname}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let payload = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = text;
      }
    }
    if (!response.ok) {
      throw new TaskBackendError(
        `Todoist ${method} ${pathname} failed with HTTP ${response.status}`,
        { code: 'todoist-http-error', status: response.status, details: payload },
      );
    }
    return payload;
  }

  inScope(task) {
    const scope = this.config.scope ?? {};
    const projectIds = (scope.projectIds ?? []).map(String);
    if (projectIds.length && !projectIds.includes(String(task.project_id))) return false;
    const responsible = task.responsible_uid == null ? null : String(task.responsible_uid);
    const self = String(this.user.id);
    if (responsible === null) return scope.includeUnassigned !== false;
    if (responsible === self) return scope.includeSelf !== false;
    return false;
  }

  canonical(task) {
    const parsed = metadataFrom(task.description || '');
    const metadata = parsed.metadata;
    return {
      id: String(task.id),
      backend: 'todoist',
      url: `https://todoist.com/showTask?id=${encodeURIComponent(task.id)}`,
      title: task.content,
      description: parsed.description,
      status: metadata.status || 'untriaged',
      nextAction: metadata.nextAction || '',
      nextActionDetail: metadata.nextActionDetail || '',
      priority: NATIVE_TO_PRIORITY[task.priority] || 'normal',
      nextActionDate: task.due?.date || '',
      deadline: task.deadline?.date || '',
      playbook: metadata.playbook || '',
      workstream: metadata.workstream || '',
      executionAuthorized: metadata.executionAuthorized === true,
      dependencies: Array.isArray(metadata.dependencies) ? metadata.dependencies : [],
      worker: metadata.worker || null,
      responsibleUid: task.responsible_uid == null ? null : String(task.responsible_uid),
      projectId: String(task.project_id),
      recurring: !!task.due?.is_recurring,
      revision: task.updated_at || task.added_at || '',
      native: {
        due: task.due || null,
        deadline: task.deadline || null,
        labels: task.labels || [],
      },
    };
  }

  async list() {
    const tasks = [];
    let cursor = null;
    do {
      const query = new URLSearchParams({ limit: '200' });
      if (cursor) query.set('cursor', cursor);
      const page = await this.request('GET', `/tasks?${query}`);
      const results = Array.isArray(page) ? page : (page.results ?? []);
      tasks.push(...results);
      cursor = Array.isArray(page) ? null : (page.next_cursor ?? null);
    } while (cursor);
    return tasks.filter((task) => this.inScope(task)).map((task) => this.canonical(task));
  }

  async get(id) {
    const task = await this.request('GET', `/tasks/${encodeURIComponent(id)}`);
    if (!this.inScope(task)) {
      throw new TaskBackendError(`task ${id} is outside the configured scope`, {
        code: 'out-of-scope',
        status: 403,
      });
    }
    return this.canonical(task);
  }

  async create(input) {
    assertObject(input, 'create input');
    if (!String(input.title || '').trim()) {
      throw new TaskBackendError('title is required', { code: 'invalid-input' });
    }
    const metadata = {
      status: input.status || 'untriaged',
      nextAction: input.nextAction || '',
      nextActionDetail: input.nextActionDetail || '',
      playbook: input.playbook || '',
      workstream: input.workstream || '',
      executionAuthorized: input.executionAuthorized === true,
      dependencies: input.dependencies ?? [],
    };
    const body = {
      content: String(input.title).trim(),
      description: descriptionWithMetadata(input.description || '', metadata),
      priority: PRIORITY_TO_NATIVE[input.priority || 'normal'] ?? 2,
      ...(input.projectId || this.config.createProjectId
        ? { project_id: String(input.projectId || this.config.createProjectId) }
        : {}),
      ...(input.nextActionDate ? { due_date: input.nextActionDate } : {}),
      ...(input.deadline ? { deadline_date: input.deadline } : {}),
    };
    const created = await this.request('POST', '/tasks', body);
    if (!this.inScope(created)) {
      throw new TaskBackendError(
        `created task ${created.id} is outside the configured scope; inspect it manually`,
        { code: 'partial-write', details: { taskId: String(created.id) } },
      );
    }
    return this.canonical(created);
  }

  async update(id, input) {
    assertObject(input, 'update input');
    const current = await this.get(id);
    if (input.expectedRevision && input.expectedRevision !== current.revision) {
      throw new TaskBackendError(`task ${id} changed since it was read`, {
        code: 'revision-conflict',
        status: 409,
        details: { expected: input.expectedRevision, actual: current.revision },
      });
    }
    const native = await this.request('GET', `/tasks/${encodeURIComponent(id)}`);
    const parsed = metadataFrom(native.description || '');
    const metadata = {
      ...parsed.metadata,
      ...Object.fromEntries(
        ['status', 'nextAction', 'nextActionDetail', 'playbook', 'workstream', 'worker']
          .filter((key) => input[key] !== undefined)
          .map((key) => [key, input[key]]),
      ),
      ...(input.executionAuthorized === undefined
        ? {}
        : { executionAuthorized: input.executionAuthorized === true }),
      ...(input.dependencies === undefined ? {} : { dependencies: input.dependencies }),
    };
    const body = {
      ...(input.title === undefined ? {} : { content: String(input.title).trim() }),
      description: descriptionWithMetadata(
        input.description === undefined ? parsed.description : input.description,
        metadata,
      ),
      ...(input.priority === undefined
        ? {}
        : { priority: PRIORITY_TO_NATIVE[input.priority] }),
      ...(input.nextActionDate === undefined
        ? {}
        : input.nextActionDate
          ? { due_date: input.nextActionDate }
          : { due_string: 'no date' }),
      ...(input.deadline === undefined
        ? {}
        : input.deadline
          ? { deadline_date: input.deadline }
          : { deadline_date: null }),
    };
    if (body.priority === undefined && input.priority !== undefined) {
      throw new TaskBackendError(`unsupported priority: ${input.priority}`, {
        code: 'invalid-input',
      });
    }
    return this.canonical(await this.request('POST', `/tasks/${encodeURIComponent(id)}`, body));
  }

  async report(id, input) {
    assertObject(input, 'report input');
    if (!String(input.content || '').trim()) {
      throw new TaskBackendError('report content is required', { code: 'invalid-input' });
    }
    await this.get(id);
    const comment = await this.request('POST', '/comments', {
      task_id: String(id),
      content: String(input.content).trim(),
    });
    return { taskId: String(id), commentId: String(comment.id), recorded: true };
  }

  async complete(id, input = {}) {
    assertObject(input, 'complete input');
    const current = await this.get(id);
    if (input.expectedRevision && input.expectedRevision !== current.revision) {
      throw new TaskBackendError(`task ${id} changed since it was read`, {
        code: 'revision-conflict',
        status: 409,
        details: { expected: input.expectedRevision, actual: current.revision },
      });
    }
    await this.request('POST', `/tasks/${encodeURIComponent(id)}/close`);
    return { taskId: String(id), completed: true };
  }

  async remove(id) {
    await this.get(id);
    await this.request('DELETE', `/tasks/${encodeURIComponent(id)}`);
    return { taskId: String(id), deleted: true };
  }
}

export { descriptionWithMetadata, metadataFrom, parseCredentialFile };
