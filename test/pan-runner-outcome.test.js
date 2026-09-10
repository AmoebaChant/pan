import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { Runner } from '../bin/pan-runner.js';
import {
  FIELD,
  preparePoll,
} from '../bin/pan-runner-poll.js';
import {
  renderCurrentActionBlock,
  upsertCurrentActionBlock,
} from '../bin/pan-task-model.js';

const NOW = Date.parse('2026-09-09T20:00:00Z');
const EXPIRED = '2026-09-09T19:00:00.000Z';

function item({
  id,
  number,
  status = 'ready-for-ai',
  action = 'execute',
  priority = 'normal',
  date = '',
  playbook = 'may',
  authorized = 'yes',
  dependencies = '',
  workerState = 'idle',
  machine = '',
  sessionId = '',
  claimGeneration = '',
  claimedBy = '',
  leaseUntil = '',
  body = '',
  revision = '1',
}) {
  return {
    itemId: id,
    issue: {
      number,
      title: `Task ${number}`,
      body,
      url: `https://github.com/example/domain/issues/${number}`,
      repo: 'example/domain',
    },
    fields: {
      [FIELD.status]: status,
      [FIELD.nextAction]: action,
      [FIELD.priority]: priority,
      [FIELD.nextActionDate]: date,
      [FIELD.playbook]: playbook,
      [FIELD.executionAuthorized]: authorized,
      [FIELD.dependencies]: dependencies,
      [FIELD.workerState]: workerState,
      [FIELD.machine]: machine,
      [FIELD.sessionId]: sessionId,
      [FIELD.claimGeneration]: claimGeneration,
      [FIELD.claimedBy]: claimedBy,
      [FIELD.leaseUntil]: leaseUntil,
      [FIELD.taskRevision]: revision,
    },
  };
}

function options(items, overrides = {}) {
  const byId = new Map(items.map((entry) => [entry.itemId, structuredClone(entry)]));
  return {
    cfg: {
      lifecycleVersion: 2,
      identity: 'runner-a',
      machine: 'machine-a',
      humanAttentionBackpressure: { mode: 'off', softLimit: 5 },
    },
    playbooks: new Map([
      ['may', { capacity: 2, humanAttention: 'may-request' }],
      ['auto', { capacity: 2, humanAttention: 'autonomous' }],
    ]),
    active: new Map(),
    now: NOW,
    readItem: async (id) => structuredClone(byId.get(id)),
    setPaused: async () => assert.fail('new lifecycle must not write legacy paused Status'),
    setWorkerPaused: async (id) => {
      byId.get(id).fields[FIELD.workerState] = 'paused';
    },
    ...overrides,
  };
}

test('AI selection uses readiness, authorization, dependencies, priority, and Project order but no date', async () => {
  const tasks = [
    item({ id: 'future-high', number: 1, priority: 'high', date: '2030-01-01' }),
    item({ id: 'past-normal', number: 2, priority: 'normal', date: '2020-01-01' }),
    item({ id: 'empty-normal', number: 3, priority: 'normal', date: '' }),
    item({ id: 'human', number: 4, status: 'ready-for-human', action: 'approve' }),
    item({ id: 'held', number: 5, status: 'deliberate-hold', action: 'hold' }),
    item({ id: 'unauthorized', number: 6, authorized: 'no' }),
    item({ id: 'dependency', number: 7, dependencies: 'Wait for source data.' }),
    item({
      id: 'recurring',
      number: 8,
      body: 'Pan: recurrence occurrence 2026-09-12\n\n## Recurrence\n\nEvery Saturday.',
    }),
  ];
  const result = await preparePoll(tasks, options(tasks));

  assert.deepEqual(
    result.candidates.map((entry) => entry.itemId),
    ['future-high', 'past-normal', 'empty-normal'],
  );
});

test('resumes and new work share priority then canonical Project ordering without date sorting', async () => {
  const urgentNew = item({
    id: 'urgent-new',
    number: 20,
    priority: 'urgent',
    date: '2035-01-01',
  });
  const lowResume = item({
    id: 'low-resume',
    number: 21,
    priority: 'low',
    date: '2020-01-01',
    workerState: 'paused',
    machine: 'machine-a',
    sessionId: '11111111-1111-4111-8111-111111111111',
    claimGeneration: '22222222-2222-4222-8222-222222222222',
  });
  const result = await preparePoll([lowResume, urgentNew], options([lowResume, urgentNew]));
  assert.deepEqual(
    result.candidates.map((entry) => entry.itemId),
    ['urgent-new', 'low-resume'],
  );

  const firstNew = item({
    id: 'first-new',
    number: 22,
    priority: 'normal',
    date: '2035-01-01',
  });
  const laterResume = item({
    id: 'later-resume',
    number: 23,
    priority: 'normal',
    date: '2020-01-01',
    workerState: 'paused',
    machine: 'machine-a',
    sessionId: '33333333-3333-4333-8333-333333333333',
    claimGeneration: '44444444-4444-4444-8444-444444444444',
  });
  const samePriority = await preparePoll(
    [firstNew, laterResume],
    options([firstNew, laterResume]),
  );
  assert.deepEqual(
    samePriority.candidates.map((entry) => entry.itemId),
    ['first-new', 'later-resume'],
  );
});

test('attention backpressure skips only new may-request work', async () => {
  const tasks = [
    item({ id: 'need-1', number: 1, status: 'ready-for-human', action: 'clarify' }),
    item({ id: 'need-2', number: 2, status: 'ready-for-human', action: 'approve' }),
    item({ id: 'may', number: 3, playbook: 'may' }),
    item({ id: 'auto', number: 4, playbook: 'auto' }),
    item({
      id: 'resume',
      number: 5,
      playbook: 'may',
      status: 'ready-for-ai',
      workerState: 'paused',
      machine: 'machine-a',
      sessionId: '11111111-1111-4111-8111-111111111111',
      claimGeneration: '22222222-2222-4222-8222-222222222222',
      leaseUntil: EXPIRED,
    }),
  ];
  const configured = options(tasks);
  configured.cfg.humanAttentionBackpressure = {
    mode: 'prefer-autonomous',
    softLimit: 2,
  };
  const result = await preparePoll(tasks, configured);

  assert.deepEqual(
    result.candidates.map((entry) => entry.itemId),
    ['auto', 'resume'],
  );
});

test('future human reminders do not create Needs me backpressure or gate AI work', async () => {
  const tasks = [
    item({
      id: 'future-human',
      number: 81,
      status: 'ready-for-human',
      action: 'act',
      date: '2030-01-01',
    }),
    item({ id: 'may-run', number: 82, playbook: 'may' }),
  ];
  const configured = options(tasks);
  configured.cfg.humanAttentionBackpressure = {
    mode: 'prefer-autonomous',
    softLimit: 1,
  };
  const result = await preparePoll(tasks, configured);
  assert.deepEqual(result.candidates.map((entry) => entry.itemId), ['may-run']);
});

test('expired execution changes only worker liveness and waits for explicit ready-for-ai handoff', async () => {
  const task = item({
    id: 'paused-worker',
    number: 9,
    status: 'ai-executing',
    workerState: 'running',
    machine: 'machine-a',
    sessionId: '33333333-3333-4333-8333-333333333333',
    claimGeneration: '44444444-4444-4444-8444-444444444444',
    claimedBy: 'runner-a',
    leaseUntil: EXPIRED,
  });
  const configured = options([task]);
  const result = await preparePoll([task], configured);

  assert.equal(result.swept[0].fields[FIELD.status], 'ai-executing');
  assert.equal(result.swept[0].fields[FIELD.workerState], 'paused');
  assert.deepEqual(result.candidates, []);
});

test('only explicit ready-for-ai retained affinity resumes and incomplete tuples fail closed', async () => {
  const sessionId = 'abababab-abab-4bab-8bab-abababababab';
  const claimGeneration = 'cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd';
  const tasks = [
    item({
      id: 'implicit',
      number: 91,
      status: 'ai-executing',
      workerState: 'paused',
      machine: 'machine-a',
      sessionId,
      claimGeneration,
    }),
    item({
      id: 'explicit',
      number: 92,
      status: 'ready-for-ai',
      workerState: 'paused',
      machine: 'machine-a',
      sessionId,
      claimGeneration,
    }),
    item({
      id: 'partial',
      number: 93,
      status: 'ready-for-ai',
      workerState: 'paused',
      machine: 'machine-a',
      sessionId,
      claimGeneration: '',
    }),
  ];
  const result = await preparePoll(tasks, options(tasks));
  assert.deepEqual(result.candidates.map((entry) => entry.itemId), ['explicit']);
});

function runnerHarness(source, playbooks = new Map([
  ['may', { capacity: 1, humanAttention: 'may-request', checkpointRelease: 'forbidden' }],
])) {
  const store = new Map([[source.itemId, structuredClone(source)]]);
  const writes = [];
  const deps = {
    readAllItems: async () => [...store.values()].map((value) => structuredClone(value)),
    readItemById: async (id) => structuredClone(store.get(id)),
    setTextField: async (_cfg, _meta, id, field, value) => {
      writes.push({ field, value: value == null ? '' : String(value) });
      store.get(id).fields[field] = value == null ? '' : String(value);
    },
    setDateField: async (_cfg, _meta, id, field, value) => {
      writes.push({ field, value: value || '' });
      store.get(id).fields[field] = value || '';
    },
    setSelectField: async (_cfg, _meta, id, field, value) => {
      writes.push({ field, value });
      store.get(id).fields[field] = value;
    },
    updateIssueCurrentAction: async () => {},
    gh: async () => '',
  };
  const runner = new Runner({
    lifecycleVersion: 2,
    machine: 'machine-a',
    identity: 'runner-a',
    leaseMinutes: 15,
    maxConcurrent: 1,
    humanAttentionBackpressure: { mode: 'off', softLimit: 5 },
  }, { fields: new Map() }, playbooks, deps);
  const launches = [];
  runner.launchWorker = async (launched) => {
    launches.push(launched.itemId);
    runner.active.set(launched.itemId, {
      itemId: launched.itemId,
      issueNumber: launched.issue.number,
      playbook: 'may',
      claimGeneration: launched.fields[FIELD.claimGeneration],
    });
  };
  return { runner, store, writes, launches };
}

test('new lifecycle claims mint and confirm a generation and revision before launch', async () => {
  const source = item({ id: 'claim', number: 10, revision: '7' });
  const { runner, store, launches } = runnerHarness(source);

  const result = await runner.pollAndClaim();
  const live = store.get('claim');

  assert.equal(result.claimed, 1);
  assert.deepEqual(launches, ['claim']);
  assert.equal(live.fields[FIELD.status], 'ai-executing');
  assert.equal(live.fields[FIELD.nextAction], 'execute');
  assert.equal(live.fields[FIELD.workerState], 'running');
  assert.equal(live.fields[FIELD.taskRevision], '8');
  assert.match(live.fields[FIELD.claimGeneration], /^[0-9a-f-]{36}$/);
});

test('explicit retained-affinity resume keeps the existing claim generation', async () => {
  const generation = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  const source = item({
    id: 'resume-claim',
    number: 94,
    status: 'ready-for-ai',
    workerState: 'paused',
    machine: 'machine-a',
    sessionId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    claimGeneration: generation,
    revision: '9',
  });
  const { runner, store, launches } = runnerHarness(source);

  const result = await runner.pollAndClaim();
  const live = store.get(source.itemId);

  assert.equal(result.claimed, 1);
  assert.deepEqual(launches, ['resume-claim']);
  assert.equal(live.fields[FIELD.claimGeneration], generation);
  assert.equal(live.fields[FIELD.taskRevision], '10');
});

test('retained slot affinity does not make its own explicit resume look busy', async () => {
  const generation = '12121212-1212-4212-8212-121212121212';
  const source = item({
    id: 'slot-resume',
    number: 95,
    playbook: 'pooled',
    status: 'ready-for-ai',
    workerState: 'paused',
    machine: 'machine-a::primary',
    sessionId: '34343434-3434-4434-8434-343434343434',
    claimGeneration: generation,
  });
  const { runner, store } = runnerHarness(source, new Map([
    ['pooled', {
      capacity: 1,
      humanAttention: 'may-request',
      checkpointRelease: 'forbidden',
      slots: [{ id: 'primary', dir: '/project/primary' }],
    }],
  ]));

  const result = await runner.pollAndClaim();
  assert.equal(result.claimed, 1);
  assert.equal(store.get(source.itemId).fields[FIELD.machine], 'machine-a::primary');
  assert.equal(store.get(source.itemId).fields[FIELD.claimGeneration], generation);
});

test('a stale worker generation cannot write a human checkpoint', async () => {
  const source = item({
    id: 'stale',
    number: 11,
    status: 'ai-executing',
    workerState: 'running',
    machine: 'machine-a',
    sessionId: '55555555-5555-4555-8555-555555555555',
    claimGeneration: '66666666-6666-4666-8666-666666666666',
    claimedBy: 'runner-a',
    leaseUntil: '2030-01-01T00:00:00.000Z',
  });
  const { runner, writes } = runnerHarness(source);
  const worker = {
    itemId: 'stale',
    issueNumber: 11,
    repo: 'example/domain',
    sessionId: source.fields[FIELD.sessionId],
    claimGeneration: '77777777-7777-4777-8777-777777777777',
  };

  await assert.rejects(
    runner.transitionOwnedWorker(worker, {
      status: 'ready-for-human',
      action: 'approve',
      detail: 'Approve rollout.',
      workerState: 'waiting-human',
      needsHumanSince: '2026-09-09T20:00:00Z',
    }),
    /generation/,
  );
  assert.deepEqual(writes, []);
});

test('a stopped process does not free a fixed workspace owned by a paused task', () => {
  const paused = item({
    id: 'paused-fixed',
    number: 12,
    playbook: 'fixed',
    status: 'ai-executing',
    workerState: 'paused',
    machine: 'machine-a',
    sessionId: '12121212-1212-4212-8212-121212121212',
    claimGeneration: '13131313-1313-4313-8313-131313131313',
  });
  const candidate = item({ id: 'new-fixed', number: 13, playbook: 'fixed' });
  const runner = new Runner({
    lifecycleVersion: 2,
    machine: 'machine-a',
    identity: 'runner-a',
  }, { fields: new Map() }, new Map([
    ['fixed', { capacity: 1, workingDirectory: '/example/fixed' }],
  ]));

  assert.equal(
    runner.fixedResourceOwnedByOther(candidate.itemId, runner.playbooks.get('fixed'), [paused, candidate]),
    true,
  );
  assert.equal(
    runner.fixedResourceOwnedByOther(paused.itemId, runner.playbooks.get('fixed'), [paused, candidate]),
    false,
  );
});

async function finalizationHarness(t, outcome) {
  const root = path.join(process.cwd(), '.pan-test-state', randomUUID());
  const attemptDir = path.join(root, 'attempt');
  await mkdir(attemptDir, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  const resultPath = path.join(attemptDir, 'result.json');
  const result = {
    outcome,
    summary: outcome === 'done' ? 'Everything is complete.' : 'AI preparation is complete.',
    details: outcome === 'done' ? 'Validated the complete outcome.' : 'Choose the rollout cohort.',
    ...(outcome === 'needs-human' ? { action: 'approve' } : {}),
  };
  await writeFile(resultPath, JSON.stringify(result));

  const source = item({
    id: `finalize-${outcome}`,
    number: 20,
    status: 'ai-executing',
    workerState: 'running',
    machine: 'machine-a',
    sessionId: '88888888-8888-4888-8888-888888888888',
    claimGeneration: '99999999-9999-4999-8999-999999999999',
    claimedBy: 'runner-a',
    leaseUntil: '2030-01-01T00:00:00.000Z',
    date: '2026-09-09',
    revision: '4',
  });
  const { runner, store } = runnerHarness(source);
  const calls = [];
  runner.deps.setTextField = async (_cfg, _meta, id, field, value) => {
    calls.push(field);
    store.get(id).fields[field] = value == null ? '' : String(value);
  };
  runner.deps.setDateField = async (_cfg, _meta, id, field, value) => {
    calls.push(field);
    store.get(id).fields[field] = value || '';
  };
  runner.deps.setSelectField = async (_cfg, _meta, id, field, value) => {
    calls.push(`${field}:${value}`);
    store.get(id).fields[field] = value;
  };
  runner.deps.ensureIssueComment = async () => calls.push('comment');
  runner.deps.ensureIssueClosed = async () => calls.push('issue-closed');
  runner.deps.updateIssueCurrentAction = async (_gh, _repo, _number, update) => {
    calls.push('issue-action');
    const live = store.get(source.itemId);
    live.issue.body = upsertCurrentActionBlock(live.issue.body, renderCurrentActionBlock({
      status: update.status,
      action: update.action,
      detail: update.detail,
      revision: update.revision,
      updatedAt: '2026-09-09T20:00:00.000Z',
    }));
  };
  const worker = {
    itemId: source.itemId,
    issueNumber: source.issue.number,
    repo: source.issue.repo,
    url: source.issue.url,
    playbook: 'may',
    sessionId: source.fields[FIELD.sessionId],
    claimGeneration: source.fields[FIELD.claimGeneration],
    slot: null,
    launchId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    attemptDir,
    panDir: attemptDir,
    finished: false,
  };
  runner.active.set(worker.itemId, worker);
  const bytes = await readFile(resultPath);
  return { runner, store, calls, worker, result, resultPath, bytes };
}

test('whole-outcome completion clears planning, closes the Issue, then commits done', async (t) => {
  const harness = await finalizationHarness(t, 'done');
  const completed = await harness.runner.finalizeOutcomeLifecycle(
    harness.worker,
    harness.resultPath,
    harness.bytes,
    harness.result,
  );
  const live = harness.store.get(harness.worker.itemId);

  assert.equal(completed, true);
  assert.equal(live.fields[FIELD.nextActionDate], '');
  assert.equal(live.fields[FIELD.status], 'done');
  assert.equal(live.fields[FIELD.nextAction], 'none');
  assert.equal(live.fields[FIELD.workerState], 'stopped');
  assert.equal(live.fields[FIELD.taskRevision], '5');
  assert.equal(live.fields[FIELD.machine], '');
  assert.equal(live.fields[FIELD.sessionId], '');
  assert.equal(live.fields[FIELD.claimGeneration], '');
  assert.ok(harness.calls.indexOf(FIELD.nextActionDate) < harness.calls.indexOf('issue-closed'));
  assert.ok(harness.calls.indexOf('issue-closed') < harness.calls.indexOf('Status:done'));
});

test('AI-part completion creates an exact human checkpoint without closing the Issue', async (t) => {
  const harness = await finalizationHarness(t, 'needs-human');
  const completed = await harness.runner.finalizeOutcomeLifecycle(
    harness.worker,
    harness.resultPath,
    harness.bytes,
    harness.result,
  );
  const live = harness.store.get(harness.worker.itemId);

  assert.equal(completed, true);
  assert.equal(live.fields[FIELD.status], 'ready-for-human');
  assert.equal(live.fields[FIELD.nextAction], 'approve');
  assert.equal(live.fields[FIELD.workerState], 'checkpointed');
  assert.equal(live.fields[FIELD.claimedBy], '');
  assert.equal(live.fields[FIELD.leaseUntil], '');
  assert.equal(live.fields[FIELD.machine], 'machine-a');
  assert.equal(live.fields[FIELD.sessionId], harness.worker.sessionId);
  assert.equal(live.fields[FIELD.claimGeneration], harness.worker.claimGeneration);
  assert.equal(harness.calls.includes('issue-closed'), false);
});

test('matching done/none without the other completion invariants is fully repaired before receipt', async (t) => {
  const harness = await finalizationHarness(t, 'done');
  const live = harness.store.get(harness.worker.itemId);
  live.fields[FIELD.status] = 'done';
  live.fields[FIELD.nextAction] = 'none';
  live.fields[FIELD.workerState] = 'running';
  live.fields[FIELD.nextActionDate] = '2026-09-09';
  live.issue.body = renderCurrentActionBlock({
    status: 'ai-executing',
    action: 'execute',
    detail: 'Still running.',
    revision: 4,
    updatedAt: '2026-09-09T19:00:00.000Z',
  });

  const completed = await harness.runner.finalizeOutcomeLifecycle(
    harness.worker,
    harness.resultPath,
    harness.bytes,
    harness.result,
  );
  const receipt = JSON.parse(await readFile(path.join(harness.worker.attemptDir, 'result-consumed.json')));

  assert.equal(completed, true);
  assert.equal(live.fields[FIELD.nextActionDate], '');
  assert.equal(live.fields[FIELD.workerState], 'stopped');
  assert.equal(live.fields[FIELD.claimedBy], '');
  assert.equal(live.fields[FIELD.leaseUntil], '');
  assert.equal(live.fields[FIELD.machine], '');
  assert.equal(live.fields[FIELD.sessionId], '');
  assert.equal(live.fields[FIELD.claimGeneration], '');
  assert.equal(live.fields[FIELD.taskRevision], '5');
  assert.match(live.issue.body, /- State: done/);
  assert.ok(harness.calls.includes('issue-closed'));
  assert.equal(receipt.panRunnerResultConsumed, true);
  assert.ok(harness.calls.indexOf('issue-action') < harness.calls.indexOf(FIELD.claimedBy));
});

test('terminal state released without its prior journal is reconstructed from exact attempt/result evidence', async (t) => {
  const harness = await finalizationHarness(t, 'done');
  const live = harness.store.get(harness.worker.itemId);
  live.fields[FIELD.status] = 'done';
  live.fields[FIELD.nextAction] = 'none';
  live.fields[FIELD.workerState] = 'stopped';
  live.fields[FIELD.nextActionDate] = '';
  live.fields[FIELD.needsHumanSince] = '';
  live.fields[FIELD.claimedBy] = '';
  live.fields[FIELD.leaseUntil] = '';
  live.fields[FIELD.machine] = '';
  live.fields[FIELD.sessionId] = '';
  live.fields[FIELD.claimGeneration] = '';
  live.fields[FIELD.taskRevision] = '5';
  live.issue.body = renderCurrentActionBlock({
    status: 'done',
    action: 'none',
    detail: 'Validated the complete outcome.',
    revision: 5,
    updatedAt: '2026-09-09T20:00:00.000Z',
  });

  assert.equal(await harness.runner.finalizeOutcomeLifecycle(
    harness.worker,
    harness.resultPath,
    harness.bytes,
    harness.result,
  ), true);
  assert.equal(
    JSON.parse(await readFile(path.join(harness.worker.attemptDir, 'terminal-release.json')))
      .reconstructedFromReleasedTuple,
    true,
  );
  assert.equal(
    JSON.parse(await readFile(path.join(harness.worker.attemptDir, 'result-consumed.json')))
      .panRunnerResultConsumed,
    true,
  );
  assert.equal(harness.calls.some((call) => call === 'Status:done'), false);
});

test('terminal release journal recovers a crash after machine clear and never reports success without a receipt', async (t) => {
  const harness = await finalizationHarness(t, 'done');
  const originalSetText = harness.runner.deps.setTextField;
  let injected = false;
  harness.runner.deps.setTextField = async (...args) => {
    if (args[3] === FIELD.sessionId && !injected) {
      injected = true;
      throw new Error('injected session clear failure');
    }
    return originalSetText(...args);
  };

  await assert.rejects(
    harness.runner.finalizeOutcomeLifecycle(
      harness.worker,
      harness.resultPath,
      harness.bytes,
      harness.result,
    ),
    /injected session clear failure/,
  );

  const partial = harness.store.get(harness.worker.itemId);
  assert.equal(partial.fields[FIELD.status], 'done');
  assert.equal(partial.fields[FIELD.workerState], 'stopped');
  assert.equal(partial.fields[FIELD.machine], '');
  assert.equal(partial.fields[FIELD.sessionId], harness.worker.sessionId);
  assert.equal(partial.fields[FIELD.claimGeneration], harness.worker.claimGeneration);
  assert.equal(
    await readFile(path.join(harness.worker.attemptDir, 'terminal-release.json'), 'utf8')
      .then((value) => JSON.parse(value).phase),
    'prepared',
  );
  await assert.rejects(
    readFile(path.join(harness.worker.attemptDir, 'result-consumed.json')),
    /ENOENT/,
  );

  harness.runner.deps.setTextField = originalSetText;
  assert.equal(await harness.runner.finalizeOutcomeLifecycle(
    harness.worker,
    harness.resultPath,
    harness.bytes,
    harness.result,
  ), true);
  assert.equal(partial.fields[FIELD.sessionId], '');
  assert.equal(partial.fields[FIELD.claimGeneration], '');
  assert.equal(
    JSON.parse(await readFile(path.join(harness.worker.attemptDir, 'result-consumed.json')))
      .panRunnerResultConsumed,
    true,
  );
});

test('checkpoint release journals first, confirms the owned launcher stopped, then releases Project ownership', async (t) => {
  const harness = await finalizationHarness(t, 'needs-human');
  await rm(harness.resultPath);
  const live = harness.store.get(harness.worker.itemId);
  live.fields[FIELD.status] = 'ready-for-human';
  live.fields[FIELD.nextAction] = 'approve';
  live.fields[FIELD.workerState] = 'waiting-human';
  live.fields[FIELD.needsHumanSince] = '2026-09-09T20:00:00.000Z';
  live.issue.body = renderCurrentActionBlock({
    status: 'ready-for-human',
    action: 'approve',
    detail: 'Approve the rollout.',
    revision: 4,
    updatedAt: '2026-09-09T20:00:00.000Z',
  });
  const receiptPath = path.join(harness.worker.attemptDir, 'checkpoint-consumed.json');
  let stopConfirmed = false;
  harness.runner.confirmCheckpointWorkerStopped = async (worker) => {
    const prepared = JSON.parse(await readFile(receiptPath, 'utf8'));
    assert.equal(prepared.phase, 'prepared');
    assert.equal(prepared.claimGeneration, worker.claimGeneration);
    assert.equal(await readFile(path.join(worker.panDir, 'worker.stop'), 'utf8'), '');
    stopConfirmed = true;
    return true;
  };
  for (const method of ['setTextField', 'setSelectField']) {
    const original = harness.runner.deps[method];
    harness.runner.deps[method] = async (...args) => {
      assert.equal(stopConfirmed, true, 'Project release must happen only after stop proof');
      return original(...args);
    };
  }

  assert.equal(await harness.runner.releaseCheckpointWorker(harness.worker, {
    action: 'approve',
    detail: 'Approve the rollout.',
    since: '2026-09-09T20:00:00.000Z',
  }), true);

  const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
  assert.equal(receipt.phase, 'released');
  assert.equal(live.fields[FIELD.workerState], 'checkpointed');
  assert.equal(live.fields[FIELD.claimedBy], '');
  assert.equal(live.fields[FIELD.leaseUntil], '');

  const projectWrites = harness.calls.length;
  assert.equal(await harness.runner.releaseCheckpointWorker(harness.worker, {
    action: 'approve',
    detail: 'Approve the rollout.',
    since: '2026-09-09T20:00:00.000Z',
  }), true);
  assert.equal(harness.calls.length, projectWrites, 'released checkpoint recovery is idempotent');
});

test('checkpoint release recovers every monotonic field-write prefix after worker-state is checkpointed', async (t) => {
  const harness = await finalizationHarness(t, 'needs-human');
  await rm(harness.resultPath);
  const live = harness.store.get(harness.worker.itemId);
  live.fields[FIELD.status] = 'ready-for-human';
  live.fields[FIELD.nextAction] = 'approve';
  live.fields[FIELD.workerState] = 'waiting-human';
  live.fields[FIELD.needsHumanSince] = '2026-09-09T20:00:00.000Z';
  live.issue.body = renderCurrentActionBlock({
    status: 'ready-for-human',
    action: 'approve',
    detail: 'Approve the rollout.',
    revision: 4,
    updatedAt: '2026-09-09T20:00:00.000Z',
  });
  harness.runner.confirmCheckpointWorkerStopped = async () => true;
  const originalSetText = harness.runner.deps.setTextField;
  let injected = false;
  harness.runner.deps.setTextField = async (...args) => {
    if (args[3] === FIELD.leaseUntil && !injected) {
      injected = true;
      throw new Error('injected lease clear failure');
    }
    return originalSetText(...args);
  };

  await assert.rejects(
    harness.runner.releaseCheckpointWorker(harness.worker, {
      action: 'approve',
      detail: 'Approve the rollout.',
      since: '2026-09-09T20:00:00.000Z',
    }),
    /injected lease clear failure/,
  );
  assert.equal(live.fields[FIELD.workerState], 'checkpointed');
  assert.equal(live.fields[FIELD.claimedBy], 'runner-a');
  assert.equal(live.fields[FIELD.leaseUntil], '2030-01-01T00:00:00.000Z');
  assert.equal(
    JSON.parse(await readFile(path.join(harness.worker.attemptDir, 'checkpoint-consumed.json')))
      .phase,
    'stopped',
  );

  harness.runner.deps.setTextField = originalSetText;
  assert.equal(await harness.runner.releaseCheckpointWorker(harness.worker, {
    action: 'approve',
    detail: 'Approve the rollout.',
    since: '2026-09-09T20:00:00.000Z',
  }), true);
  assert.equal(live.fields[FIELD.claimedBy], '');
  assert.equal(live.fields[FIELD.leaseUntil], '');
  assert.equal(
    JSON.parse(await readFile(path.join(harness.worker.attemptDir, 'checkpoint-consumed.json')))
      .phase,
    'released',
  );
});
