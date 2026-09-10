import assert from 'node:assert/strict';
import test from 'node:test';
import { parseLifecycleCli } from '../bin/pan-lifecycle-migrate.js';
import {
  applyLifecycleMigration,
  parseMigrationAuthorizations,
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
  }), {
    authorization: {
      itemId: 'item-1',
      playbook: 'tool-development',
      dependencies: '',
      executionAuthorized: true,
    },
  });
  assert.deepEqual(target, {
    executionAuthorized: 'yes',
    dependencies: '',
    workerState: 'idle',
    status: 'ready-for-ai',
    nextAction: 'execute',
    detail: 'Run the previously authorized ready agent task.',
    requiresCutoverHold: false,
    requiresAuthorization: false,
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
  ], {
    authorizations: [
      { itemId: 'one', playbook: 'tool-development', dependencies: '', executionAuthorized: true },
      { itemId: 'two', playbook: 'tool-development', dependencies: '', executionAuthorized: true },
    ],
  });
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

test('lifecycle apply CLI requires explicit authorization and writer exclusion acknowledgement', () => {
  assert.throws(
    () => parseLifecycleCli(['apply', '--config', '/config', '--checkout', '/pan']),
    /authorization/,
  );
  assert.deepEqual(
    parseLifecycleCli([
      'apply',
      '--config', '/config',
      '--checkout', '/pan',
      '--authorization', '/authorization.json',
      '--confirm-writers-stopped',
    ]),
    {
      help: false,
      command: 'apply',
      config: '/config',
      checkout: '/pan',
      authorization: '/authorization.json',
      report: undefined,
    },
  );
});

test('legacy agent work is not authorized without exact item, playbook, and dependency approval', () => {
  const task = legacy({ dependencies: 'Wait for #2' });
  const plan = planLifecycleMigration([task], {
    authorizations: [{
      itemId: task.itemId,
      playbook: task.playbook,
      dependencies: '',
      executionAuthorized: true,
    }],
  });
  assert.equal(plan.actions[0].action, 'requires-authorization');
  assert.equal(plan.actions[0].target.executionAuthorized, 'no');
});

test('migration authorization files reject incomplete or duplicate approvals', () => {
  assert.throws(
    () => parseMigrationAuthorizations({ format: 'wrong', version: 1, items: [] }),
    /not a Pan lifecycle/,
  );
  assert.throws(
    () => parseMigrationAuthorizations({
      format: 'pan-lifecycle-migration-authorization',
      version: 1,
      items: [
        { itemId: 'one', playbook: 'pb', dependencies: '', executionAuthorized: true },
        { itemId: 'one', playbook: 'pb', dependencies: '', executionAuthorized: true },
      ],
    }),
    /duplicate/,
  );
});

test('partial current tuples are repaired and retained paused sessions require cutover hold', () => {
  const partial = legacy({
    status: 'ready-for-human',
    nextAction: 'approve',
    legacyOwner: 'human',
    executionAuthorized: 'no',
    workerState: 'idle',
    revision: 4,
    currentActionStatus: 'ready-for-human',
    currentActionAction: 'approve',
    currentActionRevision: 3,
  });
  assert.equal(planLifecycleMigration([partial]).actions[0].action, 'repair-current');

  const paused = {
    ...partial,
    status: 'ready-for-ai',
    nextAction: 'execute',
    executionAuthorized: 'yes',
    workerState: 'paused',
    machine: 'machine-a',
    sessionId: 'session-a',
    claimGeneration: 'generation-a',
    currentActionStatus: 'ready-for-ai',
    currentActionAction: 'execute',
    currentActionRevision: 4,
  };
  assert.equal(planLifecycleMigration([paused]).actions[0].action, 'requires-cutover-hold');

  const terminalButRunning = {
    ...partial,
    status: 'done',
    nextAction: 'none',
    workerState: 'running',
    machine: 'machine-a',
    sessionId: 'session-a',
    claimGeneration: 'generation-a',
    currentActionStatus: 'done',
    currentActionAction: 'none',
    currentActionRevision: 4,
  };
  assert.equal(
    planLifecycleMigration([terminalButRunning]).actions[0].action,
    'requires-cutover-hold',
  );
});
