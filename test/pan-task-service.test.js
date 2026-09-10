import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { parseTaskCli } from '../bin/pan-tasks.js';
import {
  createTaskHttpServer,
  DemoTaskStore,
} from '../bin/pan-task-service.js';

test('task CLI requires explicit config and checkout in live mode', () => {
  assert.throws(() => parseTaskCli([]), /requires both/);
  assert.throws(
    () => parseTaskCli(['--config', '/config.json']),
    /requires both/,
  );
  assert.deepEqual(
    parseTaskCli(['--config', '/config.json', '--checkout', '/pan', '--port', '0']),
    {
      help: false,
      demo: false,
      config: '/config.json',
      checkout: '/pan',
      host: '127.0.0.1',
      port: 0,
    },
  );
  assert.throws(
    () => parseTaskCli(['--demo', '--config', '/config.json']),
    /cannot be combined/,
  );
  assert.throws(
    () => parseTaskCli(['--demo', '--host', '0.0.0.0']),
    /must be 127\.0\.0\.1/,
  );
});

test('demo task views are exclusive and All tasks is complete', async () => {
  const snapshot = await new DemoTaskStore().list();
  const primaryIds = [
    ...snapshot.views.today,
    ...snapshot.views['needs-me'],
    ...snapshot.views['in-motion'],
    ...snapshot.views.recent,
  ];
  assert.equal(new Set(primaryIds).size, primaryIds.length);
  assert.deepEqual(new Set(snapshot.views.all), new Set(snapshot.tasks.map((task) => task.id)));
});

test('task HTTP boundary enforces Host, Origin, JSON, and stale revisions', async (t) => {
  const store = new DemoTaskStore();
  const service = createTaskHttpServer(store);
  const address = await service.listen({ port: 0 });
  t.after(() => service.close());

  const page = await fetch(address.url);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Pan Tasks/);

  const wrongHost = await new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port: address.port,
      path: '/api/health',
      headers: { Host: `localhost:${address.port}` },
    }, resolve);
    request.on('error', reject);
    request.end();
  });
  assert.equal(wrongHost.statusCode, 421);
  wrongHost.resume();

  const wrongOrigin = await fetch(`${address.url}/api/tasks`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: 'http://evil.example',
    },
    body: JSON.stringify({ title: 'Nope' }),
  });
  assert.equal(wrongOrigin.status, 403);

  const wrongType = await fetch(`${address.url}/api/tasks`, {
    method: 'POST',
    headers: { Origin: address.url, 'Content-Type': 'text/plain' },
    body: '{}',
  });
  assert.equal(wrongType.status, 415);

  const oversized = await fetch(`${address.url}/api/tasks`, {
    method: 'POST',
    headers: {
      Origin: address.url,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ title: 'Large', details: 'x'.repeat(300000) }),
  });
  assert.equal(oversized.status, 413);

  const created = await fetch(`${address.url}/api/tasks`, {
    method: 'POST',
    headers: {
      Origin: address.url,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      title: 'Fixture capture',
      details: 'Public demo data.',
      priority: 'normal',
    }),
  });
  assert.equal(created.status, 201);
  const task = await created.json();
  assert.equal(task.status, 'ready-for-human');
  assert.equal(task.nextActionDate, '');

  const stale = await fetch(`${address.url}/api/tasks/${task.id}/actions`, {
    method: 'POST',
    headers: {
      Origin: address.url,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      revision: task.revision - 1,
      operation: 'hold',
      detail: 'A stale hold.',
    }),
  });
  assert.equal(stale.status, 409);
});

test('task service refuses success-shaped writes against a live worker', async (t) => {
  const service = createTaskHttpServer(new DemoTaskStore());
  const address = await service.listen({ port: 0 });
  t.after(() => service.close());

  const detail = await (await fetch(`${address.url}/api/tasks/demo-2`)).json();
  const response = await fetch(`${address.url}/api/tasks/demo-2/actions`, {
    method: 'POST',
    headers: {
      Origin: address.url,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      revision: detail.revision,
      projection: detail.projection,
      operation: 'finish',
    }),
  });
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /worker/i);

  const edit = await fetch(`${address.url}/api/tasks/demo-2/actions`, {
    method: 'POST',
    headers: {
      Origin: address.url,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      revision: detail.revision,
      projection: detail.projection,
      operation: 'edit',
      changes: { title: 'Stale browser title edit' },
    }),
  });
  assert.equal(edit.status, 409);
});

test('task service keeps historical provenance immutable and non-runnable', async (t) => {
  const store = new DemoTaskStore();
  const historical = store.state.tasks.find((task) => task.id === 'demo-1');
  Object.assign(historical, {
    status: 'done',
    nextAction: 'none',
    executionAuthorized: 'no',
    workerState: 'stopped',
    machine: 'machine-a',
    sessionId: 'session-a',
    claimGeneration: 'generation-a',
    resourceSemantics: 'historical-provenance',
  });
  const service = createTaskHttpServer(store);
  const address = await service.listen({ port: 0 });
  t.after(() => service.close());
  const detail = await (await fetch(`${address.url}/api/tasks/demo-1`)).json();
  const mutations = [
    { operation: 'edit', changes: { workerState: 'paused' } },
    { operation: 'edit', changes: { resourceSemantics: '' } },
    { operation: 'hold', detail: 'Hold historical evidence.' },
    { operation: 'handoff-ai', detail: 'Resume historical evidence.' },
    { operation: 'handoff-human', action: 'review', detail: 'Review historical evidence.' },
    { operation: 'external-wait', detail: 'Wait on historical evidence.' },
  ];

  for (const mutation of mutations) {
    const response = await fetch(`${address.url}/api/tasks/demo-1/actions`, {
      method: 'POST',
      headers: {
        Origin: address.url,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        revision: detail.revision,
        projection: detail.projection,
        ...mutation,
      }),
    });
    assert.equal(response.status, 409, mutation.operation);
    assert.match((await response.json()).error, /historical provenance/);
  }

  const unchanged = await (await fetch(`${address.url}/api/tasks/demo-1`)).json();
  assert.equal(unchanged.status, 'done');
  assert.equal(unchanged.workerState, 'stopped');
  assert.equal(unchanged.executionAuthorized, 'no');
  assert.equal(unchanged.resourceSemantics, 'historical-provenance');
});

test('task UI exposes everyday views and honest worker-terminal language', async (t) => {
  const service = createTaskHttpServer(new DemoTaskStore());
  const address = await service.listen({ port: 0 });
  t.after(() => service.close());
  const source = await (await fetch(`${address.url}/app.js`)).text();
  for (const label of ['Today', 'Needs me', 'In motion', 'Recent activity', 'All tasks']) {
    assert.match(source, new RegExp(label));
  }
  assert.match(source, /worker terminal/i);
  assert.match(source, /Save checked edit/);
  assert.doesNotMatch(source, /release-workspace|Release workspace/);
  assert.doesNotMatch(source, /Next nominal occurrence/);
  assert.doesNotMatch(source, /gh auth|Authorization: Bearer|TODOIST_API_TOKEN/);
});
