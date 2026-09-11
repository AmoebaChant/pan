import assert from 'node:assert/strict';
import test from 'node:test';
import {
  descriptionWithMetadata,
  metadataFrom,
  TodoistTaskBackend,
} from '../bin/pan-todoist-task-backend.js';
import { pollBackendTasks, selectReadyForAi } from '../bin/pan-backend-runner.js';

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
