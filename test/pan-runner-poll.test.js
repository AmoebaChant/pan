import assert from 'node:assert/strict';
import test from 'node:test';
import { FIELD, preparePoll } from '../bin/pan-runner-poll.js';

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
    active: new Map([[8, { itemId: 'supervised-item' }]]),
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
