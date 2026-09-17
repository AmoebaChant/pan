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
});

test('Todoist pagination includes completed tasks so Done sessions can be requested', async () => {
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
  const backend = await new TodoistTaskBackend({ backend: 'todoist' }, {
    readFileImpl: async () => 'TODOIST_API_TOKEN=secret',
    fetchImpl: async (url) => {
      if (url.endsWith('/user')) return response({ id: 'self' });
      if (url.endsWith('/tasks?limit=200')) {
        return response({ results: [], next_cursor: null });
      }
      if (url.endsWith('/tasks/completed/by_completion_date?limit=200')) {
        return response({ items: [completed], next_cursor: null });
      }
      throw new Error(`unexpected request: ${url}`);
    },
  }).initialize();
  const tasks = await backend.list();
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].status, 'done');
  assert.equal(tasks[0].agentStatus, 'requested');
  assert.equal(tasks[0].sessionId, 'saved-session');
});

test('Todoist metadata block contains only backend-unsupported small-contract fields', () => {
  const description = descriptionWithMetadata('Visible details', {
    playbook: 'pan',
    workstream: 'pan',
    sessionId: 'session',
    agentStatus: 'running',
  });
  assert.deepEqual(metadataFrom(description), {
    description: 'Visible details',
    metadata: {
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
