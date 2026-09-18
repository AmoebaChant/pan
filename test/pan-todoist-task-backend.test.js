import assert from 'node:assert/strict';
import test from 'node:test';
import {
  descriptionWithMetadata,
  metadataFrom,
  TodoistTaskBackend,
} from '../bin/pan-todoist-task-backend.js';

function response(body, status = 200) {
  return new Response(body == null ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function monthsBefore(value, count) {
  const result = new Date(value);
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() - count);
  const lastDay = new Date(Date.UTC(
    result.getUTCFullYear(),
    result.getUTCMonth() + 1,
    0,
  )).getUTCDate();
  result.setUTCDate(Math.min(day, lastDay));
  return result;
}

function strictTodoistTransport({
  now,
  completedPages,
  activeTasks = [],
}) {
  const completedRequests = [];
  const fetchImpl = async (rawUrl, options = {}) => {
    const url = new URL(rawUrl);
    if (url.pathname.endsWith('/user')) return response({ id: 'self' });
    if (url.pathname.endsWith('/tasks') && options.method === 'GET') {
      return response({ results: activeTasks, next_cursor: null });
    }
    if (url.pathname.endsWith('/tasks/completed/by_completion_date')) {
      const sinceText = url.searchParams.get('since');
      const untilText = url.searchParams.get('until');
      if (!sinceText || !untilText) {
        return response({ error: 'since and until are required' }, 422);
      }
      const since = new Date(sinceText);
      const until = new Date(untilText);
      if (
        Number.isNaN(since.getTime())
        || Number.isNaN(until.getTime())
        || since >= until
        || since < monthsBefore(until, 3)
      ) {
        return response({ error: 'completion range must not exceed three months' }, 422);
      }
      completedRequests.push(url);
      const cursor = url.searchParams.get('cursor') ?? '';
      return response(completedPages[cursor] ?? {
        items: [],
        next_cursor: null,
      });
    }
    if (
      url.pathname.includes('/tasks/')
      && options.method === 'GET'
    ) {
      return response({ error: 'active task not found' }, 404);
    }
    throw new Error(`unexpected request: ${options.method} ${url}`);
  };
  return { completedRequests, fetchImpl, now };
}

test('Todoist uses the same small contract without legacy workflow metadata', async () => {
  let task = {
    id: '1',
    content: 'Task',
    description: 'Details',
    priority: 2,
    project_id: 'p',
    responsible_uid: null,
    updated_at: 'r1',
  };
  const comments = [];
  const backend = await new TodoistTaskBackend({
    backend: 'todoist',
    createProjectId: 'p',
    includeCompleted: false,
  }, {
    readFileImpl: async () => 'TODOIST_API_KEY=secret',
    fetchImpl: async (url, options) => {
      if (url.endsWith('/user')) return response({ id: 'self' });
      if (url.endsWith('/tasks?limit=200')) {
        return response({ results: task.completed ? [] : [task], next_cursor: null });
      }
      if (url.endsWith('/tasks/1') && options.method === 'GET') return response(task);
      if (url.endsWith('/tasks/1') && options.method === 'POST') {
        task = { ...task, ...JSON.parse(options.body), updated_at: 'r2' };
        return response(task);
      }
      if (url.endsWith('/tasks/1/close')) {
        task = { ...task, completed: true, completed_at: '2026-09-16T01:00:00Z' };
        return response(null, 204);
      }
      if (url.endsWith('/tasks/1/reopen')) {
        task = { ...task, completed: false, completed_at: null };
        return response(null, 204);
      }
      if (url.endsWith('/comments') && options.method === 'POST') {
        const value = JSON.parse(options.body);
        comments.push({ id: String(comments.length + 1), ...value });
        return response(comments.at(-1));
      }
      throw new Error(`unexpected request: ${options.method} ${url}`);
    },
  }).initialize();

  const requested = await backend.update('1', {
    playbook: 'pan',
    workstream: 'pan',
    sessionId: 'session-1',
    agentStatus: 'requested',
  });
  assert.equal(requested.status, 'open');
  assert.equal(requested.agentStatus, 'requested');
  assert.deepEqual(metadataFrom(task.description).metadata, {
    playbook: 'pan',
    workstream: 'pan',
    sessionId: 'session-1',
    agentStatus: 'requested',
  });

  const done = await backend.update('1', { status: 'done' });
  assert.equal(done.status, 'done');
  assert.equal(done.agentStatus, 'requested');
  assert.equal(done.sessionId, 'session-1');

  const reopened = await backend.reopen('1');
  assert.equal(reopened.status, 'open');
  assert.equal(reopened.agentStatus, 'requested');

  await backend.comment('1', { content: 'A plain progress comment.' });
  assert.equal(comments[0].content, 'A plain progress comment.');
  assert.equal((await backend.get('1')).status, 'open');
  assert.equal((await backend.get('1')).nextStep, '');
});

test('Todoist metadata creates, reads, updates, and clears nextStep', async () => {
  let task = null;
  const requests = [];
  const backend = await new TodoistTaskBackend({
    backend: 'todoist',
    createProjectId: 'p',
    includeCompleted: false,
  }, {
    readFileImpl: async () => 'TODOIST_API_KEY=secret',
    fetchImpl: async (url, options = {}) => {
      const requestUrl = new URL(url);
      requests.push({
        method: options.method,
        pathname: requestUrl.pathname,
        search: requestUrl.search,
        body: options.body ? JSON.parse(options.body) : undefined,
      });
      if (requestUrl.pathname.endsWith('/user')) return response({ id: 'self' });
      if (requestUrl.pathname.endsWith('/tasks') && options.method === 'POST') {
        const input = JSON.parse(options.body);
        task = {
          id: 'created-1',
          ...input,
          project_id: input.project_id,
          responsible_uid: null,
          updated_at: 'r1',
        };
        return response(task);
      }
      if (requestUrl.pathname.endsWith('/tasks') && options.method === 'GET') {
        return response({ results: task ? [task] : [], next_cursor: null });
      }
      if (requestUrl.pathname.endsWith('/tasks/created-1') && options.method === 'GET') {
        return response(task);
      }
      if (requestUrl.pathname.endsWith('/tasks/created-1') && options.method === 'POST') {
        task = { ...task, ...JSON.parse(options.body), updated_at: 'r2' };
        return response(task);
      }
      throw new Error(`unexpected request: ${options.method} ${url}`);
    },
  }).initialize();

  const created = await backend.create({
    title: 'Publish the reviewed change',
    description: 'Keep native details.',
    priority: 'high',
    nextStep: 'PR published - ready for review',
    playbook: 'pan',
    workstream: 'pan',
    sessionId: 'saved-session',
    agentStatus: 'running',
  });
  assert.equal(created.nextStep, 'PR published - ready for review');
  assert.equal(created.title, 'Publish the reviewed change');
  assert.equal(created.description, 'Keep native details.');
  assert.equal(created.projectId, 'p');
  assert.deepEqual(metadataFrom(task.description).metadata, {
    nextStep: 'PR published - ready for review',
    playbook: 'pan',
    workstream: 'pan',
    sessionId: 'saved-session',
    agentStatus: 'running',
  });

  assert.equal((await backend.list())[0].nextStep, 'PR published - ready for review');
  assert.equal((await backend.get(created.id)).nextStep, 'PR published - ready for review');

  const updated = await backend.update(created.id, {
    nextStep: 'Awaiting reviewer decision',
  });
  assert.equal(updated.nextStep, 'Awaiting reviewer decision');
  assert.equal(updated.title, created.title);
  assert.equal(updated.description, created.description);
  assert.equal(updated.priority, created.priority);
  assert.equal(updated.playbook, 'pan');
  assert.equal(updated.workstream, 'pan');
  assert.equal(updated.sessionId, 'saved-session');
  assert.equal(updated.agentStatus, 'running');

  const cleared = await backend.update(created.id, { nextStep: '' });
  assert.equal(cleared.nextStep, '');
  assert.deepEqual(metadataFrom(task.description), {
    description: 'Keep native details.',
    metadata: {
      playbook: 'pan',
      workstream: 'pan',
      sessionId: 'saved-session',
      agentStatus: 'running',
    },
  });
  const updateBodies = requests
    .filter((request) =>
      request.method === 'POST'
      && request.pathname.endsWith('/tasks/created-1'))
    .map((request) => request.body);
  assert.equal(updateBodies.length, 2);
  assert.equal(
    metadataFrom(updateBodies[0].description).metadata.nextStep,
    'Awaiting reviewer decision',
  );
  assert.deepEqual(metadataFrom(updateBodies[1].description).metadata, {
    playbook: 'pan',
    workstream: 'pan',
    sessionId: 'saved-session',
    agentStatus: 'running',
  });
  assert.equal(updateBodies[0].content, undefined);
  assert.equal(updateBodies[0].priority, undefined);
});

test('Todoist completed history uses strict three-month bounds and cursor pagination', async () => {
  const now = new Date('2026-09-16T12:34:56.000Z');
  const completed = {
    task_id: 'done-1',
    content: 'Done task',
    description: descriptionWithMetadata('', {
      sessionId: 'saved-session',
      agentStatus: 'requested',
    }),
    priority: 1,
    project_id: 'p',
    responsible_uid: null,
    completed_at: '2026-09-15T00:00:00Z',
  };
  const secondCompleted = {
    ...completed,
    task_id: 'done-2',
    content: 'Second done task',
    completed_at: '2026-06-16T13:00:00Z',
  };
  const transport = strictTodoistTransport({
    now,
    completedPages: {
      '': { items: [completed], next_cursor: 'next.page' },
      'next.page': { items: [secondCompleted], next_cursor: null },
    },
  });
  const endpoint = 'https://api.todoist.com/api/v1/tasks/completed/by_completion_date';
  assert.equal((await transport.fetchImpl(endpoint, { method: 'GET' })).status, 422);
  assert.equal(
    (await transport.fetchImpl(
      `${endpoint}?since=2026-06-15T12%3A34%3A56.000Z&until=2026-09-16T12%3A34%3A56.000Z`,
      { method: 'GET' },
    )).status,
    422,
  );

  const backend = await new TodoistTaskBackend({ backend: 'todoist' }, {
    readFileImpl: async () => 'TODOIST_API_TOKEN=secret',
    fetchImpl: transport.fetchImpl,
    nowImpl: () => now,
  }).initialize();
  const tasks = await backend.list();
  assert.equal(tasks.length, 2);
  assert.equal(tasks[0].status, 'done');
  assert.equal(tasks[0].agentStatus, 'requested');
  assert.equal(tasks[0].sessionId, 'saved-session');
  assert.deepEqual(
    transport.completedRequests.map((url) => ({
      since: url.searchParams.get('since'),
      until: url.searchParams.get('until'),
      limit: url.searchParams.get('limit'),
      cursor: url.searchParams.get('cursor'),
    })),
    [
      {
        since: '2026-06-16T12:34:56.000Z',
        until: '2026-09-16T12:34:56.000Z',
        limit: '200',
        cursor: null,
      },
      {
        since: '2026-06-16T12:34:56.000Z',
        until: '2026-09-16T12:34:56.000Z',
        limit: '200',
        cursor: 'next.page',
      },
    ],
  );
});

test('Todoist closed-task fallback shares the bounded history window', async () => {
  const now = new Date('2026-09-16T12:34:56.000Z');
  const completed = {
    task_id: 'done-1',
    content: 'Done task',
    description: '',
    priority: 1,
    project_id: 'p',
    responsible_uid: null,
    completed_at: '2026-09-15T00:00:00Z',
  };
  const transport = strictTodoistTransport({
    now,
    completedPages: {
      '': { items: [completed], next_cursor: null },
    },
  });
  const backend = await new TodoistTaskBackend({ backend: 'todoist' }, {
    readFileImpl: async () => 'TODOIST_API_TOKEN=secret',
    fetchImpl: transport.fetchImpl,
    nowImpl: () => now,
  }).initialize();

  assert.equal((await backend.get('done-1')).status, 'done');
  await assert.rejects(
    backend.get('older-done-task'),
    (error) => {
      assert.equal(error.code, 'todoist-task-outside-history-window');
      assert.equal(error.status, 404);
      assert.match(error.message, /not active or is outside Pan's three-month/i);
      assert.deepEqual(error.details, {
        since: '2026-06-16T12:34:56.000Z',
        until: '2026-09-16T12:34:56.000Z',
      });
      return true;
    },
  );
  assert.equal(transport.completedRequests.length, 2);
});

test('Todoist metadata block contains only backend-unsupported small-contract fields', () => {
  const description = descriptionWithMetadata('Visible details', {
    nextStep: 'Awaiting review',
    playbook: 'pan',
    workstream: 'pan',
    sessionId: 'session',
    agentStatus: 'running',
  });
  assert.deepEqual(metadataFrom(description), {
    description: 'Visible details',
    metadata: {
      nextStep: 'Awaiting review',
      playbook: 'pan',
      workstream: 'pan',
      sessionId: 'session',
      agentStatus: 'running',
    },
  });
  for (const rejected of [
    'owner',
    'nextAction',
    'executionAuthorized',
    'dependencies',
    'workerState',
    'claimGeneration',
    'resourceSemantics',
    'revision',
  ]) {
    assert.doesNotMatch(description, new RegExp(rejected, 'i'));
  }
});
