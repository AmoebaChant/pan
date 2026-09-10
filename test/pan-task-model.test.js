import assert from 'node:assert/strict';
import test from 'node:test';
import {
  derivePrimaryView,
  legacyRecoveryTarget,
  parseCurrentActionBlock,
  parseRevision,
  renderCurrentActionBlock,
  upsertCurrentActionBlock,
  validLifecyclePair,
} from '../bin/pan-task-model.js';

test('the outcome/next-action matrix requires exact human actions', () => {
  for (const action of ['clarify', 'discuss', 'approve', 'review', 'act']) {
    assert.equal(validLifecyclePair('ready-for-human', action), true);
  }
  assert.equal(validLifecyclePair('ready-for-human', 'execute'), false);
  assert.equal(validLifecyclePair('ready-for-ai', 'execute'), true);
  assert.equal(validLifecyclePair('ai-executing', 'execute'), true);
  assert.equal(validLifecyclePair('external-waiting', 'wait'), true);
  assert.equal(validLifecyclePair('deliberate-hold', 'hold'), true);
  assert.equal(validLifecyclePair('done', 'none'), true);
  assert.equal(validLifecyclePair('rejected', 'none'), true);
  assert.equal(validLifecyclePair('paused', 'execute'), false);
});

test('current-next-action blocks preserve unrelated Issue content', () => {
  const first = renderCurrentActionBlock({
    status: 'ready-for-human',
    action: 'approve',
    detail: 'Approve the rollout.',
    revision: 4,
    updatedAt: '2026-09-10T05:00:00Z',
  });
  const body = upsertCurrentActionBlock('# Outcome\n\nKeep this context.', first);
  assert.match(body, /Keep this context/);
  assert.deepEqual(
    parseCurrentActionBlock(body),
    {
      status: 'ready-for-human',
      action: 'approve',
      detail: 'Approve the rollout.',
      revision: 4,
      updatedAt: '2026-09-10T05:00:00.000Z',
      start: body.indexOf('<!-- pan-current-next-action:start -->'),
      end: body.indexOf('<!-- pan-current-next-action:end -->')
        + '<!-- pan-current-next-action:end -->'.length,
      block: first,
    },
  );

  const second = renderCurrentActionBlock({
    status: 'ready-for-ai',
    action: 'execute',
    detail: 'Run the approved rollout.',
    revision: 5,
    updatedAt: '2026-09-10T05:05:00Z',
  });
  const revised = upsertCurrentActionBlock(body, second);
  assert.match(revised, /Keep this context/);
  assert.equal(parseCurrentActionBlock(revised).revision, 5);
  assert.equal((revised.match(/pan-current-next-action:start/g) ?? []).length, 1);
});

test('malformed revisions and duplicate current-action blocks fail closed', () => {
  assert.throws(() => parseRevision('-1'), /non-negative/);
  assert.throws(() => parseRevision('01'), /non-negative/);
  const block = renderCurrentActionBlock({
    status: 'done',
    action: 'none',
    detail: '',
    revision: 1,
    updatedAt: '2026-09-10T05:00:00Z',
  });
  assert.throws(() => parseCurrentActionBlock(`${block}\n${block}`), /duplicate/);
});

test('primary views are exclusive while All tasks remains complete', () => {
  const today = '2026-09-09';
  const cases = [
    [{ status: 'ready-for-human', nextActionDate: today }, 'today'],
    [{ status: 'ready-for-human', nextActionDate: '' }, 'needs-me'],
    [{ status: 'ready-for-human', nextActionDate: '2026-09-08' }, 'needs-me'],
    [{ status: 'ready-for-human', nextActionDate: '2026-09-10' }, 'all-only'],
    [{ status: 'ready-for-ai', nextActionDate: '' }, 'in-motion'],
    [{ status: 'ai-executing', nextActionDate: '' }, 'in-motion'],
    [{ status: 'external-waiting', nextActionDate: '' }, 'in-motion'],
    [{ status: 'deliberate-hold', nextActionDate: '' }, 'all-only'],
    [{ status: 'done', nextActionDate: '', updatedAt: '2026-09-09T10:00:00Z' }, 'recent'],
  ];
  for (const [task, expected] of cases) {
    assert.equal(derivePrimaryView(task, today, '2026-09-01T00:00:00Z'), expected);
  }
});

test('recovery mapping translates current live state instead of a stale baseline', () => {
  assert.deepEqual(
    legacyRecoveryTarget({
      status: 'ready-for-human',
      action: 'clarify',
      workerState: 'idle',
    }),
    { owner: 'human', status: 'needs-detail' },
  );
  assert.deepEqual(
    legacyRecoveryTarget({
      status: 'ai-executing',
      action: 'execute',
      workerState: 'checkpointed',
    }),
    { owner: 'agent', status: 'paused' },
  );
  assert.deepEqual(
    legacyRecoveryTarget({
      status: 'deliberate-hold',
      action: 'hold',
      workerState: 'stopped',
    }),
    { owner: 'human', status: 'blocked' },
  );
});
