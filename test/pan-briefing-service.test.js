import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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

function approval(current = proposal()) {
  return {
    briefingId: current.briefingId,
    revision: current.revision,
    action: 'approve',
    proposal: current,
    generalFeedback: '',
    tasks: current.tasks.map((task) => ({
      id: task.id,
      decision: 'accept',
      requestedDate: task.proposedDate ?? null,
      feedback: null,
    })),
  };
}

function dualTrackProposal() {
  return {
    briefingId: '2026-09-13',
    revision: 1,
    today: '2026-09-13',
    summary: 'Human attention and useful agent throughput.',
    tasks: [
      {
        id: 'task:sessionless-bug',
        title: 'Investigate an intermittent export failure',
        url: 'https://example.test/tasks/sessionless-bug',
        group: 'agent-starts',
        recommendation: 'Start a new investigation conversation',
        reason: 'The task is clear and useful despite having no date, label, or session.',
        currentDate: null,
        proposedDate: null,
        humanDateAction: 'keep',
        agentAction: 'request-new',
        agentAuthorization: 'approval-required',
        workMode: 'investigation conversation',
        expectedOutcome: 'A reproduction and bounded implementation recommendation.',
        laterHumanCheckpoint: 'Uncertain.',
      },
      {
        id: 'task:resume',
        title: 'Continue the prepared migration',
        url: 'https://example.test/tasks/resume',
        group: 'agent-starts',
        recommendation: 'Resume the existing session',
        reason: 'The session is safely released and the next step remains authorized.',
        currentDate: '2026-09-20',
        proposedDate: null,
        humanDateAction: 'keep',
        agentAction: 'request-resume',
        agentAuthorization: 'standing',
        playbook: 'bounded-migration',
        expectedOutcome: 'Complete the verified migration.',
        laterHumanCheckpoint: 'Not expected.',
      },
      {
        id: 'task:checkpoint',
        title: 'Review the prepared release',
        group: 'needs-attention',
        recommendation: 'Handle this checkpoint later',
        reason: 'The worker is waiting, but it need not displace today’s commitments.',
        currentDate: null,
        proposedDate: null,
        humanDateAction: 'keep',
        agentAction: 'none',
        agentAuthorization: 'already-requested',
        checkpointPriority: 'later',
        requestedHumanAction: 'Review the release evidence.',
        terminalContext: 'Use the associated worker terminal.',
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
  const approved = review('approve');
  approved.generalFeedback = '';
  approved.tasks[0].decision = 'accept';
  broker.submitReview(approved);

  assert.deepEqual(
    await broker.waitForReview('2026-09-05', 1),
    approved,
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

test('dual-track proposals preserve no-op dates and one-row checkpoints', () => {
  const broker = new BriefingBroker();
  const published = broker.publish(dualTrackProposal()).proposal;

  const newEngagement = published.tasks.find((task) => task.id === 'task:sessionless-bug');
  assert.equal(newEngagement.group, 'agent-starts');
  assert.equal(newEngagement.agentAction, 'request-new');
  assert.equal(newEngagement.humanDateAction, 'keep');
  assert.equal(newEngagement.proposedDate, null);

  const resume = published.tasks.find((task) => task.id === 'task:resume');
  assert.equal(resume.agentAction, 'request-resume');
  assert.equal(resume.currentDate, '2026-09-20');
  assert.equal(resume.humanDateAction, 'keep');

  const checkpoints = published.tasks.filter((task) => task.id === 'task:checkpoint');
  assert.equal(checkpoints.length, 1);
  assert.equal(checkpoints[0].checkpointPriority, 'later');
});

test('agent-start proposals require a complete, explicit engagement description', () => {
  const broker = new BriefingBroker();
  const proposalWithoutCheckpointExpectation = dualTrackProposal();
  delete proposalWithoutCheckpointExpectation.tasks[0].laterHumanCheckpoint;

  assert.throws(
    () => broker.publish(proposalWithoutCheckpointExpectation),
    /laterHumanCheckpoint must be a non-empty string/,
  );
});

test('proposal validation distinguishes keeping and clearing a human date', () => {
  const broker = new BriefingBroker();
  assert.throws(
    () => broker.publish({
      ...proposal(),
      tasks: [{
        ...proposal().tasks[0],
        humanDateAction: 'keep',
        proposedDate: '2026-09-05',
      }],
    }),
    /proposedDate must be null/,
  );
  assert.doesNotThrow(() => broker.publish({
    ...proposal(),
    tasks: [{
      ...proposal().tasks[0],
      humanDateAction: 'clear',
      proposedDate: null,
    }],
  }));
});

test('a review must account for the complete current proposal', () => {
  const broker = new BriefingBroker();
  const current = {
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
  };
  broker.publish(current);
  const incomplete = review();
  incomplete.proposal = current;

  assert.throws(
    () => broker.submitReview(incomplete),
    /account for every task/,
  );
});

test('negative feedback requires a revised proposal before approval', () => {
  const broker = new BriefingBroker();
  broker.publish(proposal());
  assert.throws(
    () => broker.submitReview(review('approve')),
    /incorporated into a revised proposal/,
  );
});

test('review snapshot must exactly match the published revision', () => {
  const broker = new BriefingBroker();
  broker.publish(proposal());
  const altered = review('approve');
  altered.proposal.tasks[0].reason = 'Changed in transit.';
  altered.tasks[0].decision = 'accept';
  altered.generalFeedback = '';
  assert.throws(
    () => broker.submitReview(altered),
    /published proposal/,
  );
});

test('review feedback cannot inject effects beyond the immutable proposal', async () => {
  const broker = new BriefingBroker();
  const humanProposal = proposal();
  broker.publish(humanProposal);
  const injected = approval(humanProposal);
  injected.agentAction = 'request-new';
  injected.tasks[0].agentAction = 'request-new';
  injected.tasks[0].humanDateAction = 'clear';
  broker.submitReview(injected);

  const delivered = await broker.waitForReview(
    humanProposal.briefingId,
    humanProposal.revision,
  );
  assert.equal(delivered.agentAction, undefined);
  assert.equal(delivered.tasks[0].agentAction, undefined);
  assert.equal(delivered.tasks[0].humanDateAction, undefined);
  assert.equal(delivered.proposal.tasks[0].agentAction, undefined);

  const agentBroker = new BriefingBroker();
  const agentProposal = dualTrackProposal();
  agentBroker.publish(agentProposal);
  agentBroker.submitReview(approval(agentProposal));
  const approved = await agentBroker.waitForReview(
    agentProposal.briefingId,
    agentProposal.revision,
  );
  assert.equal(
    approved.proposal.tasks.find((task) => task.id === 'task:sessionless-bug').agentAction,
    'request-new',
  );
  assert.equal(
    approved.tasks.find((task) => task.id === 'task:sessionless-bug').agentAction,
    undefined,
  );
});

test('completion requires approval of the exact current proposal revision', async () => {
  const broker = new BriefingBroker();
  const result = {
    status: 'confirmed',
    summary: 'The approved plan was applied and verified.',
  };
  assert.throws(
    () => broker.complete(result),
    /must be explicitly approved/,
  );

  broker.publish(proposal());
  broker.submitReview(review());
  await broker.waitForReview('2026-09-05', 1);
  assert.throws(
    () => broker.complete(result),
    /must be explicitly approved/,
  );

  const revised = proposal(2);
  broker.publish(revised);
  broker.submitReview(approval(revised));
  await broker.waitForReview(revised.briefingId, revised.revision);
  assert.equal(broker.complete(result).completion.status, 'confirmed');

  const republished = proposal(3);
  broker.publish(republished);
  assert.throws(
    () => broker.complete(result),
    /must be explicitly approved/,
  );
});

test('partial completion must report failures honestly', async () => {
  const broker = new BriefingBroker();
  const current = proposal();
  broker.publish(current);
  broker.submitReview(approval(current));
  await broker.waitForReview(current.briefingId, current.revision);
  assert.throws(
    () => broker.complete({
      status: 'partial',
      summary: 'Some writes completed.',
      partialFailures: [],
    }),
    /must describe partialFailures/,
  );
  assert.throws(
    () => broker.complete({
      status: 'failed',
      summary: 'No requested changes could be verified.',
      partialFailures: [],
    }),
    /must describe partialFailures/,
  );
  assert.throws(
    () => broker.complete({
      status: 'partial',
      summary: 'One failure was described, but another entry was malformed.',
      partialFailures: ['Attention request failed.', ''],
    }),
    /only non-empty strings/,
  );
  assert.throws(
    () => broker.complete({
      status: 'confirmed',
      summary: 'Everything succeeded.',
      partialFailures: ['The agent request failed.'],
    }),
    /confirmed completion cannot include partialFailures/,
  );
  const completed = broker.complete({
    status: 'partial',
    summary: 'The date write verified; the attention request failed.',
    confirmedHumanPlan: ['Review estimate'],
    agentsQueued: [],
    partialFailures: ['Attention request rejected because the task revision changed.'],
  });
  assert.equal(completed.completion.status, 'partial');
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
  assert.match(appSource, /Proposed agent starts/);
  assert.match(appSource, /Needs your attention/);
  assert.match(appSource, /Human date: unchanged/);
  assert.match(appSource, /Agents queued/);
  assert.match(appSource, /Partial failures/);
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
  const publishSchema = listed.result.tools.find((tool) => tool.name === 'publish_briefing');
  assert.deepEqual(
    publishSchema.inputSchema.properties.proposal.properties.tasks.items.properties.group.enum,
    ['today', 'agent-starts', 'needs-attention', 'not-today'],
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

test('agent momentum remains chief-owned, complete, and separate from the runner', async () => {
  const [momentum, runner, briefing] = await Promise.all([
    readFile(new URL('../system/agent-momentum.md', import.meta.url), 'utf8'),
    readFile(new URL('../system/runner.md', import.meta.url), 'utf8'),
    readFile(new URL('../system/daily-briefing.md', import.meta.url), 'utf8'),
  ]);

  assert.match(momentum, /every\s+eligible nonterminal task/i);
  assert.match(momentum, /future-dated, undated, unlabeled, and\s+sessionless/i);
  assert.match(momentum, /setting `agentStatus=requested`/i);
  assert.match(momentum, /runner and\s+workers never own momentum schedules/i);
  assert.match(runner, /does not inspect unrelated sessions, choose tasks/i);
  assert.match(briefing, /consider every eligible task/i);
});
