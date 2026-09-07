import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import {
  runDemoLoop,
  runMcpProtocol,
} from '../bin/pan-briefing-mcp.js';
import {
  BriefingBroker,
  createBriefingHttpServer,
} from '../bin/pan-briefing-service.js';

function proposal(revision = 1) {
  return {
    briefingId: '2026-09-05',
    revision,
    today: '2026-09-05',
    summary: 'A deliberately small day.',
    tasks: [
      {
        id: 'todoist:123',
        title: 'Review the contractor estimate',
        group: 'today',
        recommendation: 'today',
        reason: 'It blocks scheduling.',
        currentDate: '2026-09-05',
        proposedDate: '2026-09-05',
      },
    ],
  };
}

function review(action = 'revise') {
  return {
    briefingId: '2026-09-05',
    revision: 1,
    action,
    proposal: proposal(),
    generalFeedback: 'Keep the morning light.',
    tasks: [
      {
        id: 'todoist:123',
        decision: 'postpone',
        requestedDate: '2026-09-07',
        feedback: 'I can review it with the contractor then.',
      },
    ],
  };
}

test('a submitted full review resolves the matching pending wait', async () => {
  const broker = new BriefingBroker();
  broker.publish(proposal());

  const pending = broker.waitForReview('2026-09-05', 1);
  broker.submitReview(review());

  assert.deepEqual(await pending, review());
  assert.equal(broker.snapshot.phase, 'review-submitted');
  assert.throws(() => broker.submitReview(review()), /already been submitted/);
});

test('a review submitted before the agent waits is queued once', async () => {
  const broker = new BriefingBroker();
  broker.publish(proposal());
  broker.submitReview(review('approve'));

  assert.deepEqual(
    await broker.waitForReview('2026-09-05', 1),
    review('approve'),
  );
});

test('publishing requires a complete identifiable proposal', () => {
  const broker = new BriefingBroker();
  assert.throws(
    () => broker.publish({ briefingId: 'today', revision: 1 }),
    /tasks must be an array/,
  );
  assert.throws(
    () => broker.publish({
      briefingId: 'today',
      revision: 1,
      tasks: [{ id: 'task-without-title' }],
    }),
    /title must be a non-empty string/,
  );
  assert.throws(
    () => broker.publish({
      briefingId: 'today',
      revision: 1,
      tasks: [
        {
          id: 'duplicate',
          title: 'First',
          group: 'today',
          recommendation: 'today',
          reason: 'First reason.',
        },
        {
          id: 'duplicate',
          title: 'Second',
          group: 'not-today',
          recommendation: 'not today',
          reason: 'Second reason.',
        },
      ],
    }),
    /duplicate task id/,
  );
});

test('a review must account for the complete current proposal', () => {
  const broker = new BriefingBroker();
  broker.publish({
    ...proposal(),
    tasks: [
      ...proposal().tasks,
      {
        id: 'todoist:456',
        title: 'Second task',
        group: 'not-today',
        recommendation: 'not today',
        reason: 'It does not fit today.',
      },
    ],
  });

  assert.throws(
    () => broker.submitReview(review()),
    /account for every task/,
  );
});

test('a revised proposal must follow review and increase its revision', async () => {
  const broker = new BriefingBroker();
  broker.publish(proposal());
  assert.throws(
    () => broker.publish(proposal(2)),
    /must be reviewed/,
  );

  broker.submitReview(review());
  await broker.waitForReview('2026-09-05', 1);
  assert.throws(
    () => broker.publish(proposal()),
    /increase the revision/,
  );
  assert.equal(broker.publish(proposal(2)).proposal.revision, 2);
});

test('the HTTP review endpoint delivers a review and serves the UI', async (t) => {
  const broker = new BriefingBroker();
  const service = createBriefingHttpServer(broker);
  const address = await service.listen({ port: 0 });
  t.after(() => service.close());

  const page = await fetch(address.url);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /Pan Daily Briefing/);
  assert.match(html, /completion-summary/);
  assert.match(html, /completion-details/);
  assert.doesNotMatch(html, /completion-result/);

  const app = await fetch(`${address.url}/app.js`);
  assert.equal(app.status, 200);
  const appSource = await app.text();
  assert.match(appSource, /function renderCompletion/);
  assert.doesNotMatch(
    appSource,
    /JSON\.stringify\(snapshot\.completion/,
  );

  broker.publish(proposal());
  const pending = broker.waitForReview('2026-09-05', 1);
  const response = await fetch(
    `${address.url}/api/briefings/2026-09-05/review`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(review()),
    },
  );

  assert.equal(response.status, 202);
  assert.equal((await response.json()).phase, 'review-submitted');
  assert.deepEqual(await pending, review());
});

test('the HTTP endpoint rejects a stale briefing revision', async (t) => {
  const broker = new BriefingBroker();
  const service = createBriefingHttpServer(broker);
  const address = await service.listen({ port: 0 });
  t.after(() => service.close());
  broker.publish(proposal(2));

  const response = await fetch(
    `${address.url}/api/briefings/2026-09-05/review`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(review()),
    },
  );

  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /does not match/);
});

test('the stdio MCP protocol exposes tools and holds await until review', async (t) => {
  const broker = new BriefingBroker();
  const input = new PassThrough();
  const output = new PassThrough();
  const protocol = runMcpProtocol({ broker, input, output, logger: () => {} });
  t.after(() => {
    protocol.close();
    input.destroy();
    output.destroy();
  });

  let buffered = '';
  const responses = new Map();
  output.setEncoding('utf8');
  output.on('data', (chunk) => {
    buffered += chunk;
    const lines = buffered.split('\n');
    buffered = lines.pop();
    for (const line of lines) {
      if (!line) continue;
      const message = JSON.parse(line);
      responses.get(message.id)?.resolve(message);
    }
  });

  function request(id, method, params = {}) {
    const response = Promise.withResolvers();
    responses.set(id, response);
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return response.promise;
  }

  const initialized = await request(1, 'initialize', { protocolVersion: '2025-06-18' });
  assert.equal(initialized.result.serverInfo.name, 'pan-briefing');

  const listed = await request(2, 'tools/list');
  assert.deepEqual(
    listed.result.tools.map((tool) => tool.name),
    ['publish_briefing', 'await_briefing_review', 'complete_briefing'],
  );

  const published = await request(3, 'tools/call', {
    name: 'publish_briefing',
    arguments: { proposal: proposal() },
  });
  assert.equal(published.result.isError, undefined);

  const waiting = request(4, 'tools/call', {
    name: 'await_briefing_review',
    arguments: { briefingId: '2026-09-05', revision: 1 },
  });
  const race = await Promise.race([
    waiting.then(() => 'resolved'),
    new Promise((resolve) => setTimeout(() => resolve('pending'), 20)),
  ]);
  assert.equal(race, 'pending');

  broker.submitReview(review());
  const delivered = await waiting;
  const content = JSON.parse(delivered.result.content[0].text);
  assert.deepEqual(content, review());
});

test('demo mode revises and completes without an MCP client', async () => {
  const broker = new BriefingBroker();
  const running = runDemoLoop(broker);
  const first = broker.snapshot.proposal;
  assert.equal(first.briefingId, 'demo-briefing');
  assert.equal(first.tasks.length, 5);

  broker.submitReview({
    briefingId: first.briefingId,
    revision: first.revision,
    action: 'revise',
    proposal: first,
    generalFeedback: 'Make the day lighter.',
    tasks: first.tasks.map((task) => ({
      id: task.id,
      decision: task.id === 'demo:estimate' ? 'disagree' : 'accept',
      requestedDate: null,
      feedback: task.id === 'demo:estimate'
        ? 'Sometime next week, preferably on a quiet day.'
        : null,
    })),
  });
  await new Promise((resolve) => setImmediate(resolve));

  const second = broker.snapshot.proposal;
  assert.equal(second.revision, 2);
  const deferred = second.tasks.find((task) => task.id === 'demo:estimate');
  assert.equal(deferred.group, 'not-today');
  assert.equal(deferred.proposedDate, null);
  assert.equal(
    deferred.planningGuidance,
    'Sometime next week, preferably on a quiet day.',
  );
  assert.match(deferred.feedbackResponse, /guidance was incorporated/i);

  broker.submitReview({
    briefingId: second.briefingId,
    revision: second.revision,
    action: 'approve',
    proposal: second,
    generalFeedback: '',
    tasks: second.tasks.map((task) => ({
      id: task.id,
      decision: 'accept',
      requestedDate: task.proposedDate,
      feedback: null,
    })),
  });
  await running;

  assert.equal(broker.snapshot.phase, 'complete');
  assert.equal(broker.snapshot.completion.mode, 'demo');
});
