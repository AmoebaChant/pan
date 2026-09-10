import assert from 'node:assert/strict';
import test from 'node:test';
import { parseLifecycleCli } from '../bin/pan-lifecycle-migrate.js';
import {
  applyLifecycleMigration,
  applyLifecycleRollback,
  parseMigrationAuthorizations,
  planLifecycleMigration,
  planLifecycleRollback,
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
    claimGeneration: '',
    resourceSemantics: '',
    issueState: 'OPEN',
    issueStateReason: null,
    projection: 'projection-1',
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
    'invalid-state',
  );
});

test('closed nonterminal legacy, current, and durable hold tasks require reconciliation', () => {
  const cases = [
    {
      name: 'legacy',
      task: legacy({
        legacyOwner: 'human',
        status: 'ready',
      }),
      openAction: 'migrate',
    },
    {
      name: 'current',
      task: legacy({
        status: 'ready-for-human',
        nextAction: 'act',
        executionAuthorized: 'no',
        workerState: 'idle',
        revision: 4,
        currentActionStatus: 'ready-for-human',
        currentActionAction: 'act',
        currentActionRevision: 4,
      }),
      openAction: 'already-current',
    },
    {
      name: 'durable hold',
      task: legacy({
        legacyOwner: 'human',
        status: 'blocked',
        workerState: 'checkpointed',
        machine: 'machine-a',
        sessionId: 'session-a',
        claimGeneration: 'generation-a',
        revision: 4,
        currentActionStatus: 'deliberate-hold',
        currentActionAction: 'hold',
        currentActionRevision: 4,
        nextActionDetail: 'Hold until the user deliberately resumes this outcome.',
      }),
      openAction: 'migrate',
    },
  ];

  for (const entry of cases) {
    const open = planLifecycleMigration([entry.task]).actions[0];
    assert.equal(open.action, entry.openAction, `${entry.name} open counterpart`);

    const closed = planLifecycleMigration([{
      ...entry.task,
      issueState: 'CLOSED',
      issueStateReason: 'COMPLETED',
    }]).actions[0];
    assert.equal(closed.action, 'invalid-state', entry.name);
    assert.match(closed.reason, /closed Issue.*nonterminal.*reconciliation/i, entry.name);
  }

  const terminal = legacy({
    status: 'done',
    nextAction: 'none',
    executionAuthorized: 'no',
    workerState: 'stopped',
    revision: 4,
    currentActionStatus: 'done',
    currentActionAction: 'none',
    currentActionRevision: 4,
    nextActionDate: '',
    issueState: 'CLOSED',
    issueStateReason: 'COMPLETED',
  });
  assert.equal(planLifecycleMigration([terminal]).actions[0].action, 'already-current');
  assert.notEqual(
    planLifecycleMigration([{
      ...terminal,
      issueStateReason: 'NOT_PLANNED',
    }]).actions[0].action,
    'already-current',
  );
});

test('migration apply skips closed nonterminal blockers and applies valid open counterparts', async () => {
  const closed = [
    legacy({
      itemId: 'closed-legacy',
      legacyOwner: 'human',
      status: 'ready',
      issueState: 'CLOSED',
      issueStateReason: 'COMPLETED',
    }),
    legacy({
      itemId: 'closed-current',
      status: 'ready-for-human',
      nextAction: 'act',
      executionAuthorized: 'no',
      workerState: 'idle',
      revision: 4,
      currentActionStatus: 'ready-for-human',
      currentActionAction: 'act',
      currentActionRevision: 3,
      issueState: 'CLOSED',
      issueStateReason: 'COMPLETED',
    }),
    legacy({
      itemId: 'closed-hold',
      legacyOwner: 'human',
      status: 'blocked',
      workerState: 'checkpointed',
      machine: 'machine-a',
      sessionId: 'session-a',
      claimGeneration: 'generation-a',
      revision: 4,
      currentActionStatus: 'deliberate-hold',
      currentActionAction: 'hold',
      currentActionRevision: 4,
      nextActionDetail: 'Hold until the user deliberately resumes this outcome.',
      issueState: 'CLOSED',
      issueStateReason: 'COMPLETED',
    }),
  ];
  const open = closed.map((task) => ({
    ...task,
    itemId: task.itemId.replace('closed', 'open'),
    issueState: 'OPEN',
    issueStateReason: null,
  }));
  const plan = planLifecycleMigration([...closed, ...open]);
  assert.deepEqual(
    plan.actions.map((action) => action.action),
    ['invalid-state', 'invalid-state', 'invalid-state', 'migrate', 'repair-current', 'migrate'],
  );

  const visited = [];
  const report = await applyLifecycleMigration(plan, {
    async migrateLegacyItem(action) {
      visited.push(action.itemId);
      return { itemId: action.itemId, outcome: 'migrated' };
    },
  });

  assert.deepEqual(visited, ['open-legacy', 'open-current', 'open-hold']);
  assert.equal(report.partial, true);
  assert.deepEqual(
    report.results.slice(0, 3).map((result) => result.action),
    ['invalid-state', 'invalid-state', 'invalid-state'],
  );
});

test('terminal provenance migrates safely while terminal active or uncertain evidence fails closed', () => {
  const provenance = planLifecycleMigration([
    legacy({
      status: 'done',
      machine: 'machine-a',
      sessionId: 'session-a',
      claimGeneration: 'generation-a',
    }),
  ]).actions[0];
  assert.equal(provenance.action, 'migrate');
  assert.equal(provenance.target.status, 'done');
  assert.equal(provenance.target.workerState, 'stopped');
  assert.equal(provenance.preserve.resourceSemantics, 'historical-provenance');

  for (const workerState of ['running', 'uncertain']) {
    const unsafe = planLifecycleMigration([
      legacy({
        status: 'done',
        workerState,
        claimedBy: workerState === 'running' ? 'runner-a' : '',
        leaseUntil: workerState === 'running' ? '2026-09-10T03:00:00Z' : '',
        machine: 'machine-a',
        sessionId: 'session-a',
        claimGeneration: 'generation-a',
      }),
    ]).actions[0];
    assert.equal(unsafe.action, 'invalid-state', workerState);
  }
});

test('durable deliberate hold migrates with passive affinity but ambiguous blocked state does not', () => {
  const held = planLifecycleMigration([
    legacy({
      legacyOwner: 'human',
      status: 'blocked',
      workerState: 'checkpointed',
      machine: 'machine-a',
      sessionId: 'session-a',
      claimGeneration: 'generation-a',
      revision: 4,
      currentActionStatus: 'deliberate-hold',
      currentActionAction: 'hold',
      currentActionRevision: 4,
      nextActionDetail: 'Hold until the user deliberately resumes this outcome.',
    }),
  ]).actions[0];
  assert.equal(held.action, 'migrate');
  assert.equal(held.target.status, 'deliberate-hold');
  assert.equal(held.target.nextAction, 'hold');
  assert.equal(held.target.workerState, 'checkpointed');
  assert.equal(held.preserve.resourceSemantics, 'held-affinity');

  const ambiguous = planLifecycleMigration([
    legacy({
      legacyOwner: 'human',
      status: 'blocked',
      workerState: 'checkpointed',
      machine: 'machine-a',
      sessionId: 'session-a',
      claimGeneration: 'generation-a',
    }),
  ]).actions[0];
  assert.equal(ambiguous.action, 'requires-cutover-hold');
  assert.equal(ambiguous.target.status, 'external-waiting');
});

test('deliberate hold migration refuses an open human checkpoint but accepts the cleared hold', () => {
  const held = legacy({
    legacyOwner: 'human',
    status: 'blocked',
    workerState: 'checkpointed',
    needsHumanSince: '2026-09-10T01:30:00Z',
    machine: 'machine-a',
    sessionId: 'session-a',
    claimGeneration: 'generation-a',
    revision: 4,
    currentActionStatus: 'deliberate-hold',
    currentActionAction: 'hold',
    currentActionRevision: 4,
    nextActionDetail: 'Hold until the user deliberately resumes this outcome.',
  });
  const blocked = planLifecycleMigration([held]).actions[0];
  assert.equal(blocked.action, 'requires-cutover-hold');
  assert.equal(blocked.preserve.resourceSemantics, '');

  const cleared = planLifecycleMigration([{
    ...held,
    needsHumanSince: '',
  }]).actions[0];
  assert.equal(cleared.action, 'migrate');
  assert.equal(cleared.preserve.resourceSemantics, 'held-affinity');

  const withoutAffinity = planLifecycleMigration([{
    ...held,
    needsHumanSince: '',
    workerState: 'idle',
    machine: '',
    sessionId: '',
    claimGeneration: '',
  }]).actions[0];
  assert.equal(withoutAffinity.action, 'migrate');
  assert.equal(withoutAffinity.preserve.resourceSemantics, '');
});

test('active human review remains a hard cutover blocker', () => {
  const action = planLifecycleMigration([
    legacy({
      legacyOwner: 'human',
      status: 'in-review',
      workerState: 'waiting-human',
      needsHumanSince: '2026-09-10T01:30:00Z',
      claimedBy: 'runner-a',
      leaseUntil: '2026-09-10T03:00:00Z',
      machine: 'machine-a',
      sessionId: 'session-a',
      claimGeneration: 'generation-a',
    }),
  ], { now: Date.parse('2026-09-10T02:00:00Z') }).actions[0];
  assert.equal(action.action, 'requires-cutover-hold');
  assert.equal(action.target.status, 'ready-for-human');
  assert.equal(action.target.nextAction, 'review');
});

test('migration holds ambiguous resource-bearing human-facing legacy items', () => {
  for (const status of ['in-review', 'blocked', 'ready']) {
    const action = planLifecycleMigration([
      legacy({
        legacyOwner: 'human',
        status,
        machine: 'machine-a',
        sessionId: 'session-a',
        claimGeneration: 'generation-a',
        workerState: 'checkpointed',
      }),
    ]).actions[0];
    assert.equal(action.action, 'requires-cutover-hold', status);
    assert.equal(action.expected.playbook, 'tool-development');
    assert.equal(action.expected.projection, 'projection-1');
  }
});

test('migration rejects ownerless executing and running tuples', () => {
  const current = legacy({
    status: 'ai-executing',
    nextAction: 'execute',
    executionAuthorized: 'yes',
    workerState: 'running',
    revision: 4,
    currentActionStatus: 'ai-executing',
    currentActionAction: 'execute',
    currentActionRevision: 4,
  });
  const action = planLifecycleMigration([current]).actions[0];
  assert.equal(action.action, 'invalid-state');
  assert.match(action.reason, /owner tuple/);
});

test('migration rejects an ambiguous Issue action block instead of attempting repair', () => {
  const action = planLifecycleMigration([
    legacy({
      status: 'ready-for-human',
      nextAction: 'act',
      executionAuthorized: 'no',
      workerState: 'idle',
      revision: 3,
      bodyConflict: 'multiple current-action blocks',
    }),
  ]).actions[0];
  assert.equal(action.action, 'invalid-state');
  assert.match(action.reason, /multiple current-action blocks/);
});

test('rollback dry-run derives only current live state and flags unsafe execution', () => {
  const current = legacy({
    status: 'ready-for-human',
    nextAction: 'approve',
    legacyOwner: 'unassigned',
    executionAuthorized: 'no',
    workerState: 'idle',
    revision: 4,
    currentActionStatus: 'ready-for-human',
    currentActionAction: 'approve',
    currentActionRevision: 4,
    nextActionDetail: 'Approve the rollout.',
  });
  const plan = planLifecycleRollback([current]);
  assert.equal(plan.source, 'current-live-state');
  assert.equal(plan.actions[0].action, 'rollback');
  assert.deepEqual(plan.actions[0].legacyTarget, { owner: 'human', status: 'ready' });
  assert.equal(plan.actions[0].expected.projection, 'projection-1');

  const unsafe = planLifecycleRollback([{
    ...current,
    status: 'ai-executing',
    nextAction: 'execute',
    workerState: 'running',
    claimedBy: '',
    leaseUntil: '',
    currentActionStatus: 'ai-executing',
    currentActionAction: 'execute',
  }]).actions[0];
  assert.equal(unsafe.action, 'invalid-state');

  const terminalProvenance = planLifecycleRollback([{
    ...current,
    status: 'done',
    nextAction: 'none',
    workerState: 'stopped',
    machine: 'machine-a',
    sessionId: 'session-a',
    claimGeneration: 'generation-a',
    resourceSemantics: 'historical-provenance',
    issueState: 'CLOSED',
    issueStateReason: 'COMPLETED',
    currentActionStatus: 'done',
    currentActionAction: 'none',
  }]).actions[0];
  assert.equal(terminalProvenance.action, 'rollback');
  assert.deepEqual(terminalProvenance.legacyTarget, { owner: 'unassigned', status: 'done' });

  const heldAffinity = planLifecycleRollback([{
    ...current,
    status: 'deliberate-hold',
    nextAction: 'hold',
    workerState: 'checkpointed',
    machine: 'machine-a',
    sessionId: 'session-a',
    claimGeneration: 'generation-a',
    currentActionStatus: 'deliberate-hold',
    currentActionAction: 'hold',
    nextActionDetail: 'Hold until the user deliberately resumes this outcome.',
    resourceSemantics: 'held-affinity',
  }]).actions[0];
  assert.equal(heldAffinity.action, 'rollback');
  assert.deepEqual(heldAffinity.legacyTarget, { owner: 'human', status: 'blocked' });

  const openCheckpoint = planLifecycleRollback([{
    ...current,
    status: 'deliberate-hold',
    nextAction: 'hold',
    workerState: 'checkpointed',
    needsHumanSince: '2026-09-10T01:30:00Z',
    machine: 'machine-a',
    sessionId: 'session-a',
    claimGeneration: 'generation-a',
    resourceSemantics: 'held-affinity',
    currentActionStatus: 'deliberate-hold',
    currentActionAction: 'hold',
    nextActionDetail: 'Hold until the user deliberately resumes this outcome.',
  }]).actions[0];
  assert.equal(openCheckpoint.action, 'invalid-state');
  assert.match(openCheckpoint.reason, /open human checkpoint/);
});

test('rollback apply continues independent items and treats a fresh re-plan as idempotent', async () => {
  const current = legacy({
    status: 'external-waiting',
    nextAction: 'wait',
    legacyOwner: 'unassigned',
    executionAuthorized: 'no',
    workerState: 'idle',
    revision: 6,
    currentActionStatus: 'external-waiting',
    currentActionAction: 'wait',
    currentActionRevision: 6,
    nextActionDetail: 'Wait for the permit.',
  });
  const plan = planLifecycleRollback([current]);
  const visited = [];
  const report = await applyLifecycleRollback(plan, {
    async rollbackLifecycleItem(action) {
      visited.push(action.itemId);
      return { itemId: action.itemId, outcome: 'rolled-back', revision: 7 };
    },
  });
  assert.equal(report.partial, false);
  assert.deepEqual(visited, ['item-1']);

  const replanned = planLifecycleRollback([{
    ...current,
    status: 'blocked',
    legacyOwner: 'human',
    revision: 7,
    currentActionRevision: 7,
  }]);
  assert.equal(replanned.actions[0].action, 'already-rolled-back');
});

test('rollback apply CLI requires writer exclusion but no forward authorization file', () => {
  assert.throws(
    () => parseLifecycleCli([
      'rollback-apply',
      '--config', '/config',
      '--checkout', '/pan',
    ]),
    /confirm-writers-stopped/,
  );
  assert.deepEqual(
    parseLifecycleCli([
      'rollback-apply',
      '--config', '/config',
      '--checkout', '/pan',
      '--confirm-writers-stopped',
    ]),
    {
      help: false,
      command: 'rollback-apply',
      config: '/config',
      checkout: '/pan',
      authorization: undefined,
      report: undefined,
    },
  );
});
