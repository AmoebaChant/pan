import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TaskBackendError } from './pan-task-backend.js';

const METADATA_RE = /(?:\n\n)?<!-- pan-task:v2\n([\s\S]*?)\n-->\s*$/;
const PRIORITY_TO_NATIVE = { low: 1, normal: 2, high: 3, urgent: 4 };
const NATIVE_TO_PRIORITY = { 1: 'low', 2: 'normal', 3: 'high', 4: 'urgent' };
const WORK_STATUSES = new Set(['open', 'done', 'rejected']);
const AGENT_STATUSES = new Set(['', 'requested', 'running']);

function assertObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TaskBackendError(`${name} must be an object`, { code: 'invalid-input' });
  }
}

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
  throw new TaskBackendError(`credential file does not contain ${keys.join(' or ')}`, {
    code: 'credentials-missing',
  });
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
    throw new TaskBackendError(`invalid Pan task metadata: ${error.message}`, {
      code: 'invalid-metadata',
    });
  }
}

function compactMetadata(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== '' && entry !== false),
  );
}

function descriptionWithMetadata(description, metadata) {
  const body = String(description ?? '').replace(METADATA_RE, '').trimEnd();
  const compact = compactMetadata(metadata);
  if (Object.keys(compact).length === 0) return body;
  const block = `<!-- pan-task:v2\n${JSON.stringify(compact)}\n-->`;
  return body ? `${body}\n\n${block}` : block;
}

function taskId(task) {
  return String(task.id ?? task.task_id ?? '');
}

function taskCompleted(task) {
  return task.checked === true
    || task.completed === true
    || task.is_completed === true
    || Boolean(task.completed_at);
}

export class TodoistTaskBackend {
  constructor(config, { fetchImpl = globalThis.fetch, readFileImpl = readFile } = {}) {
    assertObject(config, 'backend config');
    this.config = config;
    this.fetch = fetchImpl;
    this.readFile = readFileImpl;
    this.baseUrl = String(config.baseUrl || 'https://api.todoist.com/api/v1').replace(/\/$/, '');
    this.user = null;
    this.token = null;
    this.supportsIdempotentCreate = true;
  }

  async initialize() {
    const credentialFile = expandHome(
      this.config.credentialsFile || path.join(os.homedir(), 'todoist.cfg'),
    );
    this.token = parseCredentialFile(
      await this.readFile(credentialFile, 'utf8'),
      ['TODOIST_API_KEY', 'TODOIST_API_TOKEN'],
    );
    this.user = await this.request('GET', '/user');
    return this;
  }

  async request(method, pathname, body = undefined, additionalHeaders = {}) {
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
        ...additionalHeaders,
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
    const completed = taskCompleted(task);
    const status = completed && metadata.status === 'rejected'
      ? 'rejected'
      : completed ? 'done' : 'open';
    const agentStatus = AGENT_STATUSES.has(metadata.agentStatus)
      ? metadata.agentStatus
      : '';
    return {
      id: taskId(task),
      backend: 'todoist',
      itemId: taskId(task),
      number: taskId(task),
      repo: 'todoist',
      url: `https://todoist.com/showTask?id=${encodeURIComponent(taskId(task))}`,
      title: task.content ?? '',
      description: parsed.description,
      status,
      priority: NATIVE_TO_PRIORITY[task.priority] || 'normal',
      nextActionDate: task.due?.date || '',
      deadline: task.deadline?.date || '',
      playbook: String(metadata.playbook ?? ''),
      workstream: String(metadata.workstream ?? ''),
      sessionId: String(metadata.sessionId ?? ''),
      agentStatus,
      issueState: completed ? 'CLOSED' : 'OPEN',
      issueStateReason: completed
        ? status === 'done' ? 'COMPLETED' : 'NOT_PLANNED'
        : null,
      responsibleUid: task.responsible_uid == null ? null : String(task.responsible_uid),
      projectId: String(task.project_id ?? ''),
      recurring: Boolean(task.due?.is_recurring),
      createdAt: task.added_at || '',
      updatedAt: task.updated_at || task.completed_at || task.added_at || '',
      closedAt: task.completed_at || '',
      native: {
        due: task.due || null,
        deadline: task.deadline || null,
        completed,
      },
    };
  }

  async paged(pathname, resultKeys = ['results']) {
    const values = [];
    let cursor = null;
    do {
      const query = new URLSearchParams({ limit: '200' });
      if (cursor) query.set('cursor', cursor);
      const separator = pathname.includes('?') ? '' : '?';
      const page = await this.request('GET', `${pathname}${separator}${query}`);
      const results = Array.isArray(page)
        ? page
        : resultKeys.map((key) => page?.[key]).find(Array.isArray) ?? [];
      values.push(...results);
      cursor = Array.isArray(page) ? null : page?.next_cursor ?? null;
    } while (cursor);
    return values;
  }

  async list() {
    const active = await this.paged('/tasks');
    const completed = this.config.includeCompleted === false
      ? []
      : await this.paged('/tasks/completed/by_completion_date', ['items', 'results']);
    const merged = new Map();
    for (const task of [...active, ...completed]) {
      if (this.inScope(task)) merged.set(taskId(task), task);
    }
    return [...merged.values()].map((task) => this.canonical(task));
  }

  async nativeTask(id) {
    try {
      const task = await this.request('GET', `/tasks/${encodeURIComponent(id)}`);
      if (!this.inScope(task)) {
        throw new TaskBackendError(`task ${id} is outside the configured scope`, {
          code: 'out-of-scope',
          status: 403,
        });
      }
      return task;
    } catch (error) {
      if (error.status !== 404 || this.config.includeCompleted === false) throw error;
      const completed = await this.paged('/tasks/completed/by_completion_date', ['items', 'results']);
      const task = completed.find((candidate) => taskId(candidate) === String(id));
      if (!task || !this.inScope(task)) throw error;
      return task;
    }
  }

  async get(id) {
    return this.canonical(await this.nativeTask(id));
  }

  async create(input) {
    assertObject(input, 'create input');
    const title = String(input.title ?? '').trim();
    if (!title) throw new TaskBackendError('title is required', { code: 'invalid-input' });
    const status = input.status ?? 'open';
    if (!WORK_STATUSES.has(status)) {
      throw new TaskBackendError(`unsupported status: ${status}`, { code: 'invalid-input' });
    }
    const priority = input.priority ?? 'normal';
    if (!PRIORITY_TO_NATIVE[priority]) {
      throw new TaskBackendError(`unsupported priority: ${priority}`, { code: 'invalid-input' });
    }
    const projectId = input.projectId || this.config.createProjectId;
    const metadata = {
      playbook: String(input.playbook ?? ''),
      workstream: String(input.workstream ?? ''),
      sessionId: String(input.sessionId ?? ''),
      agentStatus: String(input.agentStatus ?? ''),
      status: status === 'rejected' ? 'rejected' : '',
    };
    if (!AGENT_STATUSES.has(metadata.agentStatus)) {
      throw new TaskBackendError(`unsupported agentStatus: ${metadata.agentStatus}`, {
        code: 'invalid-input',
      });
    }
    const idempotencyKey = String(input.idempotencyKey ?? '').trim();
    if (
      idempotencyKey
      && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
        .test(idempotencyKey)
    ) {
      throw new TaskBackendError('idempotencyKey must be a UUID', { code: 'invalid-input' });
    }
    const created = await this.request('POST', '/tasks', {
      content: title,
      description: descriptionWithMetadata(input.description || '', metadata),
      priority: PRIORITY_TO_NATIVE[priority],
      ...(projectId ? { project_id: String(projectId) } : {}),
      ...(input.nextActionDate ? { due_date: input.nextActionDate } : {}),
      ...(input.deadline ? { deadline_date: input.deadline } : {}),
    }, idempotencyKey ? { 'X-Request-Id': idempotencyKey } : {});
    if (!this.inScope(created)) {
      throw new TaskBackendError(
        `created task ${taskId(created)} is outside the configured scope`,
        { code: 'partial-write', details: { taskId: taskId(created) } },
      );
    }
    if (status !== 'open') {
      return this.update(taskId(created), { status });
    }
    return this.canonical(created);
  }

  async updateRecurringDate(id, native, date) {
    const uuid = randomUUID();
    const form = new URLSearchParams({
      sync_token: '*',
      resource_types: '[]',
      commands: JSON.stringify([{
        type: 'item_update',
        uuid,
        args: { id: String(id), due: { ...native.due, date } },
      }]),
    });
    const response = await this.fetch(`${this.baseUrl}/sync`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form,
    });
    const result = await response.json().catch(() => null);
    if (!response.ok || result?.sync_status?.[uuid] !== 'ok') {
      throw new TaskBackendError('Todoist recurring date update failed', {
        code: 'partial-write',
        status: response.ok ? null : response.status,
        details: {
          completedOperation: 'task metadata update',
          failedOperation: 'recurring native due-date update',
          response: result,
        },
      });
    }
  }

  async update(id, input) {
    assertObject(input, 'update input');
    let native = await this.nativeTask(id);
    let current = this.canonical(native);
    if (input.status !== undefined && !WORK_STATUSES.has(input.status)) {
      throw new TaskBackendError(`unsupported status: ${input.status}`, {
        code: 'invalid-input',
      });
    }
    if (input.agentStatus !== undefined && !AGENT_STATUSES.has(input.agentStatus)) {
      throw new TaskBackendError(`unsupported agentStatus: ${input.agentStatus}`, {
        code: 'invalid-input',
      });
    }
    if (input.priority !== undefined && !PRIORITY_TO_NATIVE[input.priority]) {
      throw new TaskBackendError(`unsupported priority: ${input.priority}`, {
        code: 'invalid-input',
      });
    }
    if (native.due?.is_recurring && input.nextActionDate === '') {
      throw new TaskBackendError(
        'a recurring task cannot be unscheduled without removing its native recurrence',
        { code: 'unsupported-mapping' },
      );
    }
    const requestedStatus = input.status ?? current.status;
    if (current.status !== 'open' && requestedStatus !== current.status) {
      await this.request('POST', `/tasks/${encodeURIComponent(id)}/reopen`);
      native = await this.nativeTask(id);
      current = this.canonical(native);
    }
    const parsed = metadataFrom(native.description || '');
    const metadata = {
      ...parsed.metadata,
      ...(input.playbook === undefined ? {} : { playbook: String(input.playbook) }),
      ...(input.workstream === undefined ? {} : { workstream: String(input.workstream) }),
      ...(input.sessionId === undefined ? {} : { sessionId: String(input.sessionId) }),
      ...(input.agentStatus === undefined ? {} : { agentStatus: String(input.agentStatus) }),
      status: requestedStatus === 'rejected' ? 'rejected' : '',
    };
    const body = {
      ...(input.title === undefined ? {} : { content: String(input.title).trim() }),
      description: descriptionWithMetadata(
        input.description === undefined ? parsed.description : input.description,
        metadata,
      ),
      ...(input.priority === undefined ? {} : { priority: PRIORITY_TO_NATIVE[input.priority] }),
      ...(input.nextActionDate === undefined || native.due?.is_recurring
        ? {}
        : input.nextActionDate ? { due_date: input.nextActionDate } : { due_string: 'no date' }),
      ...(input.deadline === undefined
        ? {}
        : input.deadline ? { deadline_date: input.deadline } : { deadline_date: null }),
    };
    let updated = await this.request('POST', `/tasks/${encodeURIComponent(id)}`, body);
    if (native.due?.is_recurring && input.nextActionDate !== undefined) {
      await this.updateRecurringDate(id, native, input.nextActionDate);
      updated = await this.nativeTask(id);
    }
    if (requestedStatus !== 'open') {
      try {
        await this.request('POST', `/tasks/${encodeURIComponent(id)}/close`);
      } catch (error) {
        throw new TaskBackendError(`task metadata updated but completion failed: ${error.message}`, {
          code: 'partial-write',
          details: { taskId: String(id) },
        });
      }
      return this.canonical({
        ...updated,
        completed: true,
        completed_at: new Date().toISOString(),
      });
    }
    return this.canonical(updated);
  }

  async validateProject(projectId) {
    const value = String(projectId ?? '').trim();
    if (!value) throw new TaskBackendError('projectId is required', { code: 'invalid-input' });
    const allowed = (this.config.scope?.projectIds ?? []).map(String);
    if (allowed.length && !allowed.includes(value)) {
      throw new TaskBackendError('destination project is outside configured scope', {
        code: 'out-of-scope',
      });
    }
    const project = await this.request('GET', `/projects/${encodeURIComponent(value)}`);
    if (String(project.id) !== value || project.is_archived || project.is_deleted) {
      throw new TaskBackendError('destination project is unavailable', {
        code: 'invalid-input',
      });
    }
    return project;
  }

  async move(id, input) {
    assertObject(input, 'move input');
    await this.validateProject(input.projectId);
    await this.nativeTask(id);
    await this.request('POST', `/tasks/${encodeURIComponent(id)}/move`, {
      project_id: String(input.projectId),
    });
    return this.get(id);
  }

  async comment(id, input) {
    assertObject(input, 'comment input');
    const content = String(input.content ?? '').trim();
    if (!content) {
      throw new TaskBackendError('comment content is required', { code: 'invalid-input' });
    }
    await this.nativeTask(id);
    const comment = await this.request('POST', '/comments', {
      task_id: String(id),
      content,
    });
    return { taskId: String(id), commentId: String(comment.id), recorded: true };
  }

  report(id, input) {
    return this.comment(id, input);
  }

  async comments(id) {
    await this.nativeTask(id);
    return (await this.paged(
      `/comments?task_id=${encodeURIComponent(id)}&`,
      ['results'],
    )).map((comment) => ({
      id: String(comment.id),
      taskId: String(id),
      content: comment.content ?? '',
      postedAt: comment.posted_at || comment.added_at || '',
      updatedAt: comment.updated_at || '',
      url: '',
      author: null,
    }));
  }

  reports(id) {
    return this.comments(id);
  }

  complete(id, input = {}) {
    const outcome = input.outcome ?? 'done';
    if (!['done', 'rejected'].includes(outcome)) {
      throw new TaskBackendError('completion outcome must be done or rejected', {
        code: 'invalid-input',
      });
    }
    return this.update(id, { status: outcome });
  }

  reopen(id) {
    return this.update(id, { status: 'open' });
  }

  async remove(id) {
    await this.nativeTask(id);
    await this.request('DELETE', `/tasks/${encodeURIComponent(id)}`);
    return { taskId: String(id), deleted: true };
  }
}

export {
  descriptionWithMetadata,
  metadataFrom,
  parseCredentialFile,
};
