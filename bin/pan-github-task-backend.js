import { TaskBackendError } from './pan-task-backend.js';
import {
  GitHubTaskStore,
  loadTaskServiceBinding,
} from './pan-github-task-store.js';

const HUMAN_ACTIONS = new Set(['clarify', 'discuss', 'approve', 'review', 'act']);
const TERMINAL_OUTCOMES = new Set(['done', 'rejected']);

function assertObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TaskBackendError(`${name} must be an object`, { code: 'invalid-input' });
  }
}

function dependencies(value) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  return String(value ?? '')
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function dependencyText(value) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean).join('\n');
  return String(value ?? '');
}

function canonicalTask(task, position = null) {
  const workerState = task.workerState || '';
  const sessionId = task.sessionId || '';
  const machineId = task.machine || '';
  const worker = sessionId || machineId || workerState
    ? {
        state: workerState,
        sessionId,
        machine: machineId,
        claimedBy: task.claimedBy || '',
        leaseUntil: task.leaseUntil || '',
        claimGeneration: task.claimGeneration || '',
      }
    : null;
  return {
    id: task.id,
    backend: 'github',
    lifecycleMode: 'outcome-v1',
    itemId: task.itemId,
    position,
    number: task.number,
    repo: task.repo,
    url: task.url,
    title: task.title,
    description: task.details ?? '',
    status: task.status,
    nextAction: task.nextAction,
    nextActionDetail: task.nextActionDetail,
    priority: task.priority,
    nextActionDate: task.nextActionDate,
    deadline: task.deadline,
    playbook: task.playbook,
    workstream: task.workstream,
    executionAuthorized: task.executionAuthorized === 'yes',
    dependencies: dependencies(task.dependencies),
    worker,
    workerState,
    needsHumanSince: task.needsHumanSince || '',
    claimedBy: task.claimedBy || '',
    leaseUntil: task.leaseUntil || '',
    sessionId,
    machineId,
    claimGeneration: task.claimGeneration || '',
    resourceSemantics: task.resourceSemantics || '',
    recurring: task.recurring === true,
    revision: task.revision,
    projection: task.projection,
    issueState: task.issueState,
    issueStateReason: task.issueStateReason,
    updatedAt: task.updatedAt,
    createdAt: task.createdAt,
    closedAt: task.closedAt,
    overdue: task.overdue === true,
    primaryView: task.primaryView,
    bodyConflict: task.bodyConflict || null,
    comments: task.comments,
    artifacts: task.artifacts,
  };
}

function backendError(error) {
  if (error instanceof TaskBackendError) return error;
  return new TaskBackendError(error.message, {
    code: error.code
      || (error.statusCode === 409 ? 'revision-conflict' : 'github-backend-error'),
    status: error.statusCode ?? null,
    details: error.details ?? null,
  });
}

function partialCreateError(error, created) {
  const failure = backendError(error);
  const details = failure.details && typeof failure.details === 'object'
    ? failure.details
    : {};
  return Object.assign(
    new TaskBackendError(
      `${failure.message} Issue creation was confirmed at ${created.url}; ` +
      'do not retry task creation blindly.',
      {
        code: 'partial-write',
        status: failure.status,
        details: {
          ...details,
          taskId: created.id,
          issueUrl: created.url,
          issueNumber: created.number,
          projectItemId: created.itemId ?? null,
          projectItemCreated: Boolean(created.itemId),
        },
      },
    ),
    { cause: error },
  );
}

export class GitHubTaskBackend {
  constructor(config, dependencies = {}) {
    assertObject(config, 'backend config');
    this.config = config;
    this.dependencies = dependencies;
    this.store = dependencies.store ?? null;
    this.lifecycleMode = 'outcome-v1';
    this.supportsIdempotentCreate = false;
  }

  async initialize() {
    if (this.store) {
      if (typeof this.store.initialize === 'function') await this.store.initialize();
      return this;
    }
    const bindingConfig = String(this.config.bindingConfig || '').trim();
    const panCheckout = String(this.config.panCheckout || '').trim();
    if (!bindingConfig || !panCheckout) {
      throw new TaskBackendError(
        'GitHub backend requires absolute bindingConfig and panCheckout paths',
        { code: 'invalid-config' },
      );
    }
    const binding = await loadTaskServiceBinding(bindingConfig, panCheckout);
    this.store = new GitHubTaskStore(binding, this.dependencies);
    await this.store.initialize();
    return this;
  }

  async list() {
    try {
      const snapshot = await this.store.list();
      return snapshot.tasks.map((task, position) => canonicalTask(task, position));
    } catch (error) {
      throw backendError(error);
    }
  }

  async get(id) {
    try {
      return canonicalTask(await this.store.detail(String(id)));
    } catch (error) {
      throw backendError(error);
    }
  }

  async create(input) {
    assertObject(input, 'create input');
    if (input.idempotencyKey) {
      throw new TaskBackendError(
        'GitHub task creation does not yet provide idempotent source-intake retries',
        { code: 'idempotency-unsupported' },
      );
    }
    let created;
    try {
      created = canonicalTask(await this.store.capture({
        title: input.title,
        details: input.description ?? '',
        priority: input.priority,
        nextActionDate: input.nextActionDate,
        deadline: input.deadline,
        workstream: input.workstream,
        recurrence: input.recurrence,
        currentActionDetail: input.nextActionDetail,
      }));
    } catch (error) {
      throw backendError(error);
    }
    try {
      const requested = {
        title: input.title,
        description: input.description,
        status: input.status,
        nextAction: input.nextAction,
        nextActionDetail: input.nextActionDetail,
        priority: input.priority,
        nextActionDate: input.nextActionDate,
        deadline: input.deadline,
        playbook: input.playbook,
        workstream: input.workstream,
        executionAuthorized: input.executionAuthorized,
        dependencies: input.dependencies,
      };
      const needsFollowup = Object.entries(requested).some(
        ([key, value]) => value !== undefined && value !== created[key],
      );
      if (needsFollowup) {
        created = await this.update(created.id, {
          ...requested,
          expectedRevision: created.revision,
          expectedProjection: created.projection,
        });
      }
      return created;
    } catch (error) {
      throw partialCreateError(error, created);
    }
  }

  async update(id, input) {
    assertObject(input, 'update input');
    let current = await this.get(id);
    if (
      input.expectedRevision !== undefined
      && String(input.expectedRevision) !== String(current.revision)
    ) {
      throw new TaskBackendError(`task ${id} changed since it was read`, {
        code: 'revision-conflict',
        status: 409,
        details: { expected: input.expectedRevision, actual: current.revision },
      });
    }
    if (
      input.expectedProjection !== undefined
      && input.expectedProjection !== current.projection
    ) {
      throw new TaskBackendError(`task ${id} projection changed since it was read`, {
        code: 'revision-conflict',
        status: 409,
      });
    }
    if (input.association !== undefined) {
      const association = input.association;
      if (
        association == null
        || association.sessionId !== current.sessionId
        || association.machineId !== current.machineId
      ) {
        throw new TaskBackendError(
          'GitHub session affinity is owned by the runner and cannot be reassigned through a generic task update',
          { code: 'session-operation-required', status: 409 },
        );
      }
    }

    const editChanges = {};
    for (const [inputName, storeName] of [
      ['title', 'title'],
      ['description', 'details'],
      ['priority', 'priority'],
      ['nextActionDate', 'nextActionDate'],
      ['deadline', 'deadline'],
      ['playbook', 'playbook'],
      ['workstream', 'workstream'],
    ]) {
      if (input[inputName] !== undefined && input[inputName] !== current[inputName]) {
        editChanges[storeName] = input[inputName];
      }
    }
    if (
      input.executionAuthorized !== undefined
      && Boolean(input.executionAuthorized) !== current.executionAuthorized
    ) {
      editChanges.executionAuthorized = input.executionAuthorized ? 'yes' : 'no';
    }
    if (input.dependencies !== undefined) {
      const value = dependencyText(input.dependencies);
      if (value !== dependencyText(current.dependencies)) editChanges.dependencies = value;
    }
    if (
      input.nextActionDetail !== undefined
      && input.nextActionDetail !== current.nextActionDetail
      && input.status === undefined
      && input.nextAction === undefined
    ) {
      editChanges.currentActionDetail = input.nextActionDetail;
    }
    if (Object.keys(editChanges).length) {
      try {
        current = canonicalTask(await this.store.mutate({
          itemId: current.itemId,
          revision: current.revision,
          projection: current.projection,
          operation: 'edit',
          changes: editChanges,
        }));
      } catch (error) {
        throw backendError(error);
      }
    }

    const status = input.status ?? current.status;
    const nextAction = input.nextAction ?? current.nextAction;
    if (status !== current.status || nextAction !== current.nextAction) {
      const detail = input.nextActionDetail || current.nextActionDetail;
      let action;
      if (status === 'ready-for-human' && HUMAN_ACTIONS.has(nextAction)) {
        action = { operation: 'handoff-human', action: nextAction, detail };
      } else if (status === 'ready-for-ai' && nextAction === 'execute') {
        action = { operation: 'handoff-ai', detail };
      } else if (status === 'external-waiting' && nextAction === 'wait') {
        action = { operation: 'external-wait', detail };
      } else if (status === 'deliberate-hold' && nextAction === 'hold') {
        action = { operation: 'hold', detail };
      } else if (TERMINAL_OUTCOMES.has(status) && nextAction === 'none') {
        return this.complete(id, {
          expectedRevision: current.revision,
          expectedProjection: current.projection,
          outcome: status,
          detail,
        });
      } else {
        throw new TaskBackendError(
          `unsupported GitHub lifecycle transition to ${status}/${nextAction}`,
          { code: 'invalid-input' },
        );
      }
      try {
        current = canonicalTask(await this.store.mutate({
          itemId: current.itemId,
          revision: current.revision,
          projection: current.projection,
          ...action,
        }));
      } catch (error) {
        throw backendError(error);
      }
    }
    return current;
  }

  async report(id, input) {
    assertObject(input, 'report input');
    if (!String(input.content || '').trim()) {
      throw new TaskBackendError('report content is required', { code: 'invalid-input' });
    }
    try {
      return await this.store.report(String(id), input);
    } catch (error) {
      throw backendError(error);
    }
  }

  async reports(id) {
    try {
      return await this.store.reports(String(id));
    } catch (error) {
      throw backendError(error);
    }
  }

  async complete(id, input = {}) {
    assertObject(input, 'complete input');
    const current = await this.get(id);
    if (
      input.expectedRevision !== undefined
      && String(input.expectedRevision) !== String(current.revision)
    ) {
      throw new TaskBackendError(`task ${id} changed since it was read`, {
        code: 'revision-conflict',
        status: 409,
      });
    }
    if (
      input.expectedProjection !== undefined
      && input.expectedProjection !== current.projection
    ) {
      throw new TaskBackendError(`task ${id} projection changed since it was read`, {
        code: 'revision-conflict',
        status: 409,
      });
    }
    const outcome = input.outcome || 'done';
    if (!TERMINAL_OUTCOMES.has(outcome)) {
      throw new TaskBackendError('completion outcome must be done or rejected', {
        code: 'invalid-input',
      });
    }
    try {
      return canonicalTask(await this.store.mutate({
        itemId: current.itemId,
        revision: current.revision,
        projection: current.projection,
        operation: outcome === 'rejected' ? 'reject' : 'finish',
        detail: input.detail,
      }));
    } catch (error) {
      throw backendError(error);
    }
  }

  async remove() {
    throw new TaskBackendError(
      'GitHub Issues are retained as task history; reject the outcome instead of deleting it',
      { code: 'unsupported-mapping' },
    );
  }
}
