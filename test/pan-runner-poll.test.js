import assert from 'node:assert/strict';
import test from 'node:test';
import {
  claimConfirmed,
  cleanTerminalLeaseFields,
  computeMachineSlotOccupancy,
  FIELD,
  findProjectItemForTask,
  leaseExpiredOrMissing,
  occupiedSlotsForPlaybook,
  pendingFinalizationKind,
  preparePoll,
} from '../bin/pan-runner-poll.js';

const NOW = Date.parse('2026-08-21T16:00:00.000Z');
const EXPIRED = '2026-08-21T15:00:00.000Z';
const VALID = '2026-08-21T17:00:00.000Z';

function projectItem({
  id,
  number,
  machine = 'machine-a',
  claimedBy = 'runner-a',
  leaseUntil = EXPIRED,
  playbook = 'isolated',
}) {
  return {
    itemId: id,
    issue: {
      number,
      title: `Task ${number}`,
      body: '',
      url: `https://github.com/example/domain/issues/${number}`,
      repo: 'example/domain',
    },
    fields: {
      [FIELD.status]: 'in-progress',
      [FIELD.owner]: 'agent',
      [FIELD.priority]: 'normal',
      [FIELD.playbook]: playbook,
      [FIELD.machine]: machine,
      [FIELD.sessionId]: `session-${number}`,
      [FIELD.claimedBy]: claimedBy,
      [FIELD.leaseUntil]: leaseUntil,
    },
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function pollOptions(items, overrides = {}) {
  const byId = new Map(items.map((item) => [item.itemId, clone(item)]));
  const writes = [];
  const warnings = [];
  return {
    writes,
    warnings,
    options: {
      cfg: {
        identity: 'runner-a',
        machine: 'machine-a',
      },
      playbooks: new Map([
        ['isolated', { capacity: 1 }],
        ['fixed', { capacity: 1, workingDirectory: 'C:\\fixed-workspace' }],
      ]),
      active: new Map(),
      now: NOW,
      readItem: async (itemId) => clone(byId.get(itemId)),
      setPaused: async (itemId) => writes.push(itemId),
      warn: (message) => warnings.push(message),
      ...overrides,
    },
  };
}

test('pending finalization recognizes active and partial terminal commits', () => {
  const identity = 'runner-a';

  assert.equal(
    pendingFinalizationKind({
      projectStatus: 'in-progress',
      pendingStatus: 'done',
      claimedBy: identity,
      identity,
    }),
    'active',
  );
  assert.equal(
    pendingFinalizationKind({
      projectStatus: 'done',
      pendingStatus: 'done',
      claimedBy: '',
      identity,
    }),
    'terminal',
  );
  assert.equal(
    pendingFinalizationKind({
      projectStatus: 'blocked',
      pendingStatus: 'done',
      claimedBy: identity,
      identity,
    }),
    'escalated',
  );
  assert.equal(
    pendingFinalizationKind({
      projectStatus: 'in-review',
      pendingStatus: 'done',
      claimedBy: identity,
      identity,
    }),
    null,
  );
  assert.equal(
    pendingFinalizationKind({
      projectStatus: 'done',
      pendingStatus: 'done',
      claimedBy: 'runner-b',
      identity,
    }),
    null,
  );
});

test('leaseExpiredOrMissing distinguishes gone leases from held and unreadable ones', () => {
  const at = (leaseUntil) => ({ fields: { [FIELD.leaseUntil]: leaseUntil } });
  // Missing and expired leases are unambiguously gone.
  assert.equal(leaseExpiredOrMissing(at(''), NOW), true);
  assert.equal(leaseExpiredOrMissing(at(EXPIRED), NOW), true);
  // A still-valid lease is held.
  assert.equal(leaseExpiredOrMissing(at(VALID), NOW), false);
  // A malformed timestamp fails closed (treated as still-held, not gone), so a
  // restore/finalize that gates on lease expiry never acts on a value it cannot
  // read.
  assert.equal(leaseExpiredOrMissing(at('not-a-timestamp'), NOW), false);
});

test('pending finalization recognizes only a claimed, swept-eligible paused item', () => {
  const identity = 'runner-a';

  // A passive sweep leaves our claim intact; only OUR surviving claim plus the
  // caller's stronger evidence (session/machine bound, lease expired) is a swept
  // worker we may finalize.
  assert.equal(
    pendingFinalizationKind({
      projectStatus: 'paused',
      pendingStatus: 'done',
      claimedBy: identity,
      identity,
      sweptEligible: true,
    }),
    'swept',
  );
  // Unclaimed paused is an ambiguous/manual pause and must NOT be finalized,
  // even when it is pinned to this machine and otherwise eligible.
  assert.equal(
    pendingFinalizationKind({
      projectStatus: 'paused',
      pendingStatus: 'in-review',
      claimedBy: '',
      identity,
      sweptEligible: true,
    }),
    null,
  );
  // Our claim survived, but the caller's evidence did not (session mismatch,
  // active lease, …) → not a swept worker.
  assert.equal(
    pendingFinalizationKind({
      projectStatus: 'paused',
      pendingStatus: 'done',
      claimedBy: identity,
      identity,
      sweptEligible: false,
    }),
    null,
  );
  // A foreign claim is never ours to finalize.
  assert.equal(
    pendingFinalizationKind({
      projectStatus: 'paused',
      pendingStatus: 'done',
      claimedBy: 'runner-b',
      identity,
      sweptEligible: true,
    }),
    null,
  );
  // Paused with no usable result is not a finalization.
  assert.equal(
    pendingFinalizationKind({
      projectStatus: 'paused',
      pendingStatus: null,
      claimedBy: identity,
      identity,
      sweptEligible: true,
    }),
    null,
  );
});

test('workspace matching uses Project item or repository identity', () => {
  const domain = projectItem({ id: 'domain-42', number: 42 });
  domain.issue.repo = 'example/domain';
  domain.issue.url = 'https://github.com/example/domain/issues/42';
  const external = projectItem({ id: 'external-42', number: 42 });
  external.issue.repo = 'example/external';
  external.issue.url = 'https://github.com/example/external/issues/42';
  const items = [domain, external];

  assert.equal(
    findProjectItemForTask(items, {
      itemId: 'external-42',
      number: 42,
      url: domain.issue.url,
      repo: domain.issue.repo,
    }).itemId,
    'external-42',
  );
  assert.equal(
    findProjectItemForTask(items, {
      number: 42,
      url: external.issue.url,
    }).itemId,
    'external-42',
  );
  assert.equal(
    findProjectItemForTask(items, {
      number: 42,
      repo: 'example/external',
    }).itemId,
    'external-42',
  );
  assert.equal(findProjectItemForTask(items, { number: 42 }), null);
});

test('active work suppresses only its exact Project item', async () => {
  const first = projectItem({ id: 'domain-42', number: 42 });
  first.fields[FIELD.status] = 'ready';
  first.fields[FIELD.leaseUntil] = '';
  first.fields[FIELD.claimedBy] = '';
  const second = clone(first);
  second.itemId = 'external-42';
  second.issue.repo = 'example/external';
  second.issue.url = 'https://github.com/example/external/issues/42';
  const { options } = pollOptions([first, second], {
    active: new Map([['domain-42', { itemId: 'domain-42' }]]),
  });

  const result = await preparePoll([first, second], options);

  assert.deepEqual(
    result.candidates.map((item) => item.itemId),
    ['external-42'],
  );
});

test('terminal tasks have stale lease fields cleared and confirmed', async () => {
  const source = ['in-review', 'done', 'blocked'].map((status, index) => {
    const item = projectItem({
      id: `terminal-${status}`,
      number: 20 + index,
    });
    item.fields[FIELD.status] = status;
    return item;
  });
  const byId = new Map(source.map((item) => [item.itemId, clone(item)]));
  const writes = [];

  const cleaned = await cleanTerminalLeaseFields(source, {
    readItem: async (itemId) => clone(byId.get(itemId)),
    clearFields: async (itemId) => {
      writes.push(itemId);
      const item = byId.get(itemId);
      item.fields[FIELD.claimedBy] = '';
      item.fields[FIELD.leaseUntil] = '';
    },
  });

  assert.deepEqual(writes, source.map((item) => item.itemId));
  assert.deepEqual(cleaned.map((item) => item.itemId), writes);
  for (const item of cleaned) {
    assert.equal(item.fields[FIELD.claimedBy], '');
    assert.equal(item.fields[FIELD.leaseUntil], '');
  }
});

test('terminal cleanup does not touch work that became active on re-read', async () => {
  const source = projectItem({ id: 'terminal-race', number: 23 });
  source.fields[FIELD.status] = 'done';
  let writes = 0;

  const cleaned = await cleanTerminalLeaseFields([source], {
    readItem: async () =>
      projectItem({ id: 'terminal-race', number: 23, leaseUntil: VALID }),
    clearFields: async () => {
      writes += 1;
    },
  });

  assert.equal(writes, 0);
  assert.deepEqual(cleaned, []);
});

test('stale local fixed and isolated tasks are resumable in the same poll', async () => {
  const source = [
    projectItem({ id: 'isolated-item', number: 1 }),
    projectItem({ id: 'fixed-item', number: 2, playbook: 'fixed' }),
  ];
  const { options, writes, warnings } = pollOptions(source);

  const result = await preparePoll(source, options);

  assert.deepEqual(writes, ['isolated-item', 'fixed-item']);
  assert.deepEqual(warnings, []);
  assert.deepEqual(result.swept.map((item) => item.issue.number), [1, 2]);
  assert.deepEqual(result.candidates.map((item) => item.issue.number), [1, 2]);
  for (const item of result.candidates) {
    assert.equal(item.fields[FIELD.status], 'paused');
    assert.equal(item.fields[FIELD.claimedBy], 'runner-a');
    assert.equal(item.fields[FIELD.leaseUntil], EXPIRED);
  }
});

test('stale foreign claims are paused without changing lease ownership', async () => {
  const source = [
    projectItem({
      id: 'foreign-item',
      number: 3,
      machine: 'machine-b',
      claimedBy: 'runner-b',
    }),
  ];
  const { options, writes } = pollOptions(source);

  const result = await preparePoll(source, options);

  assert.deepEqual(writes, ['foreign-item']);
  assert.equal(result.swept[0].fields[FIELD.status], 'paused');
  assert.equal(result.swept[0].fields[FIELD.claimedBy], 'runner-b');
  assert.equal(result.swept[0].fields[FIELD.leaseUntil], EXPIRED);
  assert.deepEqual(result.candidates, []);
});

test('valid local and foreign leases are left running', async () => {
  const source = [
    projectItem({ id: 'local-valid', number: 4, leaseUntil: VALID }),
    projectItem({
      id: 'foreign-valid',
      number: 5,
      machine: 'machine-b',
      claimedBy: 'runner-b',
      leaseUntil: VALID,
    }),
  ];
  let reads = 0;
  const { options, writes } = pollOptions(source, {
    readItem: async () => {
      reads += 1;
      throw new Error('valid leases must not be re-read for sweeping');
    },
  });

  const result = await preparePoll(source, options);

  assert.equal(reads, 0);
  assert.deepEqual(writes, []);
  assert.deepEqual(result.swept, []);
  assert.deepEqual(result.candidates, []);
});

test('malformed lease timestamps are surfaced and not swept', async () => {
  const malformed = [
    'not-a-timestamp',
    '0',
    '2026-08-21 15:00:00',
    '2026-02-30T15:00:00Z',
  ];
  const source = malformed.map((leaseUntil, index) =>
    projectItem({
      id: `malformed-item-${index}`,
      number: 6 + index,
      leaseUntil,
    }),
  );
  let reads = 0;
  const { options, writes, warnings } = pollOptions(source, {
    readItem: async () => {
      reads += 1;
      return clone(source[0]);
    },
  });

  const result = await preparePoll(source, options);

  assert.equal(reads, 0);
  assert.deepEqual(writes, []);
  assert.deepEqual(result.swept, []);
  assert.deepEqual(result.candidates, []);
  assert.equal(warnings.length, malformed.length);
  for (const warning of warnings) assert.match(warning, /unparseable lease-until/);
});

test('a lease renewed before the sweep write is not paused', async () => {
  const source = [projectItem({ id: 'renewed-item', number: 7 })];
  const renewed = projectItem({
    id: 'renewed-item',
    number: 7,
    claimedBy: 'runner-b',
    leaseUntil: VALID,
  });
  const { options, writes } = pollOptions(source, {
    readItem: async () => clone(renewed),
  });

  const result = await preparePoll(source, options);

  assert.deepEqual(writes, []);
  assert.deepEqual(result.swept, []);
  assert.equal(result.items[0].fields[FIELD.leaseUntil], VALID);
  assert.equal(result.items[0].fields[FIELD.status], 'in-progress');
});

test('an expired task still supervised by this runner is not swept', async () => {
  const source = [projectItem({ id: 'supervised-item', number: 8 })];
  let reads = 0;
  const { options, writes } = pollOptions(source, {
    active: new Map([['supervised-item', { itemId: 'supervised-item' }]]),
    readItem: async () => {
      reads += 1;
      return clone(source[0]);
    },
  });

  const result = await preparePoll(source, options);

  assert.equal(reads, 0);
  assert.deepEqual(writes, []);
  assert.deepEqual(result.swept, []);
  assert.deepEqual(result.candidates, []);
});

// --- workspace slot occupancy ---------------------------------------------

function compositeItem({ id, number, machine = 'machine-a', slot = 'primary', leaseUntil = VALID, playbook = 'pooled' }) {
  const item = projectItem({ id, number, leaseUntil, playbook });
  item.fields[FIELD.machine] = slot ? `${machine}::${slot}` : machine;
  return item;
}

test('active and finalization-pending workers occupy their recorded slots', () => {
  const active = new Map([
    ['a', { itemId: 'a', slot: 'primary', playbook: 'pooled' }],
    ['b', { itemId: 'b', slot: 'secondary', finalizationPending: true, playbook: 'pooled' }],
    ['c', { itemId: 'c', slot: null, playbook: 'pooled' }],
  ]);
  const occupied = computeMachineSlotOccupancy({
    active,
    items: [],
    machine: 'machine-a',
    now: NOW,
  });
  assert.deepEqual([...occupiedSlotsForPlaybook(occupied, 'pooled')].sort(), ['primary', 'secondary']);
});

test('Project in-progress composite affinities occupy by lease state', () => {
  const warnings = [];
  const items = [
    compositeItem({ id: 'valid', number: 1, slot: 'primary', leaseUntil: VALID }),
    compositeItem({ id: 'expired', number: 2, slot: 'secondary', leaseUntil: EXPIRED }),
    compositeItem({ id: 'malformed', number: 3, slot: 'tertiary', leaseUntil: 'not-a-time' }),
    compositeItem({ id: 'other-machine', number: 4, machine: 'machine-b', slot: 'primary', leaseUntil: VALID }),
    compositeItem({ id: 'exact', number: 5, slot: null, leaseUntil: VALID }),
  ];
  const occupied = computeMachineSlotOccupancy({
    active: new Map(),
    items,
    machine: 'machine-a',
    now: NOW,
    warn: (message) => warnings.push(message),
  });

  // Valid and malformed (fail-closed) occupy; expired frees; another machine
  // and an exact-machine (non-slot) value are ignored.
  assert.deepEqual([...occupiedSlotsForPlaybook(occupied, 'pooled')].sort(), ['primary', 'tertiary']);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /unparseable lease-until/);
});

test('active workers and Project items combine into one occupied set', () => {
  const occupied = computeMachineSlotOccupancy({
    active: new Map([['a', { itemId: 'a', slot: 'primary', playbook: 'pooled' }]]),
    items: [compositeItem({ id: 'valid', number: 1, slot: 'secondary', leaseUntil: VALID })],
    machine: 'machine-a',
    now: NOW,
  });
  assert.deepEqual([...occupiedSlotsForPlaybook(occupied, 'pooled')].sort(), ['primary', 'secondary']);
});

test('two playbooks that share a slot id do not block each other', () => {
  const occupied = computeMachineSlotOccupancy({
    active: new Map([['a', { itemId: 'a', slot: 'primary', playbook: 'alpha' }]]),
    items: [compositeItem({ id: 'b', number: 1, slot: 'primary', playbook: 'beta', leaseUntil: VALID })],
    machine: 'machine-a',
    now: NOW,
  });
  // Each playbook's `primary` is tracked independently across active and Project
  // sources, so neither sees the other's slot as occupied.
  assert.deepEqual([...occupiedSlotsForPlaybook(occupied, 'alpha')], ['primary']);
  assert.deepEqual([...occupiedSlotsForPlaybook(occupied, 'beta')], ['primary']);
});

test('the same playbook using the same slot id blocks itself', () => {
  const occupied = computeMachineSlotOccupancy({
    active: new Map([['a', { itemId: 'a', slot: 'primary', playbook: 'pooled' }]]),
    items: [compositeItem({ id: 'b', number: 1, slot: 'primary', playbook: 'pooled', leaseUntil: VALID })],
    machine: 'machine-a',
    now: NOW,
  });
  assert.deepEqual([...occupiedSlotsForPlaybook(occupied, 'pooled')], ['primary']);
});

test('occupiedSlotsForPlaybook accumulates serial same-poll reservations per playbook', () => {
  const occupied = computeMachineSlotOccupancy({
    active: new Map(),
    items: [],
    machine: 'machine-a',
    now: NOW,
  });
  const alpha = occupiedSlotsForPlaybook(occupied, 'alpha');
  alpha.add('primary');
  // A later read of the same playbook sees the reservation; a different playbook
  // starts empty.
  assert.deepEqual([...occupiedSlotsForPlaybook(occupied, 'alpha')], ['primary']);
  assert.deepEqual([...occupiedSlotsForPlaybook(occupied, 'beta')], []);
});

// --- claim confirmation tuple ---------------------------------------------

test('claimConfirmed requires the exact claimed-by, lease, machine, and in-progress status', () => {
  const base = {
    fields: {
      [FIELD.claimedBy]: 'runner-a',
      [FIELD.leaseUntil]: VALID,
      [FIELD.machine]: 'machine-a::primary',
      [FIELD.status]: 'in-progress',
    },
  };
  const want = { identity: 'runner-a', lease: VALID, machine: 'machine-a::primary' };

  assert.equal(claimConfirmed(base, want), true);
  assert.equal(claimConfirmed(null, want), false);
  assert.equal(
    claimConfirmed({ fields: { ...base.fields, [FIELD.claimedBy]: 'runner-b' } }, want),
    false,
  );
  assert.equal(
    claimConfirmed({ fields: { ...base.fields, [FIELD.leaseUntil]: EXPIRED } }, want),
    false,
  );
  assert.equal(
    claimConfirmed({ fields: { ...base.fields, [FIELD.machine]: 'machine-a::secondary' } }, want),
    false,
  );
  assert.equal(
    claimConfirmed({ fields: { ...base.fields, [FIELD.status]: 'paused' } }, want),
    false,
  );
});
