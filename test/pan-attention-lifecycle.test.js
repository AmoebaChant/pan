import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  DEFAULT_ATTENTION_LABELS,
  descriptionWithMetadata,
  TodoistTaskBackend,
} from '../bin/pan-todoist-task-backend.js';
import {
  launchTask,
  attentionRecoverySkips,
  inspectLocalRuns,
  reconcileAttentionMarkers,
  reconcileLiveReleaseRequests,
  reconcileRecoverableLaunches,
  resolveAttentionWorkspace,
  selectAttentionRequested,
} from '../bin/pan-backend-runner.js';
import { runAttentionMigration } from '../bin/pan-attention-migrate.js';

function response(body, status = 200) {
  return new Response(body == null ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function native(overrides = {}) {
  return {
    id: 'task-1',
    content: 'Task',
    description: 'Details',
    priority: 2,
    project_id: 'project',
    responsible_uid: null,
    updated_at: 'r1',
    labels: [],
    ...overrides,
  };
}

test('attention labels are authoritative and conflicts fail closed', async () => {
  const backend = new TodoistTaskBackend({
    backend: 'todoist',
    lifecycleMode: 'attention-labels-v1',
    inboxProjectId: 'inbox',
  });
  assert.equal(backend.canonical(native({ project_id: 'inbox' })).attentionState, 'inbox');
  assert.equal(backend.canonical(native()).attentionState, 'human');
  assert.equal(backend.canonical(native({
    labels: ['personal', DEFAULT_ATTENTION_LABELS.requested],
  })).attentionState, 'requested');
  assert.throws(
    () => backend.canonical(native({
      labels: [DEFAULT_ATTENTION_LABELS.requested, DEFAULT_ATTENTION_LABELS.onHold],
    })),
    (error) => error.code === 'conflicting-status-labels',
  );
  assert.throws(
    () => backend.canonical(native({ labels: [DEFAULT_ATTENTION_LABELS.rejected] })),
    (error) => error.code === 'invalid-terminal-label',
  );
  assert.equal(backend.canonical(native({
    checked: true,
    labels: [DEFAULT_ATTENTION_LABELS.rejected],
  })).attentionState, 'rejected');
});

test('completed flags decode before Inbox or named-project defaults', () => {
  const backend = new TodoistTaskBackend({
    backend: 'todoist',
    lifecycleMode: 'attention-labels-v1',
    inboxProjectId: 'inbox',
  });
  for (const flag of ['checked', 'completed', 'is_completed']) {
    for (const project_id of ['inbox', 'project']) {
      const done = backend.canonical(native({
        project_id,
        labels: ['personal'],
        [flag]: true,
      }));
      assert.equal(done.attentionState, 'done', `${flag}/${project_id}`);
      assert.deepEqual(done.native.labels, ['personal']);

      const rejected = backend.canonical(native({
        project_id,
        labels: ['personal', DEFAULT_ATTENTION_LABELS.rejected],
        [flag]: true,
      }));
      assert.equal(rejected.attentionState, 'rejected', `${flag}/${project_id}/rejected`);
      assert.deepEqual(rejected.native.labels, ['personal', DEFAULT_ATTENTION_LABELS.rejected]);
    }
  }
  assert.throws(
    () => backend.canonical(native({
      checked: true,
      labels: [DEFAULT_ATTENTION_LABELS.open],
    })),
    (error) => error.code === 'invalid-terminal-label',
  );
});

test('attention reports require an exact session tuple or explicit chief semantics', async () => {
  let task = native({
    labels: [DEFAULT_ATTENTION_LABELS.open],
    description: descriptionWithMetadata('Details', {
      sessionId: 'session-1',
      machineId: 'machine-a',
    }),
  });
  const posted = [];
  const backend = await new TodoistTaskBackend({
    backend: 'todoist',
    lifecycleMode: 'attention-labels-v1',
  }, {
    readFileImpl: async () => 'TODOIST_API_KEY=secret',
    fetchImpl: async (url, options) => {
      if (url.endsWith('/user')) return response({ id: 'self' });
      if (url.endsWith('/tasks/task-1')) return response(task);
      if (url.endsWith('/comments')) {
        posted.push(JSON.parse(options.body));
        return response({ id: `comment-${posted.length}` });
      }
      throw new Error(`unexpected request: ${options.method} ${url}`);
    },
  }).initialize();
  await assert.rejects(
    backend.report('task-1', { content: 'unbound' }),
    (error) => error.code === 'report-scope-required',
  );
  await assert.rejects(
    backend.report('task-1', {
      content: 'stale',
      expectedSessionId: 'older-session',
      expectedMachineId: 'machine-a',
    }),
    (error) => error.code === 'session-conflict',
  );
  await backend.report('task-1', {
    content: 'worker report',
    expectedSessionId: 'session-1',
    expectedMachineId: 'machine-a',
  });
  task = native();
  await backend.report('task-1', { actor: 'chief', content: 'chief note' });
  assert.deepEqual(posted.map((entry) => entry.content), ['worker report', 'chief note']);
});

test('rejected completion writes the label only inside the checked close sequence', async () => {
  let task = native({ labels: ['personal'] });
  const calls = [];
  const backend = await new TodoistTaskBackend({
    backend: 'todoist',
    lifecycleMode: 'attention-labels-v1',
  }, {
    readFileImpl: async () => 'TODOIST_API_KEY=secret',
    fetchImpl: async (url, options) => {
      if (url.endsWith('/user')) return response({ id: 'self' });
      if (url.endsWith('/tasks/task-1') && options.method === 'GET') return response(task);
      if (url.endsWith('/tasks/task-1') && options.method === 'POST') {
        const body = JSON.parse(options.body);
        calls.push(['labels', body.labels]);
        task = { ...task, labels: body.labels, updated_at: 'r2' };
        return response(task);
      }
      if (url.endsWith('/tasks/task-1/close')) {
        calls.push(['close']);
        return response(null, 204);
      }
      throw new Error(`unexpected request: ${options.method} ${url}`);
    },
  }).initialize();
  await assert.rejects(
    backend.update('task-1', { expectedRevision: 'r1', attentionState: 'rejected' }),
    (error) => error.code === 'invalid-terminal-transition',
  );
  await backend.complete('task-1', { expectedRevision: 'r1', outcome: 'rejected' });
  assert.deepEqual(calls, [
    ['labels', ['personal', DEFAULT_ATTENTION_LABELS.rejected]],
    ['close'],
  ]);
});

test('rejected completion can retry the checked close after a partial failure', async () => {
  let task = native({ labels: ['personal'], updated_at: 'r1' });
  let closeAttempts = 0;
  const backend = await new TodoistTaskBackend({
    backend: 'todoist',
    lifecycleMode: 'attention-labels-v1',
  }, {
    readFileImpl: async () => 'TODOIST_API_KEY=secret',
    fetchImpl: async (url, options) => {
      if (url.endsWith('/user')) return response({ id: 'self' });
      if (url.endsWith('/tasks/task-1') && options.method === 'GET') return response(task);
      if (url.endsWith('/tasks/task-1') && options.method === 'POST') {
        task = { ...task, labels: JSON.parse(options.body).labels, updated_at: 'r2' };
        return response(task);
      }
      if (url.endsWith('/tasks/task-1/close')) {
        closeAttempts += 1;
        if (closeAttempts === 1) return response({ error: 'temporary' }, 503);
        return response(null, 204);
      }
      throw new Error(`unexpected request: ${options.method} ${url}`);
    },
  }).initialize();
  await assert.rejects(
    backend.complete('task-1', { expectedRevision: 'r1', outcome: 'rejected' }),
    (error) => error.code === 'partial-write'
      && error.details.retryExpectedRevision === 'r2',
  );
  await backend.complete('task-1', { expectedRevision: 'r2', outcome: 'rejected' });
  assert.equal(closeAttempts, 2);
});

test('attention updates preserve unrelated labels and only session association metadata', async () => {
  let task = native({
    labels: ['personal', DEFAULT_ATTENTION_LABELS.requested],
    description: descriptionWithMetadata('Details', {
      status: 'ready-for-ai',
      sourceReceipt: 'removed',
    }),
  });

  let updateBody;
  const backend = await new TodoistTaskBackend({
    backend: 'todoist',
    lifecycleMode: 'attention-labels-v1',
  }, {
    readFileImpl: async () => 'TODOIST_API_KEY=secret',
    fetchImpl: async (url, options) => {
      if (url.endsWith('/user')) return response({ id: 'self' });
      if (options.method === 'GET') return response(task);
      updateBody = JSON.parse(options.body);
      task = { ...task, ...updateBody, updated_at: 'r2' };
      return response(task);
    },
  }).initialize();
  const updated = await backend.update('task-1', {
    expectedRevision: 'r1',
    attentionState: 'open',
    association: { sessionId: 'session-1', machineId: 'machine-a' },
  });
  assert.deepEqual(updateBody.labels, ['personal', DEFAULT_ATTENTION_LABELS.open]);
  assert.deepEqual(updateBody.description, descriptionWithMetadata('Details', {
    sessionId: 'session-1',
    machineId: 'machine-a',
  }));
  assert.equal(updated.sessionId, 'session-1');
  assert.equal(updated.machineId, 'machine-a');
});

test('attention task creation never defaults into Inbox', async () => {
  const backend = await new TodoistTaskBackend({
    backend: 'todoist',
    lifecycleMode: 'attention-labels-v1',
    inboxProjectId: 'inbox',
    createProjectId: 'inbox',
  }, {
    readFileImpl: async () => 'TODOIST_API_KEY=secret',
    fetchImpl: async (url) => url.endsWith('/user')
      ? response({ id: 'self' })
      : (() => { throw new Error('create must not be called'); })(),
  }).initialize();
  await assert.rejects(
    backend.create({ title: 'Choose a project first' }),
    (error) => error.code === 'project-required',
  );
  await assert.rejects(
    backend.create({ title: 'Inbox is intake, not a chosen project', projectId: 'inbox' }),
    (error) => error.code === 'project-required',
  );
});

test('migration never turns legacy readiness into dispatch without explicit selection', () => {
  const backend = new TodoistTaskBackend({ backend: 'todoist' });
  const task = native({
    labels: ['personal'],
    description: descriptionWithMetadata('Details', {
      status: 'ready-for-ai',
      nextAction: 'execute',
      executionAuthorized: true,
      playbook: 'code',
      dependencies: [],
      worker: { state: 'released', sessionId: 'session-1', machine: 'machine-a' },
      durableExtension: 'removed',
    }),
  });
  const safe = backend.planAttentionMigration({ nativeTask: task });
  assert.equal(safe.attentionState, 'none');
  assert.match(safe.warning, /not converted/);
  assert.deepEqual(safe.labelsAfter, ['personal']);
  assert.deepEqual(safe.metadataAfter, {
    sessionId: 'session-1',
    machineId: 'machine-a',
  });
  const requested = backend.planAttentionMigration(
    { nativeTask: task },
    { requestAttention: true },
  );
  assert.equal(requested.attentionState, 'requested');
});

test('migration preserves authoritative labels and refuses active legacy workers', () => {
  const backend = new TodoistTaskBackend({ backend: 'todoist' });
  const held = backend.planAttentionMigration({
    nativeTask: native({
      labels: [DEFAULT_ATTENTION_LABELS.onHold],
      description: descriptionWithMetadata('Details', {
        status: 'ready-for-ai',
        executionAuthorized: true,
      }),
    }),
  }, { requestAttention: true });
  assert.equal(held.attentionState, 'onHold');

  const active = backend.planAttentionMigration({
    nativeTask: native({
      description: descriptionWithMetadata('Details', {
        worker: { state: 'running', sessionId: 'session-1', machine: 'machine-a' },
      }),
    }),
  });
  assert.equal(active.action, 'conflict');
  assert.match(active.reason, /requires release or reconciliation/);
});

test('migration validates association tuples and preserves unresolved worker gates', () => {
  const backend = new TodoistTaskBackend({ backend: 'todoist' });
  const mixed = backend.planAttentionMigration({
    nativeTask: native({
      description: descriptionWithMetadata('Details', {
        sessionId: 'new-session',
        machineId: 'machine-a',
        worker: { state: 'released', sessionId: 'old-session', machine: 'machine-a' },
      }),
    }),
  });

  assert.equal(mixed.action, 'conflict');
  assert.match(mixed.reason, /associations differ/);

  const partial = backend.planAttentionMigration({
    nativeTask: native({
      description: descriptionWithMetadata('Details', {
        worker: { state: 'released', sessionId: 'session-1' },
        machineId: 'machine-a',
      }),
    }),
  });
  assert.equal(partial.action, 'conflict');
  assert.match(partial.reason, /partial/);

  const gate = backend.planAttentionMigration({
    nativeTask: native({
      description: descriptionWithMetadata('Details', {
        status: 'ready-for-human',
        nextAction: 'approve',
        nextActionDetail: 'Approve the deployment.',
        worker: { state: 'released', sessionId: 'session-1', machine: 'machine-a' },
      }),
    }),
  });
  assert.equal(gate.attentionState, 'needsHelp');
  assert.match(gate.checkpointReport, /Approve the deployment/);

  const ordinary = backend.planAttentionMigration({
    nativeTask: native({
      description: descriptionWithMetadata('Details', {
        status: 'ready-for-human',
        nextAction: 'approve',
        nextActionDetail: 'Human-owned decision.',
      }),
    }),
  });
  assert.equal(ordinary.attentionState, 'none');

  for (const terminal of [
    { description: descriptionWithMetadata('Details', { status: 'done' }) },
    { labels: [DEFAULT_ATTENTION_LABELS.rejected] },
  ]) {
    const plan = backend.planAttentionMigration({ nativeTask: native(terminal) });
    assert.equal(plan.action, 'conflict');
  }
});

test('migration writes a durable native checkpoint report for retained AI help', async () => {
  let task = native({
    description: descriptionWithMetadata('Details', {
      status: 'ready-for-human',
      nextAction: 'approve',
      nextActionDetail: 'Approve release.',
      worker: { state: 'released', sessionId: 'session-1', machine: 'machine-a' },
    }),
  });
  const comments = [];
  const operations = [];
  const backend = await new TodoistTaskBackend({ backend: 'todoist' }, {
    readFileImpl: async () => 'TODOIST_API_KEY=secret',
    fetchImpl: async (url, options) => {
      if (url.endsWith('/user')) return response({ id: 'self' });
      if (url.includes('/comments?')) {
        return response({ results: comments, next_cursor: null });
      }
      if (url.endsWith('/comments') && options.method === 'POST') {
        operations.push('comment');
        const body = JSON.parse(options.body);
        comments.push({ id: 'comment-1', content: body.content, posted_at: 'now' });
        return response(comments[0]);
      }
      if (url.endsWith('/tasks/task-1') && options.method === 'GET') return response(task);
      if (url.endsWith('/tasks/task-1') && options.method === 'POST') {
        operations.push('task');
        task = { ...task, ...JSON.parse(options.body), updated_at: 'r2' };
        return response(task);
      }
      throw new Error(`unexpected request: ${options.method} ${url}`);
    },
  }).initialize();
  const plan = backend.planAttentionMigration({ nativeTask: task });
  const migrated = await backend.migrateAttentionTask(plan);
  assert.equal(migrated.attentionState, 'needsHelp');
  assert.equal(comments.length, 1);
  assert.match(comments[0].content, /Approve release/);
  assert.deepEqual(operations, ['comment', 'task']);
});

test('migration preserves unassociated clarify, approve, and hold details before stripping metadata', async () => {
  const backend = new TodoistTaskBackend({ backend: 'todoist' });
  for (const [status, nextAction, detail, expectedState] of [
    ['ready-for-human', 'clarify', 'Clarify the intended customer segment.', 'none'],
    ['ready-for-human', 'approve', 'Approve or revise the proposed removal list.', 'none'],
    ['deliberate-hold', 'hold', 'Wait until legal guidance is available.', 'onHold'],
  ]) {
    const plan = backend.planAttentionMigration({
      nativeTask: native({
        description: descriptionWithMetadata('Details', {
          status,
          nextAction,
          nextActionDetail: detail,
        }),
      }),
    });
    assert.equal(plan.attentionState, expectedState);
    assert.equal(plan.association, null);
    assert.match(plan.checkpointReport, new RegExp(detail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.deepEqual(plan.metadataAfter, {});
  }

  let task = native({
    description: descriptionWithMetadata('Details', {
      status: 'ready-for-human',
      nextAction: 'approve',
      nextActionDetail: 'Approve the migration result.',
    }),
  });
  const comments = [];
  let failUpdate = true;
  const retryBackend = await new TodoistTaskBackend({ backend: 'todoist' }, {
    readFileImpl: async () => 'TODOIST_API_KEY=secret',
    fetchImpl: async (url, options) => {
      if (url.endsWith('/user')) return response({ id: 'self' });
      if (url.includes('/comments?')) {
        return response({ results: comments, next_cursor: null });
      }
      if (url.endsWith('/comments') && options.method === 'POST') {
        const body = JSON.parse(options.body);
        comments.push({ id: 'comment-1', content: body.content, posted_at: 'now' });
        return response(comments[0]);
      }
      if (url.endsWith('/tasks/task-1') && options.method === 'GET') return response(task);
      if (url.endsWith('/tasks/task-1') && options.method === 'POST') {
        if (failUpdate) {
          failUpdate = false;
          return response({ error: 'temporary' }, 500);
        }
        task = { ...task, ...JSON.parse(options.body), updated_at: 'r2' };
        return response(task);
      }
      throw new Error(`unexpected request: ${options.method} ${url}`);
    },
  }).initialize();
  const retryPlan = retryBackend.planAttentionMigration({ nativeTask: task });
  await assert.rejects(retryBackend.migrateAttentionTask(retryPlan), /HTTP 500/);
  assert.equal(comments.length, 1);
  await retryBackend.migrateAttentionTask(retryPlan);
  assert.equal(comments.length, 1);
  assert.equal(task.description, 'Details');
});

test('migration reports requested task ids outside the complete scoped read', async () => {
  const labelNames = Object.values(DEFAULT_ATTENTION_LABELS);
  const result = await runAttentionMigration({
    command: 'preview',
    config: '/unused/backend.json',
    requestAttention: new Set(['missing-task']),
  }, {
    backendConfig: { backend: 'todoist' },
    readFileImpl: async () => 'TODOIST_API_KEY=secret',
    fetchImpl: async (url) => {
      if (url.endsWith('/user')) return response({ id: 'self' });
      if (url.includes('/labels?')) {
        return response({ results: labelNames.map((name) => ({ name })), next_cursor: null });
      }
      if (url.includes('/tasks?')) return response({ results: [], next_cursor: null });
      throw new Error(`unexpected request: ${url}`);
    },
  });
  assert.equal(result.partial, true);
  assert.deepEqual(result.unmatchedRequestAttention, ['missing-task']);
});

function root() {
  return path.join(process.cwd(), `.pan-attention-test-${randomUUID()}`);
}

function attentionBackend(initial) {
  let task = structuredClone(initial);
  const updates = [];
  const reportEntries = [];
  return {
    updates,
    reportEntries,
    async get() { return structuredClone(task); },
    async update(_id, input) {
      updates.push(structuredClone(input));
      task = {
        ...task,
        ...(input.association ?? {}),
        ...(input.attentionState === undefined ? {} : { attentionState: input.attentionState }),
        revision: `r${updates.length + 1}`,
      };
      return structuredClone(task);
    },
    async report(_id, input) { reportEntries.push(input.content); },
    async reports() { return reportEntries.map((content, index) => ({ id: String(index), content })); },
    current() { return structuredClone(task); },
  };
}

async function config(testRoot) {
  await mkdir(testRoot, { recursive: true });
  await writeFile(path.join(testRoot, 'pan.md'), '# Domain\n');
  await writeFile(path.join(testRoot, 'copilot-config.json'), '{}\n');
  return {
    lifecycleMode: 'attention-labels-v1',
    machine: 'machine-a',
    stateRoot: testRoot,
    backendConfig: path.join(testRoot, 'backend.json'),
    domainInstructionsPath: path.join(testRoot, 'pan.md'),
    panTaskCommand: path.resolve('bin/pan-task.js'),
    copilotConfigPath: path.join(testRoot, 'copilot-config.json'),
    launchCommand: ['copilot', '--model', 'gpt-5.6-sol'],
    attentionLifecycle: { allowedWorkspaceRoots: [] },
  };
}

test('attention launch, explicit release, and resume retain one session and Copilot home', async () => {
  const testRoot = root();
  const cfg = await config(testRoot);
  const backend = attentionBackend({
    id: 'task-1', title: 'Task', url: 'https://todoist.com/showTask?id=task-1',
    lifecycleMode: 'attention-labels-v1', attentionState: 'requested',
    sessionId: '', machineId: '', revision: 'r1',
  });
  let owner = 100;
  try {
    const launch = async (stateDir) => {
      await writeFile(path.join(stateDir, 'owner.json'), JSON.stringify({
        pid: owner, processStart: `start-${owner}`,
      }));
      await writeFile(path.join(stateDir, 'child.json'), JSON.stringify({
        pid: owner + 100,
        processStart: `start-${owner + 100}`,
        sessionId: backend.current().sessionId || JSON.parse(
          await readFile(path.join(stateDir, 'run.json'), 'utf8'),
        ).sessionId,
      }));
    };
    assert.equal(await launchTask(backend.current(), cfg, backend, {
      launchTerminal: launch,
      inspect: async (pid) => ({ state: 'live', identity: `start-${pid}` }),
      sleep: async () => {},
    }), true);
    const associated = backend.current();
    const firstSession = associated.sessionId;
    assert.ok(firstSession);
    assert.equal(associated.attentionState, 'open');
    const stateDir = path.join(testRoot, 'runs', 'task-1');
    assert.match(await readFile(path.join(stateDir, 'launch.mjs'), 'utf8'), new RegExp(firstSession));
    const prompt = await readFile(path.join(stateDir, 'launch-prompt.txt'), 'utf8');
    assert.match(prompt, /expectedSessionId/);
    assert.match(prompt, /expectedMachineId/);
    await writeFile(path.join(stateDir, 'worker-release.json'), '');
    const run = {
      ...JSON.parse(await readFile(path.join(stateDir, 'run.json'), 'utf8')),
      dir: stateDir,
      owner: { pid: owner, processStart: `start-${owner}` },
      releaseRequested: true,
    };
    let alive = true;
    await reconcileLiveReleaseRequests(testRoot, [run], backend, {
      inspect: async () => alive
        ? { state: 'live', identity: `start-${owner}` }
        : { state: 'dead', identity: null },
      terminateProcessTree: async (_identity, options) => {
        await options.onCaptured({ owner: run.owner, descendants: [] });
        alive = false;
      },
    });
    assert.equal(backend.current().sessionId, firstSession);
    assert.equal(backend.current().attentionState, 'none');
    await backend.update('task-1', {
      expectedRevision: backend.current().revision,
      attentionState: 'requested',
    });
    const savedSession = path.join(stateDir, 'copilot-home', 'session-state', firstSession);
    await mkdir(savedSession, { recursive: true });
    await writeFile(path.join(savedSession, 'events.jsonl'), '{"type":"session"}\n');
    owner = 101;
    assert.equal(await launchTask(backend.current(), cfg, backend, {
      launchTerminal: launch,
      inspect: async (pid) => ({ state: 'live', identity: `start-${pid}` }),
      sleep: async () => {},
    }), true);
    assert.equal(backend.current().sessionId, firstSession);
    assert.match(await readFile(path.join(stateDir, 'launch.mjs'), 'utf8'), new RegExp(firstSession));
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test('attention selection skips machine mismatch and waiting projection honors grace and overrides', async () => {
  const tasks = [
    { id: 'blank', lifecycleMode: 'attention-labels-v1', attentionState: 'requested', machineId: '' },
    { id: 'same', lifecycleMode: 'attention-labels-v1', attentionState: 'requested', machineId: 'machine-a' },
    { id: 'other', lifecycleMode: 'attention-labels-v1', attentionState: 'requested', machineId: 'machine-b' },
  ];
  assert.deepEqual(selectAttentionRequested(tasks, 'machine-a').map((task) => task.id), ['blank', 'same']);

  const testRoot = root();
  const dir = path.join(testRoot, 'runs', 'task-1');
  await mkdir(dir, { recursive: true });
  const run = {
    taskId: 'task-1', sessionId: 'session-1', machine: 'machine-a', dir,
  };
  const backend = attentionBackend({
    id: 'task-1', lifecycleMode: 'attention-labels-v1', attentionState: 'open',
    sessionId: 'session-1', machineId: 'machine-a', revision: 'r1',
  });

  try {
    await writeFile(path.join(dir, 'awaiting-answer.json'), JSON.stringify({
      version: 1,
      sessionId: 'session-1',
      checkpointId: 'question-1',
      timestamp: '2026-09-13T06:00:00.000Z',
      action: 'clarify',
      question: 'Choose A or B?',
      detail: 'Either is safe.',
    }));
    const early = await reconcileAttentionMarkers([run], backend, {
      now: Date.parse('2026-09-13T06:01:00.000Z'),
      graceSeconds: 120,
    });
    assert.equal(early.projected.length, 0);
    const late = await reconcileAttentionMarkers([run], backend, {
      now: Date.parse('2026-09-13T06:02:01.000Z'),
      graceSeconds: 120,
    });
    assert.deepEqual(late.projected, ['task-1']);
    assert.deepEqual(late.failures, []);
    const receipt = JSON.parse(await readFile(
      path.join(dir, 'awaiting-answer-projected.json'),
      'utf8',
    ));
    assert.equal(receipt.checkpointId, 'question-1');
    assert.equal(receipt.sessionId, 'session-1');
    await writeFile(path.join(dir, 'awaiting-answer.json'), JSON.stringify({
      version: 1,
      sessionId: 'session-1',
      checkpointId: 'question-2',
      timestamp: '2026-09-13T06:03:00.000Z',
      action: 'discuss',
      question: 'A newer question?',
      detail: 'The prior answer was received.',
    }));
    await reconcileAttentionMarkers([run], backend, {
      now: Date.parse('2026-09-13T06:03:30.000Z'),
      graceSeconds: 120,
    });
    assert.equal(backend.current().attentionState, 'open');
    await assert.rejects(
      readFile(path.join(dir, 'awaiting-answer-projected.json')),
      { code: 'ENOENT' },
    );
    await backend.update('task-1', {
      expectedRevision: backend.current().revision,
      attentionState: 'onHold',
    });
    await rm(path.join(dir, 'awaiting-answer.json'));
    const cleared = await reconcileAttentionMarkers([run], backend);
    assert.equal(cleared.cleared.length, 0);
    assert.equal(backend.current().attentionState, 'onHold');
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test('explicit gates project immediately and clearing the same checkpoint reopens the session', async () => {
  const testRoot = root();
  const dir = path.join(testRoot, 'runs', 'task-1');
  await mkdir(dir, { recursive: true });
  const run = {
    taskId: 'task-1', sessionId: 'session-1', machine: 'machine-a', dir,
  };
  const backend = attentionBackend({
    id: 'task-1', lifecycleMode: 'attention-labels-v1', attentionState: 'open',
    sessionId: 'session-1', machineId: 'machine-a', revision: 'r1',
  });
  try {
    await writeFile(path.join(dir, 'awaiting-answer.json'), JSON.stringify({
      version: 1,
      sessionId: 'session-1',
      checkpointId: 'review-1',
      timestamp: new Date().toISOString(),
      action: 'review',
      question: 'Review the prepared output?',
      detail: 'Artifact is durable.',
    }));
    const projected = await reconcileAttentionMarkers([run], backend);
    assert.deepEqual(projected.projected, ['task-1']);
    assert.deepEqual(projected.failures, []);
    await rm(path.join(dir, 'awaiting-answer.json'));
    const cleared = await reconcileAttentionMarkers([run], backend);
    assert.deepEqual(cleared.cleared, ['task-1']);
    assert.deepEqual(cleared.failures, []);
    assert.equal(backend.current().attentionState, 'open');
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test('attention markers require the associated session id', async () => {
  const testRoot = root();
  const dir = path.join(testRoot, 'runs', 'task-1');
  await mkdir(dir, { recursive: true });
  const run = {
    taskId: 'task-1', sessionId: 'session-1', machine: 'machine-a', dir,
  };
  const backend = attentionBackend({
    id: 'task-1', lifecycleMode: 'attention-labels-v1', attentionState: 'open',
    sessionId: 'session-1', machineId: 'machine-a', revision: 'r1',
  });

  try {
    await writeFile(path.join(dir, 'awaiting-answer.json'), JSON.stringify({
      version: 1,
      checkpointId: 'review-1',
      timestamp: new Date().toISOString(),
      action: 'review',
      question: 'Review the prepared output?',
    }));
    const result = await reconcileAttentionMarkers([run], backend);
    assert.equal(result.failures.length, 1);
    assert.match(result.failures[0].error, /sessionId is required/);
    assert.equal(backend.current().attentionState, 'open');
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test('invalid or stale attention receipts fail closed before label mutation', async () => {
  const testRoot = root();
  const dir = path.join(testRoot, 'runs', 'task-1');
  await mkdir(dir, { recursive: true });
  const run = {
    taskId: 'task-1', sessionId: 'session-1', machine: 'machine-a', dir,
  };
  const backend = attentionBackend({
    id: 'task-1', lifecycleMode: 'attention-labels-v1', attentionState: 'needsHelp',
    sessionId: 'session-1', machineId: 'machine-a', revision: 'r1',
  });
  try {
    await writeFile(path.join(dir, 'awaiting-answer-projected.json'), JSON.stringify({
      version: 1,
      taskId: 'task-1',
      sessionId: 'older-session',
      checkpointId: 'old',
      projectedAt: new Date().toISOString(),
    }));
    const result = await reconcileAttentionMarkers([run], backend);
    assert.equal(result.failures.length, 1);
    assert.match(result.failures[0].error, /invalid awaiting-answer projection receipt/);
    assert.equal(backend.updates.length, 0);
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test('attention launch failure keeps request visible and retains the allocated session', async () => {
  const testRoot = root();
  const cfg = await config(testRoot);
  const backend = attentionBackend({
    id: 'task-1', title: 'Task', url: 'https://todoist.com/showTask?id=task-1',
    lifecycleMode: 'attention-labels-v1', attentionState: 'requested',
    sessionId: '', machineId: '', revision: 'r1',
  });
  try {
    await assert.rejects(
      launchTask(backend.current(), cfg, backend, {
        launchTerminal: async () => { throw new Error('terminal unavailable'); },
      }),
      /terminal unavailable/,
    );
    assert.equal(backend.current().attentionState, 'requested');
    assert.ok(backend.current().sessionId);
    assert.equal(backend.current().machineId, 'machine-a');
    assert.match(backend.reportEntries[0], /terminal unavailable/);
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test('resume refuses a missing persisted Copilot session without spawning or replacing it', async () => {
  const testRoot = root();
  const cfg = await config(testRoot);
  const backend = attentionBackend({
    id: 'task-1', title: 'Task', url: 'https://todoist.com/showTask?id=task-1',
    lifecycleMode: 'attention-labels-v1', attentionState: 'requested',
    sessionId: 'missing-session', machineId: 'machine-a', revision: 'r1',
  });

  let spawned = false;
  try {
    await assert.rejects(
      launchTask(backend.current(), cfg, backend, {
        launchTerminal: async () => { spawned = true; },
        inspect: async () => ({ state: 'live', identity: 'runner-start' }),
      }),
      /missing from .*session-state/,
    );
    assert.equal(spawned, false);
    assert.equal(backend.current().sessionId, 'missing-session');
    assert.equal(backend.current().attentionState, 'requested');
    assert.match(backend.reportEntries[0], /missing-session/);
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test('a rejected terminal invocation remains locked while delayed worker evidence appears', async () => {
  const testRoot = root();
  const cfg = await config(testRoot);
  const backend = attentionBackend({
    id: 'task-1', title: 'Task', url: 'https://todoist.com/showTask?id=task-1',
    lifecycleMode: 'attention-labels-v1', attentionState: 'requested',
    sessionId: '', machineId: '', revision: 'r1',
  });
  let delayedWrite;
  try {
    await assert.rejects(
      launchTask(backend.current(), cfg, backend, {
        launchTerminal: async (stateDir) => {
          delayedWrite = new Promise((resolve, reject) => {
            setTimeout(() => Promise.all([
              writeFile(path.join(stateDir, 'owner.json'), JSON.stringify({
                pid: 100, processStart: 'owner-start',
              })),
              writeFile(path.join(stateDir, 'child.json'), JSON.stringify({
                pid: 200,
                processStart: 'child-start',
                sessionId: backend.current().sessionId,
              })),
            ]).then(resolve, reject), 200);
          });
          throw new Error('terminal returned failure after scheduling');
        },
        inspect: async (pid) => ({
          state: pid === process.pid ? 'live' : 'dead',
          identity: pid === process.pid ? `start-${pid}` : null,
        }),
      }),
      /failure after scheduling/,
    );
    const allocatedSession = backend.current().sessionId;
    assert.ok(allocatedSession);
    const stateDir = path.join(testRoot, 'runs', 'task-1');
    await assert.rejects(
      readFile(path.join(stateDir, 'launch-failure.json')),
      { code: 'ENOENT' },
    );
    const immediate = await inspectLocalRuns(testRoot, {
      inspect: async () => ({ state: 'dead', identity: null }),
    });
    assert.equal(immediate.uncertain.some((run) => run.taskId === 'task-1'), true);
    assert.equal(await launchTask(backend.current(), cfg, backend), false);

    await delayedWrite;
    const subsequent = await inspectLocalRuns(testRoot, {
      inspect: async (pid) => ({
        state: [100, 200].includes(pid) ? 'live' : 'dead',
        identity: pid === 100 ? 'owner-start' : pid === 200 ? 'child-start' : null,
      }),
    });
    assert.equal(subsequent.live.length, 1);
    assert.equal(await launchTask(backend.current(), cfg, backend), false);
    assert.equal(backend.current().sessionId, allocatedSession);
    assert.equal(backend.current().attentionState, 'requested');
  } finally {
    await delayedWrite?.catch(() => {});
    await rm(testRoot, { recursive: true, force: true });
  }
});

test('prepared-phase crash proof permits only its exact newly allocated tuple', async () => {
  const testRoot = root();
  const cfg = await config(testRoot);
  const stateDir = path.join(testRoot, 'runs', 'task-1');
  await mkdir(stateDir, { recursive: true });
  const run = {
    version: 1,
    lifecycleMode: 'attention-labels-v1',
    taskId: 'task-1',
    sessionId: 'allocated-session',
    machine: 'machine-a',
    resuming: false,
    phase: 'prepared',
  };
  await writeFile(path.join(stateDir, 'run.json'), JSON.stringify(run));
  await writeFile(path.join(stateDir, 'launch-failure.json'), JSON.stringify({
    version: 1,
    kind: 'launch-failure',
    taskId: 'task-1',
    sessionId: 'allocated-session',
    recordedAt: new Date().toISOString(),
    resuming: false,
    phase: 'prepared',
    definitelyNotStarted: true,
  }));
  const backend = attentionBackend({
    id: 'task-1', title: 'Task', url: 'https://todoist.com/showTask?id=task-1',
    lifecycleMode: 'attention-labels-v1', attentionState: 'requested',
    sessionId: 'allocated-session', machineId: 'machine-a', revision: 'r1',
  });
  try {
    await launchTask(backend.current(), cfg, backend, {
      launchTerminal: async (dir) => {
        await writeFile(path.join(dir, 'owner.json'), JSON.stringify({
          pid: 100, processStart: 'owner-start',
        }));
        await writeFile(path.join(dir, 'child.json'), JSON.stringify({
          pid: 200, processStart: 'child-start', sessionId: 'allocated-session',
        }));
      },
      inspect: async (pid) => ({
        state: 'live',
        identity: pid === 100 ? 'owner-start' : pid === 200 ? 'child-start' : `start-${pid}`,
      }),
      sleep: async () => {},
    });
    assert.equal(backend.current().attentionState, 'open');
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test('proven pre-terminal recovery initializes its allocated session id', async () => {
  const testRoot = root();
  const cfg = await config(testRoot);
  const stateDir = path.join(testRoot, 'runs', 'task-1');
  await mkdir(stateDir, { recursive: true });
  const priorRun = {
    version: 1,
    lifecycleMode: 'attention-labels-v1',
    taskId: 'task-1',
    sessionId: 'allocated-session',
    machine: 'machine-a',
    resuming: false,
    phase: 'associated',
  };
  await writeFile(path.join(stateDir, 'run.json'), JSON.stringify(priorRun));
  await writeFile(path.join(stateDir, 'launch-failure.json'), JSON.stringify({
    version: 1,
    kind: 'launch-failure',
    taskId: 'task-1',
    sessionId: 'allocated-session',
    recordedAt: new Date().toISOString(),
    resuming: false,
    phase: 'associated',
    definitelyNotStarted: true,
  }));
  const backend = attentionBackend({
    id: 'task-1', title: 'Task', url: 'https://todoist.com/showTask?id=task-1',
    lifecycleMode: 'attention-labels-v1', attentionState: 'requested',
    sessionId: 'allocated-session', machineId: 'machine-a', revision: 'r1',
  });
  try {
    const identities = new Map([
      [process.pid, 'runner-start'],
      [100, 'owner-start'],
      [101, 'child-start'],
    ]);
    assert.equal(await launchTask(backend.current(), cfg, backend, {
      childSettleMs: 0,
      sleep: async () => {},
      launchTerminal: async (dir) => {
        await writeFile(path.join(dir, 'owner.json'), JSON.stringify({
          pid: 100, processStart: 'owner-start',
        }));
        await writeFile(path.join(dir, 'child.json'), JSON.stringify({
          pid: 101,
          processStart: 'child-start',
          sessionId: 'allocated-session',
        }));
      },
      inspect: async (pid) => ({
        state: identities.has(pid) ? 'live' : 'dead',
        identity: identities.get(pid) ?? null,
      }),
    }), true);
    assert.equal(backend.current().sessionId, 'allocated-session');
    assert.equal(backend.current().attentionState, 'open');
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test('attention launch is not acknowledged without a live child handshake', async () => {
  const testRoot = root();
  const cfg = await config(testRoot);
  const backend = attentionBackend({
    id: 'task-1', title: 'Task', url: 'https://todoist.com/showTask?id=task-1',
    lifecycleMode: 'attention-labels-v1', attentionState: 'requested',
    sessionId: '', machineId: '', revision: 'r1',
  });
  try {
    await assert.rejects(
      launchTask(backend.current(), cfg, backend, {
        ownerTimeoutMs: 5,
        childSettleMs: 0,
        sleep: async () => {},
        launchTerminal: async (stateDir) => {
          await writeFile(path.join(stateDir, 'owner.json'), JSON.stringify({
            pid: 100, processStart: 'owner-start',
          }));
          await writeFile(path.join(stateDir, 'exit.json'), JSON.stringify({
            exitedAt: new Date().toISOString(),
            error: 'copilot spawn failed',
          }));
        },
        inspect: async (pid) => ({
          state: pid === process.pid || pid === 100 ? 'live' : 'dead',
          identity: pid === process.pid ? 'runner-start' : 'owner-start',
        }),
      }),
      /exited before launch acknowledgement/,
    );
    assert.equal(backend.current().attentionState, 'requested');
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test('workspace resolution rejects symlink escapes before trust is granted', async () => {
  const testRoot = root();
  const allowed = path.join(testRoot, 'allowed');
  const outside = path.join(testRoot, 'outside');
  const stateDir = path.join(testRoot, 'runs', 'task-1');
  await mkdir(allowed, { recursive: true });
  await mkdir(outside, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  await symlink(outside, path.join(allowed, 'escape'));
  await writeFile(path.join(stateDir, 'task-session.json'), JSON.stringify({
    workingDirectory: path.join(allowed, 'escape', 'repo'),
  }));
  try {
    await assert.rejects(
      resolveAttentionWorkspace(testRoot, 'task-1', {
        attentionLifecycle: { allowedWorkspaceRoots: [allowed] },
      }),
      /outside allowedWorkspaceRoots/,
    );
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test('private task home cannot be redirected outside stateRoot by a symlink', async () => {
  const testRoot = root();
  const outside = path.join(testRoot, 'outside');
  await mkdir(path.join(testRoot, 'runs', 'task-1'), { recursive: true });
  await mkdir(outside, { recursive: true });
  await symlink(outside, path.join(testRoot, 'task-homes'));
  try {
    await assert.rejects(
      resolveAttentionWorkspace(testRoot, 'task-1', { attentionLifecycle: {} }),
      /outside allowedWorkspaceRoots/,
    );
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test('crash windows surface and reconcile only proven pre-terminal launch ownership', async () => {
  const testRoot = root();
  const locks = path.join(testRoot, 'locks');
  const runs = path.join(testRoot, 'runs');
  await mkdir(locks, { recursive: true });
  await mkdir(runs, { recursive: true });
  const deadOwner = {
    version: 1, pid: 999999, processStart: 'dead-runner', recordedAt: new Date().toISOString(),
  };
  await writeFile(path.join(locks, 'before-run.lock'), JSON.stringify(deadOwner));
  const beforeAssociationDir = path.join(runs, 'before-association');
  await mkdir(beforeAssociationDir);
  await writeFile(path.join(locks, 'before-association.lock'), JSON.stringify(deadOwner));
  await writeFile(path.join(beforeAssociationDir, 'run.json'), JSON.stringify({
    version: 1,
    lifecycleMode: 'attention-labels-v1',
    taskId: 'before-association',
    sessionId: 'session-a',
    machine: 'machine-a',
    runnerOwner: deadOwner,
    resuming: false,
    phase: 'prepared',
  }));
  const beforeHandshakeDir = path.join(runs, 'before-handshake');
  await mkdir(beforeHandshakeDir);
  await writeFile(path.join(locks, 'before-handshake.lock'), JSON.stringify(deadOwner));
  await writeFile(path.join(beforeHandshakeDir, 'run.json'), JSON.stringify({
    version: 1,
    lifecycleMode: 'attention-labels-v1',
    taskId: 'before-handshake',
    sessionId: 'session-b',
    machine: 'machine-a',
    runnerOwner: deadOwner,
    phase: 'terminal-requested',
  }));
  const beforeChildDir = path.join(runs, 'before-child');
  await mkdir(beforeChildDir);
  await writeFile(path.join(locks, 'before-child.lock'), JSON.stringify(deadOwner));
  await writeFile(path.join(beforeChildDir, 'run.json'), JSON.stringify({
    version: 1,
    lifecycleMode: 'attention-labels-v1',
    taskId: 'before-child',
    sessionId: 'session-c',
    machine: 'machine-a',
    runnerOwner: deadOwner,
    phase: 'terminal-requested',
  }));
  await writeFile(path.join(beforeChildDir, 'owner.json'), JSON.stringify({
    pid: 123, processStart: 'launcher-live',
  }));
  const backend = attentionBackend({
    id: 'before-association',
    lifecycleMode: 'attention-labels-v1',
    attentionState: 'requested',
    sessionId: '',
    machineId: '',
    revision: 'r1',
  });
  try {
    const inventory = await inspectLocalRuns(testRoot, {
      inspect: async (pid) => pid === 123
        ? { state: 'live', identity: 'launcher-live' }
        : { state: 'dead', identity: null },
    });
    assert.deepEqual(inventory.orphanLocks.map((entry) => entry.taskId), ['before-run']);
    assert.deepEqual(inventory.recoverable.map((entry) => entry.taskId), ['before-association']);
    assert.equal(
      inventory.uncertain.some((entry) =>
        entry.taskId === 'before-handshake' && /terminal-requested/.test(entry.reason)),
      true,
    );
    assert.equal(
      inventory.uncertain.some((entry) =>
        entry.taskId === 'before-child' && /child handshake is missing/.test(entry.reason)),
      true,
    );
    assert.deepEqual(
      attentionRecoverySkips(inventory)
        .filter((entry) => entry.id === 'before-handshake')
        .map(({ id, sessionId, reason }) => ({ id, sessionId, reason })),
      [{
        id: 'before-handshake',
        sessionId: 'session-b',
        reason: 'recovery required: launch phase terminal-requested has no owner/exit; runner identity is dead',
      }],
    );
    const result = await reconcileRecoverableLaunches(testRoot, inventory, backend);
    assert.deepEqual(result.failures, []);
    assert.deepEqual(result.reconciled.sort(), ['before-association', 'before-run']);
    await assert.rejects(readFile(path.join(locks, 'before-run.lock')), { code: 'ENOENT' });
    await assert.rejects(
      readFile(path.join(locks, 'before-association.lock')),
      { code: 'ENOENT' },
    );
    assert.equal(await readFile(path.join(locks, 'before-handshake.lock'), 'utf8')
      .then(() => true), true);
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});
