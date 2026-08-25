import assert from 'node:assert/strict';
import test from 'node:test';
import { Runner } from '../bin/pan-runner.js';
import { FIELD } from '../bin/pan-runner-poll.js';

// Integration tests that drive the real poll -> claim path in-process. The gh
// boundary (readAllItems / readItemById / setTextField / setSelectField) and
// launchWorker are the only stubs, so the actual slot occupancy threading in
// pollAndClaim and the fresh re-selection in claimAndLaunch run unmodified.

const MACHINE = 'box';
const IDENTITY = 'box-runner-1';
const VALID = '2999-01-01T00:00:00.000Z';

const SLOTS = [
  { id: 'primary', dir: 'C:\\ws\\primary' },
  { id: 'secondary', dir: 'C:\\ws\\secondary' },
];

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

// A minimal Project item. `machine` carries the composite `<machine>::<slot>`
// affinity (or '' for unassigned work).
function item({
  id,
  number,
  status = 'ready',
  owner = 'agent',
  playbook = 'pooled',
  machine = '',
  claimedBy = '',
  leaseUntil = '',
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
      [FIELD.status]: status,
      [FIELD.owner]: owner,
      [FIELD.priority]: 'normal',
      [FIELD.playbook]: playbook,
      [FIELD.machine]: machine,
      [FIELD.claimedBy]: claimedBy,
      [FIELD.leaseUntil]: leaseUntil,
      [FIELD.sessionId]: '',
    },
  };
}

// A stateful fake of the gh boundary. `pollSnapshot` is what readAllItems
// returns (the stale poll view); `store` is the live truth reads and writes
// see, so a fresh readItemById can legitimately differ from the poll snapshot.
function makeRunner({ pollSnapshot, store, playbooks }) {
  const writes = [];
  const launches = [];
  const deps = {
    readAllItems: async () => pollSnapshot.map(clone),
    readItemById: async (id) => (store.has(id) ? clone(store.get(id)) : null),
    setTextField: async (_cfg, _meta, id, field, value) => {
      const normalized = value === '' || value == null ? '' : String(value);
      writes.push({ id, field, value: normalized });
      store.get(id).fields[field] = normalized;
    },
    setSelectField: async (_cfg, _meta, id, field, option) => {
      writes.push({ id, field, value: option });
      store.get(id).fields[field] = option;
    },
  };
  const cfg = {
    machine: MACHINE,
    identity: IDENTITY,
    leaseMinutes: 15,
    maxConcurrent: 10,
  };
  const runner = new Runner(cfg, { fields: new Map() }, playbooks, deps);
  runner.launchWorker = async (launched, pb, slot) => {
    launches.push({ number: launched.issue.number, slot });
  };
  return { runner, writes, launches };
}

function pooledPlaybooks(capacity = 2) {
  return new Map([['pooled', { capacity, slots: SLOTS }]]);
}

function writesFor(writes, id) {
  return writes.filter((w) => w.id === id);
}

test('poll picks secondary, but a fresh affinity onto an occupied primary skips the claim', async () => {
  // `primary` is held only by another runner's live Project lease — no active
  // worker on this machine records it. At poll time the candidate is unassigned,
  // so the poll selects the free `secondary`. Between poll and claim the item's
  // affinity drifts to `primary`, which is occupied. The fresh re-selection must
  // honour the threaded occupancy (not just active workers) and skip.
  const lease = item({
    id: 'lease',
    number: 1,
    status: 'in-progress',
    claimedBy: 'other-runner',
    machine: `${MACHINE}::primary`,
    leaseUntil: VALID,
  });
  const candidatePoll = item({ id: 'cand', number: 2, machine: '' });
  const candidateFresh = item({ id: 'cand', number: 2, machine: `${MACHINE}::primary` });

  const store = new Map([
    ['lease', clone(lease)],
    ['cand', clone(candidateFresh)],
  ]);
  const { runner, writes, launches } = makeRunner({
    pollSnapshot: [lease, candidatePoll],
    store,
    playbooks: pooledPlaybooks(),
  });

  const result = await runner.pollAndClaim();

  assert.equal(result.claimed, 0);
  assert.deepEqual(writesFor(writes, 'cand'), []);
  assert.deepEqual(launches, []);
  assert.equal(store.get('cand').fields[FIELD.status], 'ready');
});

test('a fresh exact secondary affinity claims and launches in that slot', async () => {
  const candidate = item({ id: 'cand', number: 3, machine: `${MACHINE}::secondary` });
  const store = new Map([['cand', clone(candidate)]]);
  const { runner, writes, launches } = makeRunner({
    pollSnapshot: [candidate],
    store,
    playbooks: pooledPlaybooks(),
  });

  const result = await runner.pollAndClaim();

  assert.equal(result.claimed, 1);
  assert.deepEqual(launches, [{ number: 3, slot: 'secondary' }]);
  assert.equal(store.get('cand').fields[FIELD.machine], `${MACHINE}::secondary`);
  assert.equal(store.get('cand').fields[FIELD.status], 'in-progress');
  assert.equal(store.get('cand').fields[FIELD.claimedBy], IDENTITY);
});

test('a same-cycle reservation blocks a second item from the last free slot', async () => {
  // `primary` is occupied by a live lease; only `secondary` is free. Two
  // unassigned items poll together: the first reserves `secondary`, and that
  // same-cycle reservation must make the second wait rather than double-book it.
  const lease = item({
    id: 'lease',
    number: 4,
    status: 'in-progress',
    claimedBy: 'other-runner',
    machine: `${MACHINE}::primary`,
    leaseUntil: VALID,
  });
  const first = item({ id: 'first', number: 5, machine: '' });
  const second = item({ id: 'second', number: 6, machine: '' });

  const store = new Map([
    ['lease', clone(lease)],
    ['first', clone(first)],
    ['second', clone(second)],
  ]);
  const { runner, writes, launches } = makeRunner({
    pollSnapshot: [lease, first, second],
    store,
    playbooks: pooledPlaybooks(),
  });

  const result = await runner.pollAndClaim();

  assert.equal(result.claimed, 1);
  assert.deepEqual(launches, [{ number: 5, slot: 'secondary' }]);
  assert.equal(store.get('first').fields[FIELD.status], 'in-progress');
  assert.deepEqual(writesFor(writes, 'second'), []);
  assert.equal(store.get('second').fields[FIELD.status], 'ready');
});

test('first claim re-selects off its poll slot, freeing that slot for the second candidate the same cycle', async () => {
  // Both slots are free. Two unassigned items poll together, so the poll offers
  // the first candidate `primary` and (after reservation) the second candidate
  // whatever remains. But between poll and claim the first item's affinity
  // drifts to an exact `secondary`, so claimAndLaunch actually claims
  // `secondary`, not the poll-time `primary`. pollAndClaim must reserve the slot
  // that was really claimed (`secondary`) — not the stale `primary` hint — so
  // the still-unassigned second candidate can take the genuinely free `primary`
  // in the same cycle. With the stale-hint bug the runner reserves `primary`,
  // the fresh re-selection then finds only `secondary` (reserved) and the
  // occupied active worker, and the second candidate is wrongly blocked.
  const firstPoll = item({ id: 'first', number: 7, machine: '' });
  const firstFresh = item({ id: 'first', number: 7, machine: `${MACHINE}::secondary` });
  const second = item({ id: 'second', number: 8, machine: '' });

  const store = new Map([
    ['first', clone(firstFresh)],
    ['second', clone(second)],
  ]);
  const { runner, launches } = makeRunner({
    pollSnapshot: [firstPoll, second],
    store,
    playbooks: pooledPlaybooks(),
  });

  const result = await runner.pollAndClaim();

  assert.equal(result.claimed, 2);
  assert.deepEqual(launches, [
    { number: 7, slot: 'secondary' },
    { number: 8, slot: 'primary' },
  ]);
  assert.equal(store.get('first').fields[FIELD.machine], `${MACHINE}::secondary`);
  assert.equal(store.get('first').fields[FIELD.status], 'in-progress');
  assert.equal(store.get('second').fields[FIELD.machine], `${MACHINE}::primary`);
  assert.equal(store.get('second').fields[FIELD.status], 'in-progress');
  assert.equal(store.get('second').fields[FIELD.claimedBy], IDENTITY);
});
