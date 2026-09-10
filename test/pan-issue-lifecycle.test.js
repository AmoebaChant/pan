import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ensureIssueClosed,
  ensureIssueComment,
  ensureIssueRejected,
  updateIssueCurrentAction,
} from '../bin/pan-issue-lifecycle.js';
import {
  parseCurrentActionBlock,
  renderCurrentActionBlock,
} from '../bin/pan-task-model.js';

test('completion closes and confirms an open Issue', async () => {
  const calls = [];
  let state = 'OPEN';
  const runGh = async (args) => {
    calls.push(args);
    if (args[1] === 'view') {
      return JSON.stringify({
        state,
        stateReason: state === 'CLOSED' ? 'COMPLETED' : null,
      });
    }
    if (args[1] === 'close') {
      state = 'CLOSED';
      return '';
    }
    throw new Error(`Unexpected gh call: ${args.join(' ')}`);
  };

  await ensureIssueClosed(runGh, 'example/tasks', 42);

  assert.deepEqual(calls, [
    [
      'issue',
      'view',
      '42',
      '--repo',
      'example/tasks',
      '--json',
      'state,stateReason',
    ],
    [
      'issue',
      'close',
      '42',
      '--repo',
      'example/tasks',
      '--reason',
      'completed',
    ],
    [
      'issue',
      'view',
      '42',
      '--repo',
      'example/tasks',
      '--json',
      'state,stateReason',
    ],
  ]);
});

test('completion leaves an already closed Issue unchanged', async () => {
  const calls = [];
  const runGh = async (args) => {
    calls.push(args);
    return JSON.stringify({ state: 'CLOSED', stateReason: 'COMPLETED' });
  };

  await ensureIssueClosed(runGh, 'example/tasks', 42);

  assert.deepEqual(calls, [
    [
      'issue',
      'view',
      '42',
      '--repo',
      'example/tasks',
      '--json',
      'state,stateReason',
    ],
  ]);
});

test('completion fails when GitHub does not confirm closure', async () => {
  const runGh = async (args) =>
    args[1] === 'view'
      ? JSON.stringify({ state: 'OPEN', stateReason: null })
      : '';

  await assert.rejects(
    ensureIssueClosed(runGh, 'example/tasks', 42),
    /did not confirm closure/,
  );
});

test('completion rejects an Issue closed as not planned', async () => {
  const runGh = async () =>
    JSON.stringify({ state: 'CLOSED', stateReason: 'NOT_PLANNED' });

  await assert.rejects(
    ensureIssueClosed(runGh, 'example/tasks', 42),
    /closed as NOT_PLANNED, not completed/,
  );
});

test('rejection closes and verifies an Issue as not planned', async () => {
  let issue = { state: 'OPEN', stateReason: null };
  const runGh = async (args) => {
    if (args[0] === 'issue' && args[1] === 'view') return JSON.stringify(issue);
    if (args[0] === 'issue' && args[1] === 'close') {
      assert.equal(args[args.indexOf('--reason') + 1], 'not planned');
      issue = { state: 'CLOSED', stateReason: 'NOT_PLANNED' };
      return '';
    }
    throw new Error('unexpected call');
  };
  await ensureIssueRejected(runGh, 'example/domain', 6);
  assert.equal(issue.stateReason, 'NOT_PLANNED');
});

test('completion comments are added once with a durable marker', async () => {
  const calls = [];
  const marker = '<!-- pan-result:session-42 -->';
  let comments = [];
  const runGh = async (args) => {
    calls.push(args);
    if (args[0] === 'api') return JSON.stringify([comments]);
    if (args[1] === 'comment') {
      comments = [{ body: args.at(-1) }];
      return '';
    }
    throw new Error(`Unexpected gh call: ${args.join(' ')}`);
  };

  await ensureIssueComment(
    runGh,
    'example/tasks',
    42,
    marker,
    'Worker finished.',
  );
  await ensureIssueComment(
    runGh,
    'example/tasks',
    42,
    marker,
    'Worker finished.',
  );

  assert.equal(calls.filter((args) => args[1] === 'comment').length, 1);
  assert.match(comments[0].body, /Worker finished\./);
  assert.match(comments[0].body, /pan-result:session-42/);
});

test('comment markers require exact canonical placement and ignore near matches', async () => {
  const marker = '<!-- pan-result:session-42:generation-1 -->';
  const comments = [{ body: `quoted ${marker} text is not a receipt` }];
  let created = 0;
  const runGh = async (args) => {
    if (args[0] === 'api') return JSON.stringify([comments]);
    if (args[0] === 'issue' && args[1] === 'comment') {
      created += 1;
      comments.push({ body: args[args.indexOf('--body') + 1] });
      return '';
    }
    throw new Error('unexpected call');
  };

  await ensureIssueComment(runGh, 'example/tasks', 42, marker, 'Worker finished.');

  assert.equal(created, 1);
  assert.equal(comments.at(-1).body, `Worker finished.\n\n${marker}`);
});

test('comment markers reject duplicate exact receipts and non-canonical placement', async () => {
  const marker = 'Pan: task transition 7';
  await assert.rejects(
    ensureIssueComment(
      async () => JSON.stringify([[
        { body: `${marker}\n\nFirst.` },
        { body: `${marker}\n\nSecond.` },
      ]]),
      'example/tasks',
      42,
      marker,
      `${marker}\n\nTransition.`,
    ),
    /duplicate exact marker/,
  );
  await assert.rejects(
    ensureIssueComment(
      async () => JSON.stringify([[{ body: `Prefix\n${marker}\n\nTransition.` }]]),
      'example/tasks',
      42,
      marker,
      `${marker}\n\nTransition.`,
    ),
    /non-canonical placement/,
  );
});

test('comment creation re-reads and refuses success without the canonical receipt', async () => {
  const marker = '<!-- pan-result:session-42 -->';
  let writes = 0;
  const runGh = async (args) => {
    if (args[0] === 'api') return JSON.stringify([[]]);
    if (args[0] === 'issue' && args[1] === 'comment') {
      writes += 1;
      return '';
    }
    throw new Error('unexpected call');
  };

  await assert.rejects(
    ensureIssueComment(runGh, 'example/tasks', 42, marker, 'Worker finished.'),
    /did not verify exactly one canonical marker/,
  );
  assert.equal(writes, 1);
});

test('current-next-action updates preserve body content and add idempotent transition history', async () => {
  let body = [
    '# Outcome',
    '',
    'Keep this context.',
    '',
    renderCurrentActionBlock({
      status: 'ready-for-human',
      action: 'approve',
      detail: 'Approve the rollout.',
      revision: 2,
      updatedAt: '2026-09-10T05:00:00Z',
    }),
  ].join('\n');
  const comments = [];
  const calls = [];
  const runGh = async (args) => {
    calls.push(args);
    if (args[0] === 'issue' && args[1] === 'view' && args.includes('body')) {
      return JSON.stringify({ body });
    }
    if (args[0] === 'issue' && args[1] === 'edit') {
      body = args[args.indexOf('--body') + 1];
      return '';
    }
    if (args[0] === 'api') return JSON.stringify([comments]);
    if (args[0] === 'issue' && args[1] === 'comment') {
      comments.push({ body: args[args.indexOf('--body') + 1] });
      return '';
    }
    throw new Error(`unexpected call ${args.join(' ')}`);
  };

  await updateIssueCurrentAction(runGh, 'example/domain', 4, {
    expectedRevision: 2,
    revision: 3,
    status: 'ready-for-ai',
    action: 'execute',
    detail: 'Run the approved rollout.',
    actor: 'test-runner',
    claimGeneration: 'generation',
    fromStatus: 'ready-for-human',
    fromAction: 'approve',
    updatedAt: '2026-09-10T05:05:00Z',
  });
  await updateIssueCurrentAction(runGh, 'example/domain', 4, {
    expectedRevision: 3,
    revision: 3,
    status: 'ready-for-ai',
    action: 'execute',
    detail: 'Run the approved rollout.',
    actor: 'test-runner',
    claimGeneration: 'generation',
    fromStatus: 'ready-for-human',
    fromAction: 'approve',
    updatedAt: '2026-09-10T05:05:00Z',
  });

  assert.match(body, /Keep this context/);
  assert.equal(parseCurrentActionBlock(body).revision, 3);
  assert.equal(comments.length, 1);
  assert.match(comments[0].body, /^Pan: task transition 3/);
  assert.equal(calls.filter((args) => args[0] === 'issue' && args[1] === 'edit').length, 1);
});

test('current-next-action update rejects a stale Issue body revision', async () => {
  const body = renderCurrentActionBlock({
    status: 'ready-for-human',
    action: 'review',
    detail: 'Review the artifact.',
    revision: 8,
    updatedAt: '2026-09-10T05:00:00Z',
  });
  const runGh = async (args) => {
    if (args[0] === 'issue' && args[1] === 'view') return JSON.stringify({ body });
    throw new Error('no write expected');
  };
  await assert.rejects(
    updateIssueCurrentAction(runGh, 'example/domain', 5, {
      expectedRevision: 7,
      revision: 8,
      status: 'done',
      action: 'none',
      detail: 'Complete.',
      actor: 'test',
    }),
    /expected 7/,
  );
});
