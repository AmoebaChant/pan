import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applySourceIntake,
  discoverGitHubIssues,
  emptyReceiptLedger,
  planSourceIntake,
  resolveGitHubIntakeConfig,
  validateReceiptLedger,
} from '../bin/pan-source-intake-core.js';
import { GitHubIntakeClient, parseSourceIntakeCli, runSourceIntake } from '../bin/pan-source-intake.js';

function issue(number, overrides = {}) {
  return {
    number,
    node_id: `I_${number}`,
    html_url: `https://github.com/example/source/issues/${number}`,
    title: `Issue ${number}`,
    body: `Body ${number}`,
    state: 'open',
    updated_at: `2026-09-12T00:${String(number % 60).padStart(2, '0')}:00Z`,
    assignees: [],
    ...overrides,
  };
}

function sourceFromIssue(native, workstream = '') {
  return {
    kind: 'github-issue',
    repository: 'example/source',
    number: native.number,
    nodeId: native.node_id,
    url: native.html_url,
    title: native.title,
    body: native.body,
    state: native.state,
    updatedAt: native.updated_at,
    assignees: (native.assignees ?? []).map((assignee) => assignee.login.toLowerCase()),
    workstream,
    pullRequest: Boolean(native.pull_request),
  };
}

function createdTask(input, id) {
  return {
    id,
    projectId: input.projectId,
    title: input.title,
    description: input.description,
    status: input.status,
    nextAction: input.nextAction,
    nextActionDetail: input.nextActionDetail,
    executionAuthorized: input.executionAuthorized,
    nextActionDate: input.nextActionDate,
    deadline: input.deadline,
    playbook: input.playbook,
    workstream: input.workstream,
    dependencies: input.dependencies,
  };
}

test('routing config rejects undeclared repositories and nonboolean retirement', () => {
  const config = {
    backend: 'todoist',
    sourceIntake: { githubIssues: {
      enabled: true, repositories: ['example/source'],
      projectMappings: { 'other/source': 'project' },
    } },
  };
  assert.throws(() => resolveGitHubIntakeConfig(config), /declared repositories/);
  config.sourceIntake.githubIssues.projectMappings = { 'example/source': 'project' };
  config.sourceIntake.githubIssues.closeMigratedIssues = 'yes';
  assert.throws(() => resolveGitHubIntakeConfig(config), /boolean/);
  config.sourceIntake.githubIssues.closeMigratedIssues = true;
  const resolved = resolveGitHubIntakeConfig(config);
  assert.equal(resolved.projectMappings['example/source'], 'project');
  assert.equal(resolved.closeMigratedIssues, true);
});

test('mapped imports verify the task and receipt before retiring the source', async () => {
  const native = issue(1);
  const source = sourceFromIssue(native);
  const store = receiptStore();
  const plan = planSourceIntake({ eligible: [source], excluded: [] }, store.snapshot(), 'todoist');
  plan.projectMappings = { 'example/source': 'project' };
  plan.closeMigratedIssues = true;
  let task;
  const events = [];
  const backend = {
    supportsIdempotentCreate: true,
    async validateProject(id) { assert.equal(id, 'project'); events.push('destination'); },
    async create(input) {
      assert.equal(input.projectId, 'project');
      task = createdTask(input, 'task');
      events.push('create');
      return task;
    },
    async get() { events.push('get'); return task; },
  };
  const github = {
    ...githubFor([native]),
    async retireIssue() {
      assert.equal(store.snapshot().receipts[0].state, 'created');
      events.push('retire');
    },
  };
  const result = await applySourceIntake(plan, { backend, github, receiptStore: store });
  assert.equal(result.partial, false);
  assert.equal(result.results[0].sourceRetired, true);
  assert.deepEqual(events, ['destination', 'create', 'get', 'retire']);
});

test('existing imports move without resetting human edits and retry failed closure without duplicates', async () => {
  const source = sourceFromIssue(issue(1));
  const store = receiptStore({ ...emptyReceiptLedger(), receipts: [completedReceipt(source)] });
  const plan = planSourceIntake({ eligible: [source], excluded: [] }, store.snapshot(), 'todoist');
  plan.projectMappings = { 'example/source': 'project' };
  plan.closeMigratedIssues = true;
  let task = {
    id: 'task-1', title: 'Edited by user', description: source.url,
    projectId: 'inbox', revision: 'r1', status: 'ready-for-human',
    nextActionDate: '2026-09-15',
  };
  let moves = 0;
  let closes = 0;
  const backend = {
    supportsIdempotentCreate: true,
    async validateProject() {},
    async get() { return { ...task }; },
    async create() { assert.fail('must not duplicate'); },
    async move(id, input) {
      assert.equal(input.expectedRevision, 'r1');
      task = { ...task, projectId: input.projectId, revision: 'r2' };
      moves++;
    },
  };
  const github = { async retireIssue() { if (++closes === 1) throw new Error('GitHub unavailable'); } };
  const failed = await applySourceIntake(plan, { backend, github, receiptStore: store });
  assert.equal(failed.partial, true);
  const recovered = await applySourceIntake(plan, { backend, github, receiptStore: store });
  assert.equal(recovered.partial, false);
  assert.equal(moves, 1);
  assert.equal(task.status, 'ready-for-human');
  assert.equal(task.nextActionDate, '2026-09-15');
});

test('missing target or invalid destination never retires the source', async () => {
  const source = sourceFromIssue(issue(1));
  const store = receiptStore({ ...emptyReceiptLedger(), receipts: [completedReceipt(source)] });
  const plan = planSourceIntake({ eligible: [source], excluded: [] }, store.snapshot(), 'todoist');
  plan.closeMigratedIssues = true;
  const backend = {
    supportsIdempotentCreate: true,
    async get() { throw new Error('missing target'); },
    async validateProject() { throw new Error('missing project'); },
  };
  const github = { async retireIssue() { assert.fail('must not close'); } };
  assert.equal((await applySourceIntake(plan, { backend, github, receiptStore: store })).partial, true);
  plan.projectMappings = { 'example/source': 'missing' };
  await assert.rejects(applySourceIntake(plan, { backend, github, receiptStore: store }), /missing project/);
});

test('GitHub retirement labels, comments and closes as migrated; retries reuse the comment', async () => {
  const source = sourceFromIssue(issue(1));
  let native = { ...issue(1), labels: [] };
  const comments = [];
  const writes = [];
  const client = new GitHubIntakeClient('example/domain', async (args, options) => {
    const endpoint = args.find((value) => value.startsWith('repos/'));
    const methodIndex = args.indexOf('--method');
    const method = methodIndex < 0 ? 'GET' : args[methodIndex + 1];
    const body = options?.input ? JSON.parse(options.input) : null;
    if (args.includes('user')) return { login: 'me' };
    if (method === 'GET') {
      if (endpoint.endsWith('/labels/migrated-to-todoist')) return {};
      if (endpoint.includes('/comments?')) return [comments];
      return structuredClone(native);
    }
    writes.push(method);
    if (endpoint.endsWith('/labels')) {
      native.labels = body.labels.map((name) => ({ name }));
    } else if (endpoint.endsWith('/comments')) {
      comments.push({ user: { login: 'me' }, body: body.body });
      return comments.at(-1);
    } else {
      assert.equal(body.state_reason, 'not_planned');
      assert.equal(comments.length, 1);
      native = { ...native, ...body };
    }
    return {};
  });
  await client.retireIssue(source, { id: 'task-1', title: 'Title' });
  assert.deepEqual(writes, ['POST', 'POST', 'PATCH']);
  assert.match(comments[0].body, /not fixed, shipped, or rejected/);
  native.state = 'open';
  await client.retireIssue(source, { id: 'task-1', title: 'Title' });
  assert.equal(comments.length, 1);
  const count = writes.length;
  native.state = 'open';
  native.updated_at = 'changed';
  await assert.rejects(client.retireIssue(source, { id: 'task-1', title: 'Title' }), /changed after preview/);
  assert.equal(writes.length, count);
});

function completedReceipt(source, overrides = {}) {
  return {
    state: 'created',
    source: {
      kind: 'github-issue',
      repository: source.repository,
      number: source.number,
      nodeId: source.nodeId,
      url: source.url,
      ...(overrides.source ?? {}),
    },
    target: {
      backend: 'todoist',
      taskId: 'task-1',
      ...(overrides.target ?? {}),
    },
    requestId: overrides.requestId || '11111111-1111-4111-8111-111111111111',
  };
}

function receiptStore(initial = emptyReceiptLedger(), { failWrite } = {}) {
  let ledger = structuredClone(initial);
  let revision = 0;
  let writes = 0;
  return {
    async read() {
      return { ledger: structuredClone(ledger), revision: String(revision) };
    },
    async write(next, expected) {
      writes += 1;
      if (String(revision) !== expected) throw new Error('stale receipt revision');
      if (failWrite?.(writes)) throw new Error(`receipt write ${writes} failed`);
      ledger = structuredClone(next);
      revision += 1;
    },
    snapshot() {
      return structuredClone(ledger);
    },
    get writes() {
      return writes;
    },
  };
}

function githubFor(issues) {
  const byNumber = new Map(issues.map((value) => [value.number, value]));
  return {
    async currentUser() {
      return 'me';
    },
    async getIssue(repository, number) {
      assert.equal(repository, 'example/source');
      return structuredClone(byNumber.get(number));
    },
  };
}

function githubDiscovery(issues) {
  return {
    async currentUser() {
      return 'me';
    },
    async listIssueConnectionPage(repository, cursor, pageSize) {
      assert.equal(repository, 'example/source');
      assert.equal(cursor, null);
      assert.equal(pageSize, 100);
      return {
        nodes: structuredClone(issues),
        totalCount: issues.length,
        pageInfo: { hasNextPage: false, endCursor: null },
      };
    },
  };
}

test('intake scope uses only explicit and opted-in backlog repository declarations', () => {
  const config = resolveGitHubIntakeConfig({
    backend: 'todoist',
    sourceIntake: {
      githubIssues: {
        enabled: true,
        workstreamBacklogs: true,
        repositories: ['explicit/repo'],
      },
    },
  }, [{
    path: 'alpha',
    content: [
      '# Alpha',
      '',
      'See [not intake](https://github.com/linked/only).',
      '',
      '## Backlog repositories',
      '',
      '- example/source',
      '',
      '## Notes',
      '',
      '- ignored/after-section',
    ].join('\n'),
  }, {
    path: 'beta',
    content: '## Backlog repositories\n\n- example/source\n- second/source\n',
  }]);

  assert.deepEqual(config.sources, [
    { repository: 'example/source', workstream: '', declaredBy: ['alpha', 'beta'] },
    { repository: 'explicit/repo', workstream: '', declaredBy: [] },
    { repository: 'second/source', workstream: 'beta', declaredBy: ['beta'] },
  ]);
  assert.equal(config.sources.some((source) => source.repository === 'linked/only'), false);
  assert.equal(config.sources.some((source) => source.repository === 'ignored/after-section'), false);
});

test('intake rejects an explicitly empty receipt path', () => {
  assert.throws(
    () => resolveGitHubIntakeConfig({
      backend: 'todoist',
      sourceIntake: {
        githubIssues: {
          enabled: true,
          repositories: ['example/source'],
          receiptPath: '',
        },
      },
    }),
    /receiptPath must be a safe repository-relative path/,
  );
});

test('GitHub discovery fully paginates and excludes pull requests and exclusively other assignees', async () => {
  const calls = [];
  const first = Array.from({ length: 100 }, (_, index) => issue(index + 1));
  first[1] = issue(2, { assignees: [{ login: 'other' }] });
  first[2] = issue(3, { assignees: [{ login: 'other' }, { login: 'Me' }] });
  first[3] = issue(4, { pull_request: { url: 'https://api.github.com/pulls/4' } });
  first[4] = issue(5, { state: 'closed' });
  const github = {
    async currentUser() {
      return 'me';
    },
    async listIssueConnectionPage(repository, cursor, pageSize) {
      calls.push([repository, cursor, pageSize]);
      return cursor === null
        ? {
            nodes: first,
            totalCount: 101,
            pageInfo: { hasNextPage: true, endCursor: 'cursor-100' },
          }
        : {
            nodes: [issue(101)],
            totalCount: 101,
            pageInfo: { hasNextPage: false, endCursor: 'cursor-101' },
          };
    },
  };
  const result = await discoverGitHubIssues(github, [{
    repository: 'example/source',
    workstream: 'alpha',
  }]);

  assert.deepEqual(calls, [
    ['example/source', null, 100],
    ['example/source', 'cursor-100', 100],
    ['example/source', null, 100],
    ['example/source', 'cursor-100', 100],
  ]);
  assert.equal(result.eligible.length, 98);
  assert.equal(result.eligible.some((value) => value.number === 3), true);
  assert.deepEqual(
    result.excluded.map((value) => [value.source.number, value.reason]),
    [
      [2, 'assigned-exclusively-to-other-people'],
      [4, 'pull-request'],
      [5, 'closed'],
    ],
  );
});

test('an incomplete later Issue page fails the whole discovery read', async () => {
  let calls = 0;
  await assert.rejects(
    discoverGitHubIssues({
      async currentUser() {
        return 'me';
      },
      async listIssueConnectionPage(repository, cursor) {
        calls += 1;
        if (cursor) throw new Error('GitHub page unavailable');
        return {
          nodes: Array.from({ length: 100 }, (_, index) => issue(index + 1)),
          totalCount: 101,
          pageInfo: { hasNextPage: true, endCursor: 'cursor-100' },
        };
      },
    }, [{ repository: 'example/source', workstream: '' }]),
    /page unavailable/,
  );
  assert.equal(calls, 2);
});

test('snapshot discovery rejects overlap, omission shifts, and reorder between passes', async (t) => {
  const source = [{ repository: 'example/source', workstream: '' }];
  await t.test('overlap', async () => {
    await assert.rejects(
      discoverGitHubIssues({
        async currentUser() {
          return 'me';
        },
        async listIssueConnectionPage(repository, cursor) {
          return cursor === null
            ? {
                nodes: Array.from({ length: 100 }, (_, index) => issue(index + 1)),
                totalCount: 150,
                pageInfo: { hasNextPage: true, endCursor: 'next' },
              }
            : {
                nodes: Array.from({ length: 50 }, (_, index) => issue(index + 100)),
                totalCount: 150,
                pageInfo: { hasNextPage: false, endCursor: 'last' },
              };
        },
      }, source),
      /overlapping or reordered/,
    );
  });
  await t.test('omission shift', async () => {
    await assert.rejects(
      discoverGitHubIssues({
        async currentUser() {
          return 'me';
        },
        async listIssueConnectionPage(repository, cursor) {
          return cursor === null
            ? {
                nodes: Array.from({ length: 100 }, (_, index) => issue(index + 1)),
                totalCount: 150,
                pageInfo: { hasNextPage: true, endCursor: 'next' },
              }
            : {
                nodes: Array.from({ length: 49 }, (_, index) => issue(index + 102)),
                totalCount: 150,
                pageInfo: { hasNextPage: false, endCursor: 'last' },
              };
        },
      }, source),
      /expected 150 records but read 149/,
    );
  });
  await t.test('reorder between passes', async () => {
    let pass = 0;
    await assert.rejects(
      discoverGitHubIssues({
        async currentUser() {
          return 'me';
        },
        async listIssueConnectionPage() {
          pass += 1;
          return {
            nodes: pass === 1 ? [issue(1), issue(2)] : [issue(2), issue(1)],
            totalCount: 2,
            pageInfo: { hasNextPage: false, endCursor: 'last' },
          };
        },
      }, source),
      /changed between complete Issue snapshots/,
    );
  });
});

test('snapshot discovery rejects incomplete cursor metadata', async () => {
  await assert.rejects(
    discoverGitHubIssues({
      async currentUser() {
        return 'me';
      },
      async listIssueConnectionPage() {
        return {
          nodes: [issue(1)],
          totalCount: 1,
          pageInfo: { hasNextPage: false },
        };
      },
    }, [{ repository: 'example/source', workstream: '' }]),
    /incomplete Issue cursor metadata/,
  );
});

test('a durable receipt prevents duplicates without consulting current open backend tasks', () => {
  const source = sourceFromIssue(issue(1));
  const ledger = {
    format: 'pan-source-intake-receipts',
    version: 1,
    receipts: [{
      state: 'created',
      source: {
        kind: 'github-issue',
        repository: 'example/source',
        number: 1,
        nodeId: source.nodeId,
        url: source.url,
      },
      target: { backend: 'todoist', taskId: 'deleted-or-completed-task' },
      requestId: '11111111-1111-4111-8111-111111111111',
      reservedAt: '2026-09-12T01:00:00Z',
      createdAt: '2026-09-12T01:00:01Z',
    }],
  };
  const plan = planSourceIntake({ eligible: [source], excluded: [] }, ledger, 'todoist');
  assert.equal(plan.actions[0].action, 'already-imported');
  assert.equal(plan.actions[0].receipt.target.taskId, 'deleted-or-completed-task');
});

test('receipt validation rejects duplicate source identities', () => {
  const receipt = {
    state: 'created',
    source: {
      kind: 'github-issue',
      repository: 'example/source',
      number: 1,
      nodeId: 'I_1',
      url: 'https://github.com/example/source/issues/1',
    },
    target: { backend: 'todoist', taskId: 'task-1' },
    requestId: '11111111-1111-4111-8111-111111111111',
  };
  assert.throws(
    () => validateReceiptLedger({
      format: 'pan-source-intake-receipts',
      version: 1,
      receipts: [receipt, { ...receipt, target: { backend: 'todoist', taskId: 'task-2' } }],
    }),
    /duplicate source identity/,
  );
});

test('already-imported apply detects receipt target, backend, and source races', async (t) => {
  const source = sourceFromIssue(issue(1));
  const original = completedReceipt(source);
  const plan = planSourceIntake({
    eligible: [source],
    excluded: [],
  }, {
    format: 'pan-source-intake-receipts',
    version: 1,
    receipts: [original],
  }, 'todoist');
  const cases = [
    ['target', completedReceipt(source, { target: { taskId: 'task-2' } })],
    ['backend', completedReceipt(source, { target: { backend: 'other', taskId: 'task-1' } })],
    ['source', completedReceipt(source, {
      source: {
        number: 2,
        nodeId: 'I_2',
        url: 'https://github.com/example/source/issues/2',
      },
    })],
  ];
  for (const [name, racedReceipt] of cases) {
    await t.test(name, async () => {
      const report = await applySourceIntake(plan, {
        backend: { supportsIdempotentCreate: true },
        github: githubFor([issue(1)]),
        receiptStore: receiptStore({
          format: 'pan-source-intake-receipts',
          version: 1,
          receipts: [racedReceipt],
        }),
      });
      assert.equal(report.partial, true);
      assert.equal(report.results[0].action, 'failed');
      assert.match(report.results[0].error, /receipt changed after preview/);
    });
  }
});

test('receipt validation rejects contradictory URL and live node aliases', () => {
  const sourceOne = sourceFromIssue(issue(1));
  const sourceTwo = sourceFromIssue(issue(2));
  const malformed = {
    format: 'pan-source-intake-receipts',
    version: 1,
    receipts: [{
      state: 'created',
      source: {
        kind: 'github-issue',
        repository: 'example/source',
        number: 2,
        nodeId: sourceOne.nodeId,
        url: sourceTwo.url,
      },
      target: { backend: 'todoist', taskId: 'task-1' },
      requestId: '11111111-1111-4111-8111-111111111111',
    }],
  };
  assert.throws(
    () => validateReceiptLedger(malformed, [sourceOne, sourceTwo]),
    /cross-links source Issue aliases/,
  );
  assert.throws(
    () => planSourceIntake(
      { eligible: [sourceOne, sourceTwo], excluded: [] },
      malformed,
      'todoist',
    ),
    /cross-links source Issue aliases/,
  );
});

test('receipt validation rejects a URL that contradicts its repository and number', () => {
  const source = sourceFromIssue(issue(1));
  assert.throws(
    () => validateReceiptLedger({
      format: 'pan-source-intake-receipts',
      version: 1,
      receipts: [{
        state: 'created',
        source: {
          kind: 'github-issue',
          repository: source.repository,
          number: source.number,
          nodeId: source.nodeId,
          url: 'https://github.com/example/source/issues/2',
        },
        target: { backend: 'todoist', taskId: 'task-1' },
        requestId: '11111111-1111-4111-8111-111111111111',
      }],
    }),
    /non-canonical or contradictory URL/,
  );
});

test('apply is checked, idempotent, and never auto-authorizes or dates imported tasks', async () => {
  const native = issue(1);
  const discovery = await discoverGitHubIssues({
    ...githubDiscovery([native]),
  }, [{ repository: 'example/source', workstream: 'alpha' }]);
  const store = receiptStore();
  const createdInputs = [];
  const backend = {
    supportsIdempotentCreate: true,
    async create(input) {
      createdInputs.push(structuredClone(input));
      return createdTask(input, 'task-1');
    },
  };
  const github = githubFor([native]);
  const firstPlan = planSourceIntake(discovery, store.snapshot(), 'todoist');
  const first = await applySourceIntake(firstPlan, {
    backend,
    github,
    receiptStore: store,
    now: () => '2026-09-12T01:00:00.000Z',
  });

  assert.equal(first.partial, false);
  assert.equal(first.results[0].action, 'created');
  assert.equal(createdInputs.length, 1);
  assert.equal(createdInputs[0].status, 'untriaged');
  assert.equal(createdInputs[0].nextAction, '');
  assert.equal(createdInputs[0].executionAuthorized, false);
  assert.equal(createdInputs[0].nextActionDate, '');
  assert.equal(createdInputs[0].deadline, '');
  assert.equal(createdInputs[0].playbook, '');
  assert.equal(createdInputs[0].workstream, 'alpha');
  assert.match(createdInputs[0].description, /Source node id: I_1/);

  const secondPlan = planSourceIntake(discovery, store.snapshot(), 'todoist');
  const second = await applySourceIntake(secondPlan, {
    backend,
    github,
    receiptStore: store,
  });
  assert.equal(second.partial, false);
  assert.equal(second.results[0].action, 'already-imported');
  assert.equal(createdInputs.length, 1);
});

test('apply leaves a reservation when the backend does not confirm safe defaults', async () => {
  const native = issue(1);
  const discovery = await discoverGitHubIssues({
    ...githubDiscovery([native]),
  }, [{ repository: 'example/source', workstream: '' }]);
  const store = receiptStore();
  const report = await applySourceIntake(
    planSourceIntake(discovery, store.snapshot(), 'todoist'),
    {
      backend: {
        supportsIdempotentCreate: true,
        async create(input) {
          return {
            ...createdTask(input, 'unsafe-task'),
            executionAuthorized: true,
          };
        },
      },
      github: githubFor([native]),
      receiptStore: store,
    },
  );

  assert.equal(report.partial, true);
  assert.equal(report.results[0].createdTaskId, 'unsafe-task');
  assert.match(report.results[0].error, /required safe intake record/);
  assert.equal(store.snapshot().receipts[0].state, 'reserved');
  assert.equal(store.writes, 1);
});

test('apply surfaces a task id reported by a backend partial write', async () => {
  const native = issue(1);
  const discovery = await discoverGitHubIssues({
    ...githubDiscovery([native]),
  }, [{ repository: 'example/source', workstream: '' }]);
  const store = receiptStore();
  const report = await applySourceIntake(
    planSourceIntake(discovery, store.snapshot(), 'todoist'),
    {
      backend: {
        supportsIdempotentCreate: true,
        async create() {
          const error = new Error('created task is outside configured scope');
          error.details = { taskId: 'out-of-scope-task' };
          throw error;
        },
      },
      github: githubFor([native]),
      receiptStore: store,
    },
  );

  assert.equal(report.partial, true);
  assert.equal(report.results[0].createdTaskId, 'out-of-scope-task');
  assert.equal(store.snapshot().receipts[0].state, 'reserved');
});

test('apply refuses a source Issue that changed after preview without reserving it', async () => {
  const previewed = issue(1);
  const changed = issue(1, {
    title: 'Changed',
    updated_at: '2026-09-12T02:00:00Z',
  });
  const source = sourceFromIssue(previewed);
  const store = receiptStore();
  let creates = 0;
  const report = await applySourceIntake(
    planSourceIntake({ eligible: [source], excluded: [] }, store.snapshot(), 'todoist'),
    {
      backend: {
        supportsIdempotentCreate: true,
        async create() {
          creates += 1;
        },
      },
      github: githubFor([changed]),
      receiptStore: store,
    },
  );
  assert.equal(report.partial, true);
  assert.match(report.results[0].error, /changed after preview/);
  assert.equal(creates, 0);
  assert.equal(store.writes, 0);
});

test('apply does not create through a conflicting reservation added after planning', async () => {
  const native = issue(1);
  const source = sourceFromIssue(native);
  const conflicting = {
    format: 'pan-source-intake-receipts',
    version: 1,
    receipts: [{
      state: 'reserved',
      source: {
        kind: 'github-issue',
        repository: source.repository,
        number: source.number,
        nodeId: source.nodeId,
        url: source.url,
      },
      target: { backend: 'another-backend', taskId: null },
      requestId: '11111111-1111-4111-8111-111111111111',
    }],
  };
  let creates = 0;
  const report = await applySourceIntake(
    planSourceIntake({ eligible: [source], excluded: [] }, emptyReceiptLedger(), 'todoist'),
    {
      backend: {
        supportsIdempotentCreate: true,
        async create() {
          creates += 1;
        },
      },
      github: githubFor([native]),
      receiptStore: receiptStore(conflicting),
    },
  );

  assert.equal(report.partial, true);
  assert.match(report.results[0].error, /receipt changed/);
  assert.equal(creates, 0);
});

test('apply reports a post-create receipt failure and recovers with the same request id', async () => {
  const native = issue(1);
  const source = sourceFromIssue(native);
  const store = receiptStore(emptyReceiptLedger(), {
    failWrite: (writeNumber) => writeNumber === 2,
  });
  const tasksByRequest = new Map();
  const requests = [];
  const backend = {
    supportsIdempotentCreate: true,
    async create(input) {
      requests.push(input.idempotencyKey);
      if (!tasksByRequest.has(input.idempotencyKey)) {
        tasksByRequest.set(input.idempotencyKey, createdTask(input, 'task-1'));
      }
      return tasksByRequest.get(input.idempotencyKey);
    },
  };
  const github = githubFor([native]);
  const plan = planSourceIntake(
    { eligible: [source], excluded: [] },
    store.snapshot(),
    'todoist',
  );
  const failed = await applySourceIntake(plan, { backend, github, receiptStore: store });
  assert.equal(failed.partial, true);
  assert.equal(failed.results[0].createdTaskId, 'task-1');
  assert.match(failed.results[0].error, /receipt write 2 failed/);
  assert.equal(store.snapshot().receipts[0].state, 'reserved');

  const recovery = planSourceIntake(
    { eligible: [source], excluded: [] },
    store.snapshot(),
    'todoist',
  );
  assert.equal(recovery.actions[0].action, 'recover-reservation');
  const recovered = await applySourceIntake(recovery, {
    backend,
    github,
    receiptStore: store,
  });
  assert.equal(recovered.partial, false);
  assert.equal(recovered.results[0].action, 'recovered');
  assert.equal(store.snapshot().receipts[0].state, 'created');
  assert.equal(store.snapshot().receipts[0].target.taskId, 'task-1');
  assert.deepEqual(requests, [requests[0], requests[0]]);
});

test('apply continues independent Issues and reports a truthful partial result', async () => {
  const natives = [issue(1), issue(2)];
  const sources = natives.map((native) => sourceFromIssue(native));
  const store = receiptStore();
  const attempted = [];
  const backend = {
    supportsIdempotentCreate: true,
    async create(input) {
      attempted.push(input.title);
      if (input.title === 'Issue 1') throw new Error('backend unavailable');
      return createdTask(input, 'task-2');
    },
  };
  const report = await applySourceIntake(
    planSourceIntake({ eligible: sources, excluded: [] }, store.snapshot(), 'todoist'),
    { backend, github: githubFor(natives), receiptStore: store },
  );
  assert.equal(report.partial, true);
  assert.deepEqual(attempted, ['Issue 1', 'Issue 2']);
  assert.equal(report.results[0].action, 'failed');
  assert.equal(report.results[1].action, 'created');
  assert.deepEqual(
    store.snapshot().receipts.map((receipt) => receipt.state),
    ['reserved', 'created'],
  );
});

test('source intake CLI makes apply deliberate', () => {
  assert.throws(
    () => parseSourceIntakeCli(['apply', '--config', '/private/binding.json']),
    /--confirm-intake/,
  );
  assert.deepEqual(
    parseSourceIntakeCli([
      'apply',
      '--config', '/private/binding.json',
      '--confirm-intake',
    ]),
    { help: false, command: 'apply', config: '/private/binding.json' },
  );
});

test('source intake CLI preview is deterministic with injected GitHub and receipt dependencies', async () => {
  let receiptWrites = 0;
  const result = await runSourceIntake({
    command: 'preview',
    config: '/private/binding.json',
  }, {
    binding: {
      domainRepo: 'example/domain',
      taskBackendConfig: '/private/backend.json',
    },
    domainConfig: {
      backend: 'todoist',
      sourceIntake: {
        githubIssues: {
          enabled: true,
          repositories: ['example/source'],
        },
      },
    },
    readFile: async (filename) => {
      assert.equal(filename, '/private/backend.json');
      return JSON.stringify({ backend: 'todoist' });
    },
    github: {
      async currentUser() {
        return 'me';
      },
      async listIssueConnectionPage() {
        return {
          nodes: [issue(1)],
          totalCount: 1,
          pageInfo: { hasNextPage: false, endCursor: null },
        };
      },
    },
    receiptStore: {
      async read() {
        return { ledger: emptyReceiptLedger(), revision: null };
      },
      async write() {
        receiptWrites += 1;
      },
    },
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.result.actions[0].action, 'create');
  assert.equal(receiptWrites, 0);
});

test('source intake CLI reads two complete GraphQL snapshots without REST offset paging', async () => {
  const graphqlCalls = [];
  const domainConfig = {
    backend: 'todoist',
    sourceIntake: {
      githubIssues: {
        enabled: true,
        repositories: ['example/source'],
      },
    },
  };
  const result = await runSourceIntake({
    command: 'preview',
    config: '/private/binding.json',
  }, {
    binding: {
      domainRepo: 'example/domain',
      taskBackendConfig: '/private/backend.json',
    },
    readFile: async () => JSON.stringify({ backend: 'todoist' }),
    ghJson: async (args) => {
      if (args[1] === 'user') return { login: 'me' };
      if (args[1] === 'graphql') {
        graphqlCalls.push(args);
        return {
          data: {
            repository: {
              issues: {
                nodes: [{
                  id: 'I_1',
                  number: 1,
                  url: 'https://github.com/example/source/issues/1',
                  title: 'Issue 1',
                  body: 'Body 1',
                  state: 'OPEN',
                  updatedAt: '2026-09-12T00:01:00Z',
                  assignees: {
                    nodes: [],
                    pageInfo: { hasNextPage: false, endCursor: null },
                  },
                }],
                totalCount: 1,
                pageInfo: { hasNextPage: false, endCursor: 'issue-cursor' },
              },
            },
          },
        };
      }
      if (args.some((argument) => String(argument).endsWith('/task-backend.json'))) {
        return {
          type: 'file',
          encoding: 'base64',
          sha: 'config-sha',
          content: Buffer.from(JSON.stringify(domainConfig)).toString('base64'),
        };
      }
      if (args.some((argument) =>
        String(argument).endsWith('/.pan/source-intake-receipts.json'))) {
        throw new Error('gh: Not Found (HTTP 404)');
      }
      throw new Error(`unexpected gh args: ${JSON.stringify(args)}`);
    },
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.result.actions[0].action, 'create');
  assert.equal(graphqlCalls.length, 2);
  assert.equal(graphqlCalls.every((args) =>
    args.some((argument) => String(argument).includes('orderBy: { field: CREATED_AT'))), true);
  assert.equal(graphqlCalls.every((args) =>
    !args.some((argument) => String(argument).includes('/issues?'))), true);
});
