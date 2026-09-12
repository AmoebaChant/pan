import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  descriptionWithMetadata,
  metadataFrom,
  TodoistTaskBackend,
} from '../bin/pan-todoist-task-backend.js';
import {
  inspectLocalRuns,
  launchTask,
  pollBackendTasks,
  reconcileStaleRuns,
  selectReadyForAi,
  trustCopilotFolders,
} from '../bin/pan-backend-runner.js';

function response(body, status = 200) {
  return new Response(body == null ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('metadata round trips without replacing the human description', () => {
  const value = descriptionWithMetadata('Visible details', {
    status: 'ready-for-ai',
    executionAuthorized: true,
  });
  assert.deepEqual(metadataFrom(value), {
    description: 'Visible details',
    metadata: { status: 'ready-for-ai', executionAuthorized: true },
  });
});

test('Todoist adapter paginates, scopes assignments, and maps canonical fields', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.endsWith('/user')) return response({ id: 'self' });
    if (url.includes('cursor=next')) {
      return response({ results: [{
        id: '3', content: 'Other', description: '', priority: 1,
        project_id: 'p', responsible_uid: 'other', updated_at: 'r3',
      }], next_cursor: null });
    }
    return response({ results: [{
      id: '1', content: 'Ready', priority: 4, project_id: 'p',
      responsible_uid: 'self', updated_at: 'r1', due: { date: '2026-09-11' },
      description: descriptionWithMetadata('Do it', {
        status: 'ready-for-ai', nextAction: 'execute',
        executionAuthorized: true, dependencies: [], playbook: 'general',
      }),
    }, {
      id: '2', content: 'Unassigned', description: '', priority: 1,
      project_id: 'p', responsible_uid: null, updated_at: 'r2',
    }], next_cursor: 'next' });
  };
  const backend = await new TodoistTaskBackend(
    { backend: 'todoist', scope: { projectIds: ['p'] } },
    { fetchImpl, readFileImpl: async () => 'TODOIST_API_KEY=secret' },
  ).initialize();
  const tasks = await backend.list();
  assert.equal(calls.length, 3);
  assert.deepEqual(tasks.map((task) => task.id), ['1', '2']);
  assert.equal(tasks[0].priority, 'urgent');
  assert.equal(tasks[0].nextActionDate, '2026-09-11');
  assert.equal(tasks[0].executionAuthorized, true);
});

test('update reports stale revisions before writing', async () => {
  let writes = 0;
  const fetchImpl = async (url, options) => {
    if (url.endsWith('/user')) return response({ id: 'self' });
    if (options.method === 'GET') {
      return response({
        id: '1', content: 'Task', description: '', priority: 1,
        project_id: 'p', responsible_uid: null, updated_at: 'new',
      });
    }
    writes += 1;
    return response({});
  };
  const backend = await new TodoistTaskBackend(
    { backend: 'todoist' },
    { fetchImpl, readFileImpl: async () => 'TODOIST_API_TOKEN=secret' },
  ).initialize();
  await assert.rejects(
    backend.update('1', { expectedRevision: 'old', title: 'Changed' }),
    (error) => error.code === 'revision-conflict' && error.status === 409,
  );
  assert.equal(writes, 0);
});

test('update reads the task once before writing', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push([url, options.method]);
    if (url.endsWith('/user')) return response({ id: 'self' });
    if (options.method === 'GET') {
      return response({
        id: '1', content: 'Task', description: '', priority: 1,
        project_id: 'p', responsible_uid: null, updated_at: 'r1',
      });
    }
    return response({
      id: '1', content: 'Changed', description: '', priority: 1,
      project_id: 'p', responsible_uid: null, updated_at: 'r2',
    });
  };
  const backend = await new TodoistTaskBackend(
    { backend: 'todoist' },
    { fetchImpl, readFileImpl: async () => 'TODOIST_API_KEY=secret' },
  ).initialize();
  assert.equal((await backend.update('1', {
    expectedRevision: 'r1',
    title: 'Changed',
  })).title, 'Changed');
  assert.deepEqual(calls.map(([, method]) => method), ['GET', 'GET', 'POST']);
});

test('recurring attention date moves the native occurrence without replacing cadence', async () => {
  let restBody;
  let syncDue;
  let recurring = {
    id: '1', content: 'Recurring', priority: 1, project_id: 'p',
    responsible_uid: null, updated_at: 'r1',
    due: { date: '2026-09-11', string: 'every friday', lang: 'en', is_recurring: true },
    description: descriptionWithMetadata('', { status: 'ready-for-human' }),
  };
  const fetchImpl = async (url, options) => {
    if (url.endsWith('/user')) return response({ id: 'self' });
    if (options.method === 'GET') return response(recurring);
    if (url.endsWith('/sync')) {
      const command = JSON.parse(options.body.get('commands'))[0];
      syncDue = command.args.due;
      recurring = { ...recurring, updated_at: 'r3', due: syncDue };
      return response({ sync_status: { [command.uuid]: 'ok' } });
    }
    restBody = JSON.parse(options.body);
    recurring = { ...recurring, updated_at: 'r2', description: restBody.description };
    return response(recurring);
  };
  const backend = await new TodoistTaskBackend(
    { backend: 'todoist' },
    { fetchImpl, readFileImpl: async () => 'TODOIST_API_KEY=secret' },
  ).initialize();
  const updated = await backend.update('1', {
    expectedRevision: 'r1',
    nextActionDate: '2026-09-18',
  });
  assert.equal(restBody.due_date, undefined);
  assert.deepEqual(syncDue, {
    date: '2026-09-18',
    string: 'every friday',
    lang: 'en',
    is_recurring: true,
  });
  assert.equal(updated.recurring, true);
  assert.equal(updated.native.due.string, 'every friday');
  assert.equal(updated.nextActionDate, '2026-09-18');
});

test('recurring dates cannot be cleared and failed native moves report partial writes', async () => {
  let writes = 0;
  const recurring = {
    id: '1', content: 'Recurring', priority: 1, project_id: 'p',
    responsible_uid: null, updated_at: 'r1',
    due: { date: '2026-09-11', string: 'every friday', is_recurring: true },
    description: '',
  };
  const fetchImpl = async (url, options) => {
    if (url.endsWith('/user')) return response({ id: 'self' });
    if (options.method === 'GET') return response(recurring);
    writes += 1;
    if (url.endsWith('/sync')) {
      const command = JSON.parse(options.body.get('commands'))[0];
      return response({ sync_status: { [command.uuid]: { error: 'invalid due' } } });
    }
    return response({ ...recurring, content: 'Changed', updated_at: 'r2' });
  };
  const backend = await new TodoistTaskBackend(
    { backend: 'todoist' },
    { fetchImpl, readFileImpl: async () => 'TODOIST_API_KEY=secret' },
  ).initialize();
  await assert.rejects(
    backend.update('1', { expectedRevision: 'r1', nextActionDate: '' }),
    (error) => error.code === 'unsupported-mapping',
  );
  assert.equal(writes, 0);
  await assert.rejects(
    backend.update('1', {
      expectedRevision: 'r1',
      title: 'Changed',
      nextActionDate: '2026-09-18',
    }),
    (error) => error.code === 'partial-write'
      && error.details?.completedOperation === 'task metadata update',
  );
  assert.equal(writes, 2);
});

test('reports are fully paginated after the scoped task read', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.endsWith('/user')) return response({ id: 'self' });
    if (url.endsWith('/tasks/1')) {
      return response({
        id: '1', content: 'Task', description: '', priority: 1,
        project_id: 'p', responsible_uid: null, updated_at: 'r1',
      });
    }
    if (url.includes('cursor=next')) {
      return response({ results: [{
        id: 'c2', task_id: '1', content: 'Result', posted_at: '2026-09-11T02:00:00Z',
      }], next_cursor: null });
    }
    return response({ results: [{
      id: 'c1', task_id: '1', content: 'Progress', posted_at: '2026-09-11T01:00:00Z',
    }], next_cursor: 'next' });
  };
  const backend = await new TodoistTaskBackend(
    { backend: 'todoist' },
    { fetchImpl, readFileImpl: async () => 'TODOIST_API_KEY=secret' },
  ).initialize();
  assert.deepEqual((await backend.reports('1')).map((item) => item.content), [
    'Progress',
    'Result',
  ]);
  assert.equal(calls.length, 4);
});

test('complete checks revision and calls the native close endpoint', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push([url, options.method]);
    if (url.endsWith('/user')) return response({ id: 'self' });
    if (url.endsWith('/tasks/1') && options.method === 'GET') {
      return response({
        id: '1', content: 'Task', description: '', priority: 1,
        project_id: 'p', responsible_uid: null, updated_at: 'r1',
      });
    }
    if (url.endsWith('/tasks/1/close')) return response(null, 204);
    throw new Error(`unexpected request ${options.method} ${url}`);
  };
  const backend = await new TodoistTaskBackend(
    { backend: 'todoist' },
    { fetchImpl, readFileImpl: async () => 'TODOIST_API_KEY=secret' },
  ).initialize();
  assert.deepEqual(await backend.complete('1', { expectedRevision: 'r1' }), {
    taskId: '1',
    completed: true,
  });
  assert.deepEqual(calls.map(([, method]) => method), ['GET', 'GET', 'POST']);
});

test('mechanical runner launches only authorized ready tasks without date gating', async () => {
  const tasks = [
    { id: 'future', title: 'Future human date', status: 'ready-for-ai', nextAction: 'execute', executionAuthorized: true, dependencies: [], worker: null, priority: 'normal', nextActionDate: '2099-01-01' },
    { id: 'hold', title: 'Held', status: 'deliberate-hold', nextAction: 'hold', executionAuthorized: true, dependencies: [], worker: null, priority: 'urgent' },
    { id: 'unauthorized', title: 'Not authorized', status: 'ready-for-ai', nextAction: 'execute', executionAuthorized: false, dependencies: [], worker: null, priority: 'urgent' },
    { id: 'recurring', title: 'Recurring', status: 'ready-for-ai', nextAction: 'execute', executionAuthorized: true, dependencies: [], worker: null, priority: 'urgent', recurring: true },
  ];
  assert.deepEqual(selectReadyForAi(tasks).map((task) => task.id), ['future']);
  const launched = [];
  const result = await pollBackendTasks({
    backend: { list: async () => tasks },
    capacity: 1,
    launch: async (task) => launched.push(task.id),
  });
  assert.deepEqual(result.launched, ['future']);
  assert.deepEqual(launched, ['future']);
});

test('mechanical runner preserves backend order instead of reprioritizing', () => {
  const tasks = [
    { id: 'first', title: 'First', status: 'ready-for-ai', nextAction: 'execute', executionAuthorized: true, dependencies: [], worker: null, priority: 'low' },
    { id: 'second', title: 'Second', status: 'ready-for-ai', nextAction: 'execute', executionAuthorized: true, dependencies: [], worker: null, priority: 'urgent' },
  ];
  assert.deepEqual(selectReadyForAi(tasks).map((task) => task.id), ['first', 'second']);
});

test('dry-run reports selection without claiming a launch', async () => {
  const task = { id: '1', title: 'Task', status: 'ready-for-ai', nextAction: 'execute', executionAuthorized: true, dependencies: [], worker: null };
  const result = await pollBackendTasks({
    backend: { list: async () => [task] },
    capacity: 1,
    dryRun: true,
    launch: async () => { throw new Error('must not launch'); },
  });
  assert.deepEqual(result.selected, ['1']);
  assert.deepEqual(result.launched, []);
});

test('mechanical runner exact allowlist excludes every other ready task', async () => {
  const tasks = ['demo', 'real'].map((id) => ({
    id, title: id, status: 'ready-for-ai', nextAction: 'execute',
    executionAuthorized: true, dependencies: [], worker: null,
  }));
  const launched = [];
  const result = await pollBackendTasks({
    backend: { list: async () => tasks },
    capacity: 1,
    allowedTaskIds: new Set(['demo']),
    launch: async (task) => launched.push(task.id),
  });
  assert.deepEqual(result.selected, ['demo']);
  assert.deepEqual(result.launched, ['demo']);
});

function testRoot() {
  return path.join(process.cwd(), `.pan-backend-test-${randomUUID()}`);
}

function parseConfigWithHeader(raw) {
  return JSON.parse(raw.split('\n').filter((line) => !line.trimStart().startsWith('//')).join('\n'));
}

test('Copilot trust update fails closed on an unreadable config body', async () => {
  const root = testRoot();
  const configPath = path.join(root, 'config.json');
  await mkdir(root, { recursive: true });
  await writeFile(configPath, '// managed automatically\n{not json}\n');
  try {
    await assert.rejects(
      trustCopilotFolders(configPath, [path.join(root, 'workspace')]),
      /JSON/,
    );
    assert.equal(await readFile(configPath, 'utf8'), '// managed automatically\n{not json}\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function runnerConfig(root) {
  const playbookPath = path.join(root, 'test-playbook.md');
  const domainInstructionsPath = path.join(root, 'pan.md');
  await mkdir(path.join(root, 'workspace'), { recursive: true });
  await writeFile(playbookPath, '---\nname: test-playbook\n---\n');
  await writeFile(domainInstructionsPath, '# Domain\n');
  await writeFile(path.join(root, 'copilot-config.json'), '{}\n');
  return {
    machine: 'machine-a',
    stateRoot: root,
    workingDirectory: path.join(root, 'workspace'),
    backendConfig: path.join(root, 'backend.json'),
    playbookName: 'test-playbook',
    playbookPath,
    domainInstructionsPath,
    panTaskCommand: path.resolve('bin/pan-task.js'),
    copilotConfigPath: path.join(root, 'copilot-config.json'),
    launchCommand: ['copilot', '--model', 'gpt-5.6-sol'],
  };
}

function backendFake(task) {
  let current = structuredClone(task);
  const updates = [];
  const reportEntries = [];
  return {
    updates,
    reportEntries,
    async get() { return structuredClone(current); },
    async update(_id, input) {
      updates.push(structuredClone(input));
      current = { ...current, worker: input.worker, revision: `r${updates.length + 1}` };
      return structuredClone(current);
    },
    async report(_id, input) { reportEntries.push(input.content); },
    async reports() {
      return [
        { id: 'report-1', content: 'Prior report' },
        ...reportEntries.map((content, index) => ({ id: `new-${index}`, content })),
      ];
    },
  };
}

test('live process inventory survives polls and blocks shared workspace capacity', async () => {
  const root = testRoot();
  const config = await runnerConfig(root);
  await writeFile(config.copilotConfigPath, '// managed automatically\n{\n  "theme": "system",\n  "trustedFolders": ["/existing"]\n}\n');
  const task = {
    id: 'task-1', title: 'Task', url: 'https://todoist.example/task-1',
    revision: 'r1', status: 'ready-for-ai', nextAction: 'execute',
    executionAuthorized: true, dependencies: [], worker: null, recurring: false,
    playbook: 'test-playbook',
  };
  const backend = backendFake(task);
  try {
    assert.equal(await launchTask(task, config, backend, {
      launchTerminal: async (stateDir) => {
        await writeFile(path.join(stateDir, 'owner.json'), JSON.stringify({
          pid: 123,
          processStart: 'fake:start',
        }));
      },
      inspect: async () => ({ state: 'live', identity: 'fake:start' }),
    }), true);
    const first = await inspectLocalRuns(root, {
      inspect: async () => ({ state: 'live', identity: 'fake:start' }),
    });
    const second = await inspectLocalRuns(root, {
      inspect: async () => ({ state: 'live', identity: 'fake:start' }),
    });
    assert.equal(first.live.length, 1);
    assert.equal(second.live.length, 1);
    const launcher = await readFile(path.join(root, 'runs', 'task-1', 'launch.mjs'), 'utf8');
    assert.match(launcher, /stdio:'inherit'/);
    assert.match(launcher, /PAN_STATE_DIR/);
    assert.match(launcher, /--add-dir/);
    assert.match(launcher, /pan-worker/);
    assert.match(launcher, new RegExp(config.workingDirectory.replaceAll('\\', '\\\\')));
    assert.match(launcher, new RegExp(path.dirname(process.execPath).replaceAll('\\', '\\\\')));
    assert.equal(JSON.parse(await readFile(
      path.join(root, 'runs', 'task-1', 'task.json'),
    )).id, 'task-1');
    assert.match(
      await readFile(path.join(root, 'runs', 'task-1', 'launch-prompt.txt'), 'utf8'),
      /bin\/pan-task\.js.*reports/,
    );
    assert.match(
      await readFile(path.join(root, 'runs', 'task-1', 'launch-prompt.txt'), 'utf8'),
      /empty .*worker-release\.json.*exit Copilot/,
    );
    assert.match(
      await readFile(path.join(root, 'runs', 'task-1', 'launch-prompt.txt'), 'utf8'),
      /headed terminal is a worker session.*ignore main chief-of-staff scheduling/,
    );
    assert.equal(JSON.parse(await readFile(
      path.join(root, 'runs', 'task-1', 'reports.json'),
    ))[0].content, 'Prior report');
    const sourceConfig = parseConfigWithHeader(await readFile(config.copilotConfigPath, 'utf8'));
    assert.deepEqual(sourceConfig, {
      theme: 'system',
      trustedFolders: ['/existing'],
    });
    const copilotConfig = parseConfigWithHeader(await readFile(
      path.join(root, 'runs', 'task-1', 'copilot-home', 'config.json'),
      'utf8',
    ));
    assert.equal(copilotConfig.theme, 'system');
    assert.equal(copilotConfig.memory, false);
    assert.deepEqual(copilotConfig.trustedFolders, [
      '/existing',
      config.workingDirectory,
      path.join(root, 'runs', 'task-1'),
    ]);
    const trust = JSON.parse(await readFile(
      path.join(root, 'runs', 'task-1', 'trust.json'),
    ));
    assert.equal(trust.copilotHome, path.join(root, 'runs', 'task-1', 'copilot-home'));
    assert.deepEqual(trust.added, [
      config.workingDirectory,
      path.join(root, 'runs', 'task-1'),
    ]);
    const result = await pollBackendTasks({
      backend: { list: async () => [{ ...task, id: 'task-2' }] },
      capacity: 0,
      workspaceBusy: true,
      launch: async () => { throw new Error('busy workspace must not launch'); },
    });
    assert.equal(result.workspaceBusy, true);
    assert.deepEqual(result.launched, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('unexpected exit preserves workspace affinity without inferring lifecycle state', async () => {
  const root = testRoot();
  const dir = path.join(root, 'runs', 'task-1');
  await mkdir(path.join(root, 'locks'), { recursive: true });
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'run.json'), JSON.stringify({
    version: 1, taskId: 'task-1', sessionId: 'session-1',
    machine: 'machine-a', workingDirectory: path.join(root, 'workspace'),
  }));
  await writeFile(path.join(dir, 'owner.json'), JSON.stringify({
    pid: 123, processStart: 'old:start',
  }));
  await writeFile(path.join(root, 'locks', 'task-1.lock'), '');
  const backend = backendFake({
    id: 'task-1', revision: 'r1', status: 'ready-for-human',
    worker: { state: 'running', sessionId: 'session-1' },
  });
  try {
    const inventory = await inspectLocalRuns(root, {
      inspect: async () => ({ state: 'live', identity: 'new:start' }),
    });
    assert.equal(inventory.stale.length, 1);
    assert.deepEqual(await reconcileStaleRuns(root, inventory.stale, backend), ['task-1']);
    assert.equal(backend.updates[0].worker.state, 'unexpected-stop');
    assert.equal(backend.updates[0].status, undefined);
    assert.match(backend.reportEntries[0], /without worker-release\.json/);
    assert.equal(await readFile(path.join(root, 'locks', 'task-1.lock'), 'utf8'), '');
    const restarted = await inspectLocalRuns(root);
    assert.equal(restarted.unexpected.length, 1);
    assert.equal(restarted.stale.length, 0);
    assert.equal(restarted.unexpected[0].sessionId, 'session-1');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('explicit release is consumed only after exit and frees the task lock', async () => {
  const root = testRoot();
  const dir = path.join(root, 'runs', 'task-1');
  await mkdir(path.join(root, 'locks'), { recursive: true });
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'run.json'), JSON.stringify({
    version: 1, taskId: 'task-1', sessionId: 'session-1',
    machine: 'machine-a', workingDirectory: path.join(root, 'workspace'),
  }));
  await writeFile(path.join(dir, 'owner.json'), JSON.stringify({
    pid: 123, processStart: 'old:start',
  }));
  await writeFile(path.join(dir, 'exit.json'), JSON.stringify({
    exitedAt: '2026-09-12T04:00:00.000Z', code: 0, signal: null,
  }));
  await writeFile(path.join(dir, 'worker-release.json'), '');
  await writeFile(path.join(root, 'locks', 'task-1.lock'), '');
  const backend = backendFake({
    id: 'task-1', revision: 'r1', status: 'ready-for-human',
    worker: { state: 'running', sessionId: 'session-1' },
  });
  await backend.report('task-1', { content: 'Durable result: ready for review.' });
  try {
    const live = await inspectLocalRuns(root, {
      inspect: async () => ({ state: 'live', identity: 'old:start' }),
    });
    assert.equal(live.live.length, 1);
    assert.equal(live.live[0].releaseRequested, true);
    assert.equal(backend.updates.length, 0);

    const stopped = await inspectLocalRuns(root, {
      inspect: async () => ({ state: 'dead', identity: null }),
    });
    assert.deepEqual(await reconcileStaleRuns(root, stopped.stale, backend), ['task-1']);
    assert.equal(backend.updates[0].worker.state, 'released');
    assert.equal(backend.updates[0].status, undefined);
    await assert.rejects(readFile(path.join(root, 'locks', 'task-1.lock')), { code: 'ENOENT' });
    const receipt = JSON.parse(await readFile(
      path.join(dir, 'worker-release-consumed.json'),
    ));
    assert.equal(receipt.kind, 'released');
    assert.equal(receipt.reportsObserved, 2);

    const restarted = await inspectLocalRuns(root);
    assert.equal(restarted.released.length, 1);
    assert.equal(restarted.stale.length, 0);
    assert.deepEqual(await reconcileStaleRuns(root, restarted.stale, backend), []);
    assert.equal(backend.updates.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('report and task status changes do not release a live worker', async () => {
  const root = testRoot();
  const dir = path.join(root, 'runs', 'task-1');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'run.json'), JSON.stringify({
    version: 1, taskId: 'task-1', sessionId: 'session-1',
    machine: 'machine-a', workingDirectory: path.join(root, 'workspace'),
  }));
  await writeFile(path.join(dir, 'owner.json'), JSON.stringify({
    pid: 123, processStart: 'same:start',
  }));
  const backend = backendFake({
    id: 'task-1', revision: 'r1', status: 'done',
    worker: { state: 'running', sessionId: 'session-1' },
  });
  await backend.report('task-1', { content: 'Durable result: review needed.' });
  try {
    const inventory = await inspectLocalRuns(root, {
      inspect: async () => ({ state: 'live', identity: 'same:start' }),
    });
    assert.equal(inventory.live.length, 1);
    assert.equal(inventory.live[0].releaseRequested, false);
    assert.deepEqual(await reconcileStaleRuns(root, inventory.stale, backend), []);
    assert.equal(backend.updates.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('task lock contention happens before backend observation', async () => {
  const root = testRoot();
  const config = await runnerConfig(root);
  await mkdir(path.join(root, 'locks'), { recursive: true });
  await writeFile(path.join(root, 'locks', 'task-1.lock'), '');
  const backend = backendFake({ id: 'task-1', revision: 'r1', worker: null });
  try {
    assert.equal(await launchTask({ id: 'task-1', revision: 'r1' }, config, backend), false);
    assert.equal(backend.updates.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('launch rechecks the exact task allowlist before backend observation', async () => {
  const root = testRoot();
  const config = {
    ...await runnerConfig(root),
    taskIds: ['demo-task'],
  };
  const backend = backendFake({
    id: 'real-task', revision: 'r1', worker: null, playbook: 'test-playbook',
  });
  try {
    await assert.rejects(
      launchTask({
        id: 'real-task', revision: 'r1', playbook: 'test-playbook',
      }, config, backend),
      /outside the runner taskIds allowlist/,
    );
    assert.equal(backend.updates.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('terminal spawn error is awaited, reported, and recorded as stopped', async () => {
  const root = testRoot();
  const config = await runnerConfig(root);
  const task = {
    id: 'task-1', title: 'Task', url: 'https://todoist.example/task-1',
    revision: 'r1', playbook: 'test-playbook',
  };
  const backend = backendFake(task);
  try {
    await assert.rejects(
      launchTask(task, config, backend, {
        launchTerminal: async () => { throw new Error('spawn failed'); },
      }),
      /spawn failed/,
    );
    assert.equal(backend.updates[0].worker.state, 'starting');
    assert.equal(backend.updates[1].worker.state, 'stopped');
    assert.match(backend.reportEntries[0], /spawn failed/);
    const exit = JSON.parse(await readFile(path.join(root, 'runs', 'task-1', 'exit.json')));
    assert.match(exit.error, /spawn failed/);
    await assert.rejects(readFile(path.join(root, 'locks', 'task-1.lock')), { code: 'ENOENT' });
    const inventory = await inspectLocalRuns(root);
    assert.equal(inventory.failed.length, 1);
    assert.equal(inventory.stale.length, 0);
    assert.equal(inventory.uncertain.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
