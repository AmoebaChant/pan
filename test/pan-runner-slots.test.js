import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import {
  affinityBase,
  affinityMatchesMachine,
  AFFINITY_SEP,
  canonicalPathKey,
  formatAffinity,
  isSlotPooled,
  machineHasSeparator,
  parseWorkspaceSlots,
  selectSlot,
  splitAffinity,
} from '../bin/pan-runner-slots.js';
import { splitFrontMatter } from '../bin/pan-runner.js';

const SLOT_PATH_A = path.resolve('slot-a');
const SLOT_PATH_B = path.resolve('slot-b');

// --- machine affinity helpers ---------------------------------------------

test('composite machine affinity round-trips through its base and slot', () => {
  assert.equal(AFFINITY_SEP, '::');
  assert.equal(formatAffinity('box', 'primary'), 'box::primary');
  assert.equal(formatAffinity('box', null), 'box');

  assert.deepEqual(splitAffinity('box::primary'), { base: 'box', slot: 'primary' });
  assert.deepEqual(splitAffinity('box'), { base: 'box', slot: null });
  assert.deepEqual(splitAffinity(''), { base: '', slot: null });

  assert.equal(affinityBase('box::primary'), 'box');
  assert.equal(affinityBase('box'), 'box');

  assert.equal(affinityMatchesMachine('box::primary', 'box'), true);
  assert.equal(affinityMatchesMachine('box', 'box'), true);
  assert.equal(affinityMatchesMachine('other::primary', 'box'), false);
  assert.equal(affinityMatchesMachine('other', 'box'), false);
});

test('a machine name with the reserved separator is detected', () => {
  assert.equal(machineHasSeparator('box::primary'), true);
  assert.equal(machineHasSeparator('box'), false);
  assert.equal(machineHasSeparator(''), false);
});

test('isSlotPooled distinguishes slot-pooled from ordinary playbooks', () => {
  assert.equal(isSlotPooled({ slots: [{ id: 'a', dir: 'C:\\a' }] }), true);
  assert.equal(isSlotPooled({ slots: [] }), false);
  assert.equal(isSlotPooled({ slots: null }), false);
  assert.equal(isSlotPooled({ workingDirectory: 'C:\\a' }), false);
  assert.equal(isSlotPooled({}), false);
});

// --- workspaceSlots parsing / validation ----------------------------------

test('parseWorkspaceSlots accepts a valid ordered mapping', () => {
  const slots = parseWorkspaceSlots([
    ['primary', SLOT_PATH_A],
    ['secondary', SLOT_PATH_B],
  ]);
  assert.deepEqual(slots, [
    { id: 'primary', dir: SLOT_PATH_A },
    { id: 'secondary', dir: SLOT_PATH_B },
  ]);
});

test('parseWorkspaceSlots rejects an absent or empty mapping', () => {
  assert.throws(() => parseWorkspaceSlots(null), /at least one slot/);
  assert.throws(() => parseWorkspaceSlots([]), /at least one slot/);
});

test('parseWorkspaceSlots rejects invalid slot ids including "::"', () => {
  assert.throws(() => parseWorkspaceSlots([['', 'C:\\a']]), /invalid slot id/);
  assert.throws(() => parseWorkspaceSlots([['a::b', 'C:\\a']]), /invalid slot id/);
  assert.throws(() => parseWorkspaceSlots([['a b', 'C:\\a']]), /invalid slot id/);
});

test('parseWorkspaceSlots rejects missing or relative paths', () => {
  assert.throws(() => parseWorkspaceSlots([['a', null]]), /absolute path/);
  assert.throws(() => parseWorkspaceSlots([['a', '   ']]), /absolute path/);
  assert.throws(() => parseWorkspaceSlots([['a', 'relative\\path']]), /must be absolute/);
});

test('parseWorkspaceSlots rejects duplicate ids and duplicate paths', () => {
  assert.throws(
    () => parseWorkspaceSlots([['a', SLOT_PATH_A], ['a', SLOT_PATH_B]]),
    /duplicate slot id "a"/,
  );
  assert.throws(
    () => parseWorkspaceSlots([['a', SLOT_PATH_A], ['b', SLOT_PATH_A]]),
    /repeats path/,
  );
});

// --- canonical path comparison --------------------------------------------

test('canonicalPathKey case-folds on Windows and not on POSIX', () => {
  // Same directory spelled two ways: equal under Windows semantics, distinct
  // under POSIX semantics.
  assert.equal(
    canonicalPathKey('C:\\Work', 'win32'),
    canonicalPathKey('c:\\work', 'win32'),
  );
  assert.notEqual(
    canonicalPathKey('/srv/Work', 'linux'),
    canonicalPathKey('/srv/work', 'linux'),
  );
  // Genuinely distinct paths never share a key on either platform.
  assert.notEqual(
    canonicalPathKey('C:\\Work', 'win32'),
    canonicalPathKey('C:\\Other', 'win32'),
  );
});

test('parseWorkspaceSlots rejects two slots whose paths differ only by case (Windows)', () => {
  // On Windows the filesystem is case-insensitive, so C:\Work and c:\work are
  // the same directory and must be rejected as a repeated path. Guarded to the
  // Windows platform, where path.resolve produces comparable drive-letter paths.
  if (process.platform !== 'win32') return;
  assert.throws(
    () => parseWorkspaceSlots([['a', 'C:\\Work'], ['b', 'c:\\work']]),
    /repeats path/,
  );
  // Ordinary distinct paths still pass.
  assert.deepEqual(
    parseWorkspaceSlots([['a', 'C:\\Work'], ['b', 'C:\\Work.2']]),
    [{ id: 'a', dir: 'C:\\Work' }, { id: 'b', dir: 'C:\\Work.2' }],
  );
});

test('splitFrontMatter reads a nested workspaceSlots mapping and leaves flat scalars intact', () => {
  const text = [
    '---',
    'name: pooled',
    'description: Pooled playbook',
    'capacity: 2',
    'workspaceSlots:',
    "  primary: 'C:\\Product'",
    "  secondary: 'C:\\Product.2'",
    '---',
    'Body.',
    '',
  ].join('\n');
  const { front, body } = splitFrontMatter(text);
  assert.equal(front.name, 'pooled');
  assert.equal(front.description, 'Pooled playbook');
  assert.equal(front.capacity, '2');
  assert.deepEqual(front.workspaceSlots, [
    ['primary', 'C:\\Product'],
    ['secondary', 'C:\\Product.2'],
  ]);
  assert.match(body, /Body\./);
});

test('splitFrontMatter marks a declared-but-empty workspaceSlots as present and null', () => {
  const text = ['---', 'name: pooled', 'workspaceSlots:', '---', 'Body.', ''].join('\n');
  const { front } = splitFrontMatter(text);
  assert.equal('workspaceSlots' in front, true);
  assert.equal(front.workspaceSlots, null);
});

// --- slot selection --------------------------------------------------------

const SLOTS = [
  { id: 'primary', dir: 'C:\\p' },
  { id: 'secondary', dir: 'C:\\s' },
];

test('new work takes the first configured free slot deterministically', () => {
  assert.deepEqual(
    selectSlot({ slots: SLOTS, machineField: '', machine: 'box', occupied: new Set() }),
    { ok: true, slot: 'primary' },
  );
  assert.deepEqual(
    selectSlot({ slots: SLOTS, machineField: '', machine: 'box', occupied: new Set(['primary']) }),
    { ok: true, slot: 'secondary' },
  );
  const full = selectSlot({
    slots: SLOTS,
    machineField: '',
    machine: 'box',
    occupied: new Set(['primary', 'secondary']),
  });
  assert.equal(full.ok, false);
});

test('a legacy exact-machine value is treated as unassigned and picks the first free slot', () => {
  assert.deepEqual(
    selectSlot({ slots: SLOTS, machineField: 'box', machine: 'box', occupied: new Set() }),
    { ok: true, slot: 'primary' },
  );
});

test('a prior composite affinity uses only its exact slot and waits if busy', () => {
  assert.deepEqual(
    selectSlot({ slots: SLOTS, machineField: 'box::secondary', machine: 'box', occupied: new Set() }),
    { ok: true, slot: 'secondary' },
  );
  const busy = selectSlot({
    slots: SLOTS,
    machineField: 'box::secondary',
    machine: 'box',
    occupied: new Set(['secondary']),
  });
  assert.equal(busy.ok, false);
});

test('a composite affinity for another machine or an unconfigured slot is skipped', () => {
  assert.equal(
    selectSlot({ slots: SLOTS, machineField: 'other::primary', machine: 'box', occupied: new Set() }).ok,
    false,
  );
  assert.equal(
    selectSlot({ slots: SLOTS, machineField: 'box::gone', machine: 'box', occupied: new Set() }).ok,
    false,
  );
});

test('serial reservation walks distinct slots as each choice is reserved', () => {
  const occupied = new Set();
  const first = selectSlot({ slots: SLOTS, machineField: '', machine: 'box', occupied });
  assert.deepEqual(first, { ok: true, slot: 'primary' });
  occupied.add(first.slot);
  const second = selectSlot({ slots: SLOTS, machineField: '', machine: 'box', occupied });
  assert.deepEqual(second, { ok: true, slot: 'secondary' });
  occupied.add(second.slot);
  const third = selectSlot({ slots: SLOTS, machineField: '', machine: 'box', occupied });
  assert.equal(third.ok, false);
});

// --- claim-time re-selection against the fresh affinity --------------------
// At claim re-read the runner re-runs selectSlot with the freshly-read `machine`
// value and current occupancy, discarding the poll's stale choice. These cases
// pin the decision for each fresh affinity shape.

test('claim re-read: an unassigned task takes the current first free slot (primary occupied -> secondary)', () => {
  assert.deepEqual(
    selectSlot({ slots: SLOTS, machineField: '', machine: 'box', occupied: new Set(['primary']) }),
    { ok: true, slot: 'secondary' },
  );
});

test('claim re-read: a stale poll choice does not override the fresh free-slot pick', () => {
  // The poll may have chosen `primary`, but primary is now occupied and the
  // fresh affinity is still unassigned, so re-selection yields `secondary`.
  const decision = selectSlot({ slots: SLOTS, machineField: '', machine: 'box', occupied: new Set(['primary']) });
  assert.deepEqual(decision, { ok: true, slot: 'secondary' });
});

test('claim re-read: a foreign-machine affinity is skipped', () => {
  assert.equal(
    selectSlot({ slots: SLOTS, machineField: 'other::primary', machine: 'box', occupied: new Set() }).ok,
    false,
  );
});

test('claim re-read: an unconfigured slot affinity is skipped', () => {
  assert.equal(
    selectSlot({ slots: SLOTS, machineField: 'box::gone', machine: 'box', occupied: new Set() }).ok,
    false,
  );
});

test('claim re-read: a valid exact affinity is honored, and waits when its slot is occupied', () => {
  assert.deepEqual(
    selectSlot({ slots: SLOTS, machineField: 'box::secondary', machine: 'box', occupied: new Set() }),
    { ok: true, slot: 'secondary' },
  );
  assert.equal(
    selectSlot({ slots: SLOTS, machineField: 'box::secondary', machine: 'box', occupied: new Set(['secondary']) }).ok,
    false,
  );
});
