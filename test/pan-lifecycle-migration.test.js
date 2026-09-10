import assert from 'node:assert/strict';
import test from 'node:test';
import { parseLifecycleCli } from '../bin/pan-lifecycle-migrate.js';
import {
  applyLifecycleMigration,
  planLifecycleMigration,
  translateLegacyTask,
} from '../bin/pan-lifecycle-migration.js';

function legacy(overrides = {}) {
  return {
    itemId: 'item-1',
    url: 'https://github.com/example/domain/issues/1',
    status: 'ready',
    nextAction: '',
    legacyOwner: 'agent',
    priority: 'normal',
    nextActionDate: '2026-09-12',
    deadline: '2026-09-20',
    playbook: 'tool-development',
    workstream: 'product',
    dependencies: '',
    workerState: '',
    claimedBy: '',
    leaseUntil: '',
    machine: '',
    sessionId: '',
    revision: 0,
    ...overrides,
  };
}

test('legacy migration keeps stable outcomes and does not use dates as AI gates', () => {
  const target = translateLegacyTask(legacy({
    nextActionDate: '2030-01-01',
  }));
  assert.deepEqual(target, {
    executionAuthorized: 'yes',
    dependencies: '',
    workerState: 'idle',
    status: 'ready-for-ai',
    nextAction: 'execute',
    detail: 'Run the previously authorized ready agent task.',
    requiresCutoverHold: false,
  });
});

test('live legacy execution is flagged for operational cutover instead of mutated', () => {
  const plan = planLifecycleMigration([
    legacy({
      status: 'in-progress',
      claimedBy: 'old-runner',
      leaseUntil: '2026-09-10T01:00:00Z',
      machine: 'machine-a',
      sessionId: 'session',
    }),
  ], { now: Date.parse('2026-09-10T00:00:00Z') });
  assert.equal(plan.actions[0].action, 'requires-cutover-hold');
  assert.equal(plan.actions[0].target.status, 'ai-executing');
  assert.equal(plan.actions[0].target.workerState, 'running');
});

test('legacy blocked and review states become exact current actions', () => {
  assert.deepEqual(
    translateLegacyTask(legacy({ legacyOwner: 'human', status: 'blocked' })),
    {
      executionAuthorized: 'no',
      dependencies: '',
      workerState: 'idle',
      status: 'external-waiting',
      nextAction: 'wait',
      detail: 'Confirm the external event or dependency this task is waiting for.',
    },
  );
  assert.equal(
    translateLegacyTask(legacy({ status: 'in-review', sessionId: 'session' })).nextAction,
    'review',
  );
});

test('lifecycle apply continues independent items and reports partial state', async () => {
  const plan = planLifecycleMigration([
    legacy({ itemId: 'one' }),
    legacy({ itemId: 'two', url: 'https://github.com/example/domain/issues/2' }),
  ]);
  const visited = [];
  const store = {
    async migrateLegacyItem(action) {
      visited.push(action.itemId);
      if (action.itemId === 'one') throw new Error('stale item');
      return { itemId: action.itemId, outcome: 'migrated' };
    },
  };
  const report = await applyLifecycleMigration(plan, store);
  assert.deepEqual(visited, ['one', 'two']);
  assert.equal(report.partial, true);
  assert.equal(report.results[0].outcome, 'failed');
  assert.equal(report.results[1].outcome, 'migrated');
});

test('lifecycle apply CLI requires explicit binding and stopped-runner acknowledgement', () => {
  assert.throws(
    () => parseLifecycleCli(['apply', '--config', '/config', '--checkout', '/pan']),
    /confirm-runners-stopped/,
  );
  assert.deepEqual(
    parseLifecycleCli([
      'apply',
      '--config', '/config',
      '--checkout', '/pan',
      '--confirm-runners-stopped',
    ]),
    {
      help: false,
      command: 'apply',
      config: '/config',
      checkout: '/pan',
      report: undefined,
    },
  );
});
