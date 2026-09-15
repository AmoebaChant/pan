import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTaskBackend } from '../bin/pan-task-backend.js';
import { GitHubTaskBackend } from '../bin/pan-github-task-backend.js';

function fixture(overrides = {}) {
  return {
    id: 'item-1',
    itemId: 'item-1',
    number: 1,
    repo: 'example/domain',
    title: 'Prepare rollout',
    url: 'https://github.com/example/domain/issues/1',
    issueState: 'OPEN',
    issueStateReason: null,
    status: 'ready-for-human',
    nextAction: 'clarify',
    nextActionDetail: 'Clarify the rollout audience.',
    priority: 'normal',
    nextActionDate: '',
    deadline: '',
    playbook: '',
    workstream: '',
    executionAuthorized: 'no',
    dependencies: '',
    workerState: 'checkpointed',
    needsHumanSince: '2026-09-14T00:00:00Z',
    claimedBy: '',
    leaseUntil: '',
    machine: 'machine-a',
    sessionId: 'session-a',
    claimGeneration: 'generation-a',
    resourceSemantics: '',
    revision: 4,
    recurring: false,
    updatedAt: '2026-09-14T00:00:00Z',
    createdAt: '2026-09-13T00:00:00Z',
    closedAt: null,
    projection: 'projection-4',
    details: 'Roll out the validated build.',
    comments: [],
    artifacts: [],
    ...overrides,
  };
}

class FakeStore {
  constructor(task = fixture()) {
    this.task = structuredClone(task);
    this.operations = [];
    this.reportInputs = [];
  }

  async initialize() {
    return this;
  }

  async list() {
    return { tasks: [structuredClone(this.task)] };
  }

  async detail(id) {
    assert.equal(id, this.task.id);
    return structuredClone(this.task);
  }

  async capture(input) {
    this.operations.push({ operation: 'capture', input });
    this.task = fixture({
      title: input.title,
      details: input.details,
      revision: 1,
      projection: 'projection-1',
    });
    return structuredClone(this.task);
  }

  async mutate(input) {
    assert.equal(input.revision, this.task.revision);
    assert.equal(input.projection, this.task.projection);
    this.operations.push(structuredClone(input));
    if (input.operation === 'edit') {
      const changes = input.changes;
      if (changes.title !== undefined) this.task.title = changes.title;
      if (changes.details !== undefined) this.task.details = changes.details;
      if (changes.priority !== undefined) this.task.priority = changes.priority;
      if (changes.playbook !== undefined) this.task.playbook = changes.playbook;
      if (changes.workstream !== undefined) this.task.workstream = changes.workstream;
      if (changes.dependencies !== undefined) this.task.dependencies = changes.dependencies;
      if (changes.executionAuthorized !== undefined) {
        this.task.executionAuthorized = changes.executionAuthorized;
      }
      if (changes.currentActionDetail !== undefined) {
        this.task.nextActionDetail = changes.currentActionDetail;
      }
    } else if (input.operation === 'handoff-ai') {
      this.task.status = 'ready-for-ai';
      this.task.nextAction = 'execute';
      this.task.nextActionDetail = input.detail;
      this.task.executionAuthorized = 'yes';
    } else if (input.operation === 'handoff-human') {
      this.task.status = 'ready-for-human';
      this.task.nextAction = input.action;
      this.task.nextActionDetail = input.detail;
      this.task.executionAuthorized = 'no';
    } else if (input.operation === 'finish' || input.operation === 'reject') {
      this.task.status = input.operation === 'finish' ? 'done' : 'rejected';
      this.task.nextAction = 'none';
      this.task.nextActionDetail = input.detail;
      this.task.issueState = 'CLOSED';
    }
    this.task.revision += 1;
    this.task.projection = `projection-${this.task.revision}`;
    return structuredClone(this.task);
  }

  async report(id, input) {
    this.reportInputs.push({ id, input });
    return { taskId: id, commentId: 'comment-1', recorded: true };
  }

  async reports(id) {
    return [{ id: 'comment-1', taskId: id, content: 'Checkpoint recorded.' }];
  }
}

test('backend loader selects the GitHub adapter without changing Todoist selection', async () => {
  const store = new FakeStore();
  const github = await loadTaskBackend('unused.json', {
    backendConfig: { backend: 'github' },
    store,
  });
  assert.ok(github instanceof GitHubTaskBackend);
  await github.initialize();
  assert.equal((await github.list())[0].backend, 'github');

  const todoist = await loadTaskBackend('unused.json', {
    backendConfig: { backend: 'todoist' },
    fetchImpl: async () => {
      throw new Error('not initialized');
    },
  });
  assert.equal(todoist.constructor.name, 'TodoistTaskBackend');
});

test('GitHub adapter maps metadata and checked handoff through the common protocol', async () => {
  const store = new FakeStore();
  const backend = await new GitHubTaskBackend(
    { backend: 'github' },
    { store },
  ).initialize();
  const current = await backend.get('item-1');
  assert.deepEqual(current.dependencies, []);
  assert.deepEqual(current.worker, {
    state: 'checkpointed',
    sessionId: 'session-a',
    machine: 'machine-a',
    claimedBy: '',
    leaseUntil: '',
    claimGeneration: 'generation-a',
  });

  const updated = await backend.update('item-1', {
    expectedRevision: current.revision,
    expectedProjection: current.projection,
    priority: 'high',
    playbook: 'delivery',
    dependencies: [],
    status: 'ready-for-ai',
    nextAction: 'execute',
    nextActionDetail: 'Implement the approved rollout.',
  });

  assert.equal(updated.priority, 'high');
  assert.equal(updated.playbook, 'delivery');
  assert.equal(updated.status, 'ready-for-ai');
  assert.equal(updated.nextAction, 'execute');
  assert.equal(updated.executionAuthorized, true);
  assert.deepEqual(
    store.operations.map((operation) => operation.operation),
    ['edit', 'handoff-ai'],
  );
});

test('GitHub adapter creates through the checked store and rejects unsupported idempotency', async () => {
  const store = new FakeStore();
  const backend = await new GitHubTaskBackend(
    { backend: 'github' },
    { store },
  ).initialize();

  assert.equal(backend.supportsIdempotentCreate, false);
  await assert.rejects(
    backend.create({
      title: 'Duplicate-sensitive intake',
      idempotencyKey: '11111111-1111-4111-8111-111111111111',
    }),
    (error) => error.code === 'idempotency-unsupported',
  );

  const created = await backend.create({
    title: 'Prepare delivery',
    description: 'Use the approved plan.',
    priority: 'high',
    playbook: 'delivery',
    workstream: 'pan',
    status: 'ready-for-ai',
    nextAction: 'execute',
    nextActionDetail: 'Implement the approved plan.',
    executionAuthorized: true,
    dependencies: [],
  });

  assert.equal(created.title, 'Prepare delivery');
  assert.equal(created.status, 'ready-for-ai');
  assert.equal(created.playbook, 'delivery');
  assert.deepEqual(
    store.operations.map((operation) => operation.operation),
    ['capture', 'edit', 'handoff-ai'],
  );
});

test('GitHub adapter rejects stale writes and session reassignment', async () => {
  const backend = await new GitHubTaskBackend(
    { backend: 'github' },
    { store: new FakeStore() },
  ).initialize();
  await assert.rejects(
    backend.update('item-1', {
      expectedRevision: 3,
      priority: 'urgent',
    }),
    (error) => error.code === 'revision-conflict' && error.status === 409,
  );
  await assert.rejects(
    backend.update('item-1', {
      expectedRevision: 4,
      association: { sessionId: 'session-b', machineId: 'machine-a' },
    }),
    (error) => error.code === 'session-operation-required' && error.status === 409,
  );
});

test('GitHub adapter preserves session-bound reports and terminal outcomes', async () => {
  const store = new FakeStore();
  const backend = await new GitHubTaskBackend(
    { backend: 'github' },
    { store },
  ).initialize();
  const current = await backend.get('item-1');
  const report = await backend.report('item-1', {
    content: 'Checkpoint recorded.',
    expectedSessionId: current.sessionId,
    expectedMachineId: current.machineId,
  });
  assert.equal(report.recorded, true);
  assert.deepEqual((await backend.reports('item-1'))[0], {
    id: 'comment-1',
    taskId: 'item-1',
    content: 'Checkpoint recorded.',
  });

  const completed = await backend.complete('item-1', {
    expectedRevision: current.revision,
    expectedProjection: current.projection,
    outcome: 'done',
    detail: 'Rollout completed.',
  });
  assert.equal(completed.status, 'done');
  assert.equal(completed.nextAction, 'none');
  assert.equal(completed.issueState, 'CLOSED');
});
