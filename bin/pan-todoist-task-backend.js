import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { TaskBackendError } from './pan-task-backend.js';

const METADATA_RE = /(?:\n\n)?<!-- pan-task:v1\n([\s\S]*?)\n-->\s*$/;
const PRIORITY_TO_NATIVE = { low: 1, normal: 2, high: 3, urgent: 4 };
const NATIVE_TO_PRIORITY = { 1: 'low', 2: 'normal', 3: 'high', 4: 'urgent' };
export const ATTENTION_LIFECYCLE_MODE = 'attention-labels-v1';
export const DEFAULT_ATTENTION_LABELS = Object.freeze({
  requested: 'AI Attention Requested',
  open: 'AI Session Open',
  needsHelp: 'AI Needs Help',
  externalWaiting: 'External Waiting',
  onHold: 'On Hold',
  rejected: 'Rejected',
});
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
  if (Object.keys(metadata).length === 0) return body;
  const block = `<!-- pan-task:v1\n${JSON.stringify(metadata)}\n-->`;
  return body ? `${body}\n\n${block}` : block;
}

function attentionLabels(config) {
  const configured = config.attentionLabels ?? {};
  const labels = { ...DEFAULT_ATTENTION_LABELS, ...configured };
  const values = Object.values(labels);
  if (values.some((value) => typeof value !== 'string' || !value.trim())) {
    throw new TaskBackendError('attentionLabels values must be non-empty strings', {
      code: 'invalid-config',
    });
  }
  if (new Set(values).size !== values.length) {
    throw new TaskBackendError('attentionLabels values must be unique', {
      code: 'invalid-config',
    });
  }
  return labels;
}

function attentionStateFromTask(task, config) {
  const labels = attentionLabels(config);
  const matches = Object.entries(labels)
    .filter(([, label]) => (task.labels ?? []).includes(label));
  if (matches.length > 1) {
    throw new TaskBackendError(
      `task ${task.id} has conflicting Pan status labels: ${matches.map(([, label]) => label).join(', ')}`,
      { code: 'conflicting-status-labels', details: { taskId: String(task.id) } },
    );
  }
  const completed = task.checked === true
    || task.completed === true
    || task.is_completed === true;
  if (completed) {
    if (matches.length === 0) return 'done';
    if (matches[0][0] === 'rejected') return 'rejected';
    throw new TaskBackendError(
      `completed task ${task.id} has nonterminal Pan status label ${matches[0][1]}`,
      { code: 'invalid-terminal-label', details: { taskId: String(task.id) } },
    );
  }
  if (matches.length === 1) {
    if (matches[0][0] === 'rejected') {
      throw new TaskBackendError(
        `active task ${task.id} cannot carry the Rejected status label`,
        { code: 'invalid-terminal-label', details: { taskId: String(task.id) } },
      );
    }
    return matches[0][0];
  }
  const inboxProjectId = String(config.inboxProjectId ?? '');
  return inboxProjectId && String(task.project_id) === inboxProjectId ? 'inbox' : 'human';
}

function labelsForAttentionState(nativeLabels, state, config) {
  const labels = attentionLabels(config);
  const recognized = new Set(Object.values(labels));
  const unrelated = (nativeLabels ?? []).filter((label) => !recognized.has(label));
  if (state === 'none' || state === 'human' || state === 'inbox') return unrelated;
  if (!labels[state]) {
    throw new TaskBackendError(`unsupported attention state: ${state}`, {
      code: 'invalid-input',
    });
  }
  return [...unrelated, labels[state]];
}

function associationFromMetadata(metadata) {
  const sessionId = String(metadata.sessionId ?? '').trim();
  const machineId = String(metadata.machineId ?? '').trim();
  if ((sessionId && !machineId) || (!sessionId && machineId)) {
    throw new TaskBackendError('task has a partial Pan session association', {
      code: 'invalid-association',
    });
  }
  return sessionId ? { sessionId, machineId } : null;
}

function assertObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TaskBackendError(`${name} must be an object`, { code: 'invalid-input' });
  }
}

export class TodoistTaskBackend {
  constructor(config, { fetchImpl = globalThis.fetch, readFileImpl = readFile } = {}) {
    assertObject(config, 'backend config');
    this.config = config;
    this.fetch = fetchImpl;
    this.readFile = readFileImpl;
    this.baseUrl = String(config.baseUrl || 'https://api.todoist.com/api/v1').replace(/\/$/, '');
    this.lifecycleMode = config.lifecycleMode || 'legacy-metadata-v1';
    this.labels = attentionLabels(config);
    this.user = null;
    this.token = null;
    this.supportsIdempotentCreate = true;
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
    if (this.lifecycleMode === ATTENTION_LIFECYCLE_MODE) {
      const attentionState = attentionStateFromTask(task, this.config);
      const association = associationFromMetadata(metadata);
      return {
        id: String(task.id),
        backend: 'todoist',
        lifecycleMode: ATTENTION_LIFECYCLE_MODE,
        url: `https://todoist.com/showTask?id=${encodeURIComponent(task.id)}`,
        title: task.content,
        description: parsed.description,
        status: attentionState,
        attentionState,
        priority: NATIVE_TO_PRIORITY[task.priority] || 'normal',
        nextActionDate: task.due?.date || '',
        deadline: task.deadline?.date || '',
        sessionId: association?.sessionId || '',
        machineId: association?.machineId || '',
        association,
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
    return this.canonical(await this.nativeTask(id));
  }

  async nativeTask(id) {
    const task = await this.request('GET', `/tasks/${encodeURIComponent(id)}`);
    if (!this.inScope(task)) {
      throw new TaskBackendError(`task ${id} is outside the configured scope`, {
        code: 'out-of-scope',
        status: 403,
      });
    }

    return task;
  }

  async validateAttentionLabels() {
    const available = new Set();
    let cursor = null;
    do {
      const query = new URLSearchParams({ limit: '200' });
      if (cursor) query.set('cursor', cursor);
      const page = await this.request('GET', `/labels?${query}`);
      const results = Array.isArray(page) ? page : (page.results ?? []);
      for (const label of results) available.add(String(label.name));
      cursor = Array.isArray(page) ? null : (page.next_cursor ?? null);
    } while (cursor);
    const missing = Object.values(this.labels).filter((label) => !available.has(label));
    if (missing.length) {
      throw new TaskBackendError(
        `Todoist is missing required exact labels: ${missing.join(', ')}`,
        { code: 'missing-status-labels', details: { missing } },
      );
    }
    return { labels: { ...this.labels } };
  }

  async create(input) {
    assertObject(input, 'create input');
    if (!String(input.title || '').trim()) {
      throw new TaskBackendError('title is required', { code: 'invalid-input' });
    }
    const attentionMode = this.lifecycleMode === ATTENTION_LIFECYCLE_MODE;
    const metadata = attentionMode ? {} : {
        status: input.status || 'untriaged',
        nextAction: input.nextAction || '',
        nextActionDetail: input.nextActionDetail || '',
        playbook: input.playbook || '',
        workstream: input.workstream || '',
        executionAuthorized: input.executionAuthorized === true,
        dependencies: input.dependencies ?? [],
      };
    const projectId = input.projectId || this.config.createProjectId;
    if (attentionMode && !projectId) {
      throw new TaskBackendError(
        'attention lifecycle task creation requires an explicitly configured project',
        { code: 'project-required' },
      );
    }
    if (
      attentionMode
      && String(projectId) === String(this.config.inboxProjectId || '')
    ) {
      throw new TaskBackendError(
        'attention lifecycle task creation requires a named project outside Inbox',
        { code: 'project-required' },
      );
    }
    const body = {
      content: String(input.title).trim(),
      description: descriptionWithMetadata(input.description || '', metadata),
      priority: PRIORITY_TO_NATIVE[input.priority || 'normal'] ?? 2,
      ...(projectId
        ? { project_id: String(projectId) }
        : {}),
      ...(input.nextActionDate ? { due_date: input.nextActionDate } : {}),
      ...(input.deadline ? { deadline_date: input.deadline } : {}),
    };
    const idempotencyKey = String(input.idempotencyKey || '').trim();
    if (
      idempotencyKey
      && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
        .test(idempotencyKey)
    ) {
      throw new TaskBackendError('idempotencyKey must be a UUID', { code: 'invalid-input' });
    }
    const created = await this.request(
      'POST',
      '/tasks',
      body,
      idempotencyKey ? { 'X-Request-Id': idempotencyKey } : {},
    );
    if (!this.inScope(created)) {
      throw new TaskBackendError(
        `created task ${created.id} is outside the configured scope; inspect it manually`,
        { code: 'partial-write', details: { taskId: String(created.id) } },
      );
    }
    return this.canonical(created);
  }

  async validateProject(projectId) {
    if (typeof projectId !== 'string' || !projectId.trim()) {
      throw new TaskBackendError('projectId is required', { code: 'invalid-input' });
    }
    const allowed = this.config.scope?.projectIds ?? [];
    if (allowed.length && !allowed.map(String).includes(projectId)) {
      throw new TaskBackendError('destination project is outside configured scope', { code: 'out-of-scope' });
    }
    const project = await this.request('GET', `/projects/${encodeURIComponent(projectId)}`);
    if (String(project.id) !== projectId || project.is_archived || project.is_deleted) {
      throw new TaskBackendError('destination project is unavailable', { code: 'invalid-input' });
    }
    return project;
  }

  async move(id, input) {
    assertObject(input, 'move input');
    await this.validateProject(input.projectId);
    const current = await this.get(id);
    if (!input.expectedRevision || current.revision !== input.expectedRevision) {
      throw new TaskBackendError('task changed before project move', { code: 'revision-conflict' });
    }
    await this.request('POST', `/tasks/${encodeURIComponent(id)}/move`, { project_id: input.projectId });
    const moved = await this.get(id);
    if (moved.projectId !== input.projectId) {
      throw new TaskBackendError('project move did not verify', {
        code: 'partial-write', details: { taskId: String(id) },
      });
    }
    return moved;
  }

  async update(id, input) {
    assertObject(input, 'update input');
    const native = await this.nativeTask(id);
    const current = this.canonical(native);
    if (input.expectedRevision && input.expectedRevision !== current.revision) {
      throw new TaskBackendError(`task ${id} changed since it was read`, {
        code: 'revision-conflict',
        status: 409,
        details: { expected: input.expectedRevision, actual: current.revision },
      });
    }
    if (native.due?.is_recurring && input.nextActionDate === '') {
      throw new TaskBackendError(
        'a recurring task cannot be unscheduled without removing its native recurrence',
        { code: 'unsupported-mapping' },
      );
    }
    const parsed = metadataFrom(native.description || '');
    if (this.lifecycleMode === ATTENTION_LIFECYCLE_MODE) {
      const legacyFields = [
        'status', 'nextAction', 'nextActionDetail', 'playbook', 'workstream',
        'executionAuthorized', 'dependencies', 'worker',
      ].filter((key) => input[key] !== undefined);
      if (legacyFields.length) {
        throw new TaskBackendError(
          `attention lifecycle does not accept legacy fields: ${legacyFields.join(', ')}`,
          { code: 'legacy-field-disabled' },
        );
      }
      if (input.attentionState === 'rejected') {
        throw new TaskBackendError(
          'Rejected may be written only by complete with outcome=rejected',
          { code: 'invalid-terminal-transition' },
        );
      }
      const association = input.association === undefined
        ? associationFromMetadata(parsed.metadata)
        : input.association;
      if (association != null) {
        assertObject(association, 'association');
        if (!String(association.sessionId || '').trim() || !String(association.machineId || '').trim()) {
          throw new TaskBackendError('association requires sessionId and machineId', {
            code: 'invalid-association',
          });
        }
      }
      const metadata = association
        ? { sessionId: association.sessionId, machineId: association.machineId }
        : {};
      const body = {
        ...(input.title === undefined ? {} : { content: String(input.title).trim() }),
        description: descriptionWithMetadata(
          input.description === undefined ? parsed.description : input.description,
          metadata,
        ),
        ...(input.attentionState === undefined ? {} : {
          labels: labelsForAttentionState(native.labels, input.attentionState, this.config),
        }),
        ...(input.priority === undefined ? {} : { priority: PRIORITY_TO_NATIVE[input.priority] }),
        ...(input.nextActionDate === undefined || native.due?.is_recurring
          ? {}
          : input.nextActionDate ? { due_date: input.nextActionDate } : { due_string: 'no date' }),
        ...(input.deadline === undefined
          ? {}
          : input.deadline ? { deadline_date: input.deadline } : { deadline_date: null }),
      };
      if (body.priority === undefined && input.priority !== undefined) {
        throw new TaskBackendError(`unsupported priority: ${input.priority}`, {
          code: 'invalid-input',
        });
      }
      let updated = await this.request('POST', `/tasks/${encodeURIComponent(id)}`, body);
      if (native.due?.is_recurring && input.nextActionDate !== undefined) {
        const uuid = randomUUID();
        const form = new URLSearchParams({
          sync_token: '*',
          resource_types: '[]',
          commands: JSON.stringify([{
            type: 'item_update',
            uuid,
            args: {
              id: String(id),
              due: { ...native.due, date: input.nextActionDate },
            },
          }]),
        });
        const response = await this.fetch(`${this.baseUrl}/sync`, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer '.concat(this.token),
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: form,
        });
        const result = await response.json().catch(() => null);
        if (!response.ok || result?.sync_status?.[uuid] !== 'ok') {
          throw new TaskBackendError(
            `Todoist recurring date update failed${response.ok ? '' : ` with HTTP ${response.status}`}`,
            {
              code: 'partial-write',
              status: response.ok ? null : response.status,
              details: {
                completedOperation: 'task metadata update',
                failedOperation: 'recurring native due-date update',
                response: result,
              },
            },
          );
        }
        updated = await this.nativeTask(id);
      }
      return this.canonical(updated);
    }
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
      ...(input.nextActionDate === undefined || native.due?.is_recurring
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
    let updated = await this.request('POST', `/tasks/${encodeURIComponent(id)}`, body);
    if (native.due?.is_recurring && input.nextActionDate !== undefined) {
      const uuid = randomUUID();
      const form = new URLSearchParams({
        sync_token: '*',
        resource_types: '[]',
        commands: JSON.stringify([{
          type: 'item_update',
          uuid,
          args: {
            id: String(id),
            due: {
              ...native.due,
              date: input.nextActionDate,
            },
          },
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
        throw new TaskBackendError(
          `Todoist recurring date update failed${response.ok ? '' : ` with HTTP ${response.status}`}`,
          {
            code: 'partial-write',
            status: response.ok ? null : response.status,
            details: {
              completedOperation: 'task metadata update',
              failedOperation: 'recurring native due-date update',
              response: result,
            },
          },
        );
      }
      updated = await this.nativeTask(id);
    }
    return this.canonical(updated);
  }

  async report(id, input) {
    assertObject(input, 'report input');
    if (!String(input.content || '').trim()) {
      throw new TaskBackendError('report content is required', { code: 'invalid-input' });
    }
    const task = await this.get(id);
    if (this.lifecycleMode === ATTENTION_LIFECYCLE_MODE) {
      const hasSessionExpectation = input.expectedSessionId !== undefined
        || input.expectedMachineId !== undefined;
      if (hasSessionExpectation) {
        if (
          !String(input.expectedSessionId || '').trim()
          || !String(input.expectedMachineId || '').trim()
        ) {
          throw new TaskBackendError(
            'session-bound report requires expectedSessionId and expectedMachineId',
            { code: 'invalid-input' },
          );
        }
        if (
          task.sessionId !== input.expectedSessionId
          || task.machineId !== input.expectedMachineId
        ) {
          throw new TaskBackendError('task session association changed before report', {
            code: 'session-conflict',
            status: 409,
            details: {
              expectedSessionId: input.expectedSessionId,
              expectedMachineId: input.expectedMachineId,
              actualSessionId: task.sessionId,
              actualMachineId: task.machineId,
            },
          });
        }
      } else if (!['chief', 'migration'].includes(input.actor)) {
        throw new TaskBackendError(
          'attention report requires a session expectation or actor=chief|migration',
          { code: 'report-scope-required' },
        );
      }
    }
    const comment = await this.request('POST', '/comments', {
      task_id: String(id),
      content: String(input.content).trim(),
    });
    return { taskId: String(id), commentId: String(comment.id), recorded: true };
  }

  async reports(id) {
    await this.nativeTask(id);
    const reports = [];
    let cursor = null;
    do {
      const query = new URLSearchParams({ task_id: String(id), limit: '100' });
      if (cursor) query.set('cursor', cursor);
      const page = await this.request('GET', `/comments?${query}`);
      const results = Array.isArray(page) ? page : (page.results ?? []);
      reports.push(...results.map((comment) => ({
        id: String(comment.id),
        taskId: String(id),
        content: comment.content,
        postedAt: comment.posted_at || comment.added_at || '',
      })));
      cursor = Array.isArray(page) ? null : (page.next_cursor ?? null);
    } while (cursor);
    return reports;
  }

  async complete(id, input = {}) {
    assertObject(input, 'complete input');
    const outcome = input.outcome || 'done';
    if (
      this.lifecycleMode === ATTENTION_LIFECYCLE_MODE
      && !['done', 'rejected'].includes(outcome)
    ) {
      throw new TaskBackendError('completion outcome must be done or rejected', {
        code: 'invalid-input',
      });
    }
    let current;
    let nativeTask = null;
    let rejectedAlready = false;
    if (this.lifecycleMode === ATTENTION_LIFECYCLE_MODE) {
      const native = await this.nativeTask(id);
      nativeTask = native;
      const recognizedLabels = Object.values(this.labels)
        .filter((label) => (native.labels ?? []).includes(label));
      if (recognizedLabels.length > 1) {
        throw new TaskBackendError(
          `task ${native.id} has conflicting Pan status labels: ${recognizedLabels.join(', ')}`,
          { code: 'conflicting-status-labels', details: { taskId: String(native.id) } },
        );
      }
      rejectedAlready = (native.labels ?? []).includes(this.labels.rejected);
      if (rejectedAlready && outcome !== 'rejected') {
        throw new TaskBackendError('active Rejected task can only resume rejected completion', {
          code: 'invalid-terminal-transition',
        });
      }
      current = rejectedAlready ? {
        revision: native.updated_at || native.added_at || '',
        native: { labels: native.labels ?? [] },
      } : this.canonical(native);
    } else {
      current = await this.get(id);
    }
    if (input.expectedRevision && input.expectedRevision !== current.revision) {
      throw new TaskBackendError(`task ${id} changed since it was read`, {
        code: 'revision-conflict',
        status: 409,
        details: { expected: input.expectedRevision, actual: current.revision },
      });
    }
    let completionRevision = current.revision;
    if (this.lifecycleMode === ATTENTION_LIFECYCLE_MODE) {
      if (!rejectedAlready) {
        const updated = await this.request('POST', `/tasks/${encodeURIComponent(id)}`, {
          labels: labelsForAttentionState(
            current.native.labels,
            outcome === 'rejected' ? 'rejected' : 'none',
            this.config,
          ),
        });
        nativeTask = updated;
        completionRevision = updated.updated_at || updated.added_at || completionRevision;
      }
    }
    try {
      await this.request('POST', `/tasks/${encodeURIComponent(id)}/close`);
    } catch (error) {
      if (this.lifecycleMode === ATTENTION_LIFECYCLE_MODE) {
        throw new TaskBackendError(`task labels updated but completion failed: ${error.message}`, {
          code: 'partial-write',
          details: { taskId: String(id), retryExpectedRevision: completionRevision },
        });
      }
      throw error;
    }
    if (this.lifecycleMode === ATTENTION_LIFECYCLE_MODE) {
      return this.canonical({
        ...nativeTask,
        checked: true,
        completed: true,
      });
    }
    return {
      ...current,
      status: outcome,
      revision: completionRevision,
    };
  }

  async remove(id) {
    await this.get(id);
    await this.request('DELETE', `/tasks/${encodeURIComponent(id)}`);
    return { taskId: String(id), deleted: true };
  }

  planAttentionMigration(task, { requestAttention = false } = {}) {
    const native = task.nativeTask ?? task;
    const parsed = metadataFrom(native.description || '');
    const metadata = parsed.metadata;
    const worker = metadata.worker && typeof metadata.worker === 'object' ? metadata.worker : null;
    const workerTuple = {
      sessionId: String(worker?.sessionId || '').trim(),
      machineId: String(worker?.machine || '').trim(),
    };
    const topTuple = {
      sessionId: String(metadata.sessionId || '').trim(),
      machineId: String(metadata.machineId || '').trim(),
    };
    const partial = (tuple) => Boolean(tuple.sessionId) !== Boolean(tuple.machineId);
    if (partial(workerTuple) || partial(topTuple)) {
      return {
        id: String(native.id),
        action: 'conflict',
        reason: 'partial legacy or attention session association',
      };
    }
    const workerComplete = Boolean(workerTuple.sessionId);
    const topComplete = Boolean(topTuple.sessionId);
    if (
      workerComplete
      && topComplete
      && (
        workerTuple.sessionId !== topTuple.sessionId
        || workerTuple.machineId !== topTuple.machineId
      )
    ) {
      return {
        id: String(native.id),
        action: 'conflict',
        reason: 'legacy worker and attention session associations differ',
      };
    }
    const association = workerComplete ? workerTuple : topComplete ? topTuple : null;
    const sessionId = association?.sessionId || '';
    const machineId = association?.machineId || '';
    const recognizedEntries = Object.entries(this.labels).filter(([, label]) =>
      (native.labels ?? []).includes(label));
    if (recognizedEntries.length > 1) {
      return { id: String(native.id), action: 'conflict', reason: 'conflicting status labels' };
    }
    if (metadata.status === 'done' || metadata.status === 'rejected') {
      return {
        id: String(native.id),
        action: 'conflict',
        reason: `active Todoist task has terminal legacy status ${metadata.status}`,
      };
    }
    if (recognizedEntries[0]?.[0] === 'rejected') {
      return {
        id: String(native.id),
        action: 'conflict',
        reason: 'active Todoist task has Rejected status label',
      };
    }
    const workerState = String(worker?.state || '').trim();
    if (workerState && !['idle', 'released', 'stopped', 'unexpected-stop'].includes(workerState)) {
      return {
        id: String(native.id),
        action: 'conflict',
        reason: `legacy worker state ${workerState} requires release or reconciliation`,
      };
    }
    let attentionState = recognizedEntries[0]?.[0] || 'none';
    if (recognizedEntries.length === 0) {
      if (workerState === 'unexpected-stop') {
        attentionState = 'needsHelp';
      } else if (
        association
        && metadata.status === 'ready-for-human'
        && ['clarify', 'discuss', 'approve', 'review'].includes(metadata.nextAction)
      ) {
        attentionState = 'needsHelp';
      } else if (metadata.status === 'external-waiting') {
        attentionState = 'externalWaiting';
      } else if (metadata.status === 'deliberate-hold') {
        attentionState = 'onHold';
      } else if (requestAttention) {
        attentionState = 'requested';
      }
    }
    const keptMetadata = {};
    if (sessionId) {
      keptMetadata.sessionId = sessionId;
      keptMetadata.machineId = machineId;
    }
    const labelsAfter = labelsForAttentionState(native.labels, attentionState, this.config);
    const sameLabels = labelsAfter.length === (native.labels ?? []).length
      && labelsAfter.every((label) => (native.labels ?? []).includes(label));
    const metadataUnchanged = JSON.stringify(keptMetadata) === JSON.stringify(metadata);
    const nextActionDetail = String(metadata.nextActionDetail || '').trim();
    const checkpointReport = nextActionDetail
      ? [
          `Pan migration checkpoint: ${native.id}`,
          '',
          `Legacy state: ${metadata.status || 'untriaged'}`,
          `Legacy action: ${metadata.nextAction || '(none)'}`,
          `Detail: ${nextActionDetail}`,
          '',
          association
            ? 'Continue this task in its associated worker session when applicable.'
            : 'This note preserves the pre-migration next-step instruction.',
        ].join('\n')
      : null;
    return {
      id: String(native.id),
      action: metadataUnchanged && sameLabels
        ? 'already-migrated'
        : 'migrate',
      expectedRevision: native.updated_at || native.added_at || '',
      attentionState,
      association: sessionId ? { sessionId, machineId } : null,
      labelsBefore: native.labels ?? [],
      labelsAfter,
      metadataBefore: metadata,
      metadataAfter: keptMetadata,
      checkpointReport,
      warning: metadata.status === 'ready-for-ai' && !requestAttention
        ? 'legacy readiness was not converted into an attention request'
        : null,
    };
  }

  async migrateAttentionTask(plan) {
    if (plan.action !== 'migrate') {
      throw new TaskBackendError('only migrate actions can be applied', { code: 'invalid-input' });
    }
    const native = await this.nativeTask(plan.id);
    const revision = native.updated_at || native.added_at || '';
    if (revision !== plan.expectedRevision) {
      throw new TaskBackendError(`task ${plan.id} changed since preview`, {
        code: 'revision-conflict',
      });
    }
    if (plan.checkpointReport) {
      const reports = await this.reports(plan.id);
      if (!reports.some((report) => report.content === plan.checkpointReport)) {
        await this.report(plan.id, { actor: 'migration', content: plan.checkpointReport });
      }
    }
    const parsed = metadataFrom(native.description || '');
    const updated = await this.request('POST', `/tasks/${encodeURIComponent(plan.id)}`, {
      description: descriptionWithMetadata(parsed.description, plan.metadataAfter),
      labels: plan.labelsAfter,
    });
    const priorMode = this.lifecycleMode;
    this.lifecycleMode = ATTENTION_LIFECYCLE_MODE;
    try {
      return this.canonical(updated);
    } finally {
      this.lifecycleMode = priorMode;
    }
  }
}

export {
  attentionStateFromTask,
  descriptionWithMetadata,
  labelsForAttentionState,
  metadataFrom,
  parseCredentialFile,
};
