import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ensureIssueClosed,
  ensureIssueComment,
} from '../bin/pan-issue-lifecycle.js';

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
