// Workspace slots: a small, self-contained helper module.
//
// A slot-pooled playbook declares a fixed set of named workspace directories
// (`workspaceSlots`) instead of a single `workingDirectory`. Each running task
// occupies exactly one slot, so the playbook's concurrency is bounded by the
// number of slots. The chosen slot is persisted in the runner-owned `machine`
// Project field as a composite `<machine>::<slot>` affinity, so a paused task
// resumes in the exact slot it ran in. This module holds only pure helpers:
// affinity string parsing, front-matter slot validation, and slot selection.

import path from 'node:path';

/** Separator between the physical machine name and its slot id in the `machine`
 *  field. Reserved: neither a machine name nor a slot id may contain it. */
export const AFFINITY_SEP = '::';

/** Split a `machine` field value into its base machine and optional slot.
 *  A value with no separator is an ordinary exact-machine value (`slot: null`). */
export function splitAffinity(value) {
  const raw = value == null ? '' : String(value);
  const idx = raw.indexOf(AFFINITY_SEP);
  if (idx === -1) return { base: raw, slot: null };
  return { base: raw.slice(0, idx), slot: raw.slice(idx + AFFINITY_SEP.length) };
}

/** Build a `machine` field value. A null slot yields the ordinary machine name
 *  unchanged, so ordinary playbooks keep writing exactly what they wrote before. */
export function formatAffinity(machine, slot) {
  return slot == null ? machine : `${machine}${AFFINITY_SEP}${slot}`;
}

/** The physical machine an affinity belongs to, ignoring any slot suffix. */
export function affinityBase(value) {
  return splitAffinity(value).base;
}

/** Whether an affinity (composite or exact) belongs to this physical machine. */
export function affinityMatchesMachine(value, machine) {
  return affinityBase(value) === machine;
}

/** Whether a physical machine name contains the reserved separator, which would
 *  make its composite affinities impossible to round-trip. */
export function machineHasSeparator(machine) {
  return String(machine == null ? '' : machine).includes(AFFINITY_SEP);
}

/** A canonical comparison key for a filesystem path so two spellings of the same
 *  directory compare equal. The path is fully resolved and, on Windows (where
 *  the filesystem is case-insensitive), case-folded so `C:\Work` and `c:\work`
 *  share a key. `platform` is injectable so the Windows rule stays testable off
 *  Windows. This is a plain lexical/case comparison only — no realpath, symlink,
 *  or filesystem resolution. */
export function canonicalPathKey(dir, platform = process.platform) {
  const resolved = path.resolve(dir);
  return platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** Whether a loaded playbook pools work across named workspace slots. */
export function isSlotPooled(playbook) {
  return Array.isArray(playbook?.slots) && playbook.slots.length > 0;
}

const SLOT_ID_RE = /^[A-Za-z0-9_-]+$/;

/** Validate the `workspaceSlots` front-matter mapping and return its slots as an
 *  ordered `[{ id, dir }]` list. `raw` is the array of `[id, value]` pairs the
 *  front-matter parser produces for a nested mapping (order preserved, so
 *  duplicate ids are visible). Throws a plain Error the caller turns into a
 *  file-scoped UserError. */
export function parseWorkspaceSlots(raw) {
  if (raw == null || (Array.isArray(raw) && raw.length === 0)) {
    throw new Error('workspaceSlots must declare at least one slot');
  }
  if (!Array.isArray(raw)) {
    throw new Error('workspaceSlots must be a mapping of slot id to absolute path');
  }
  const slots = [];
  const seenIds = new Set();
  const seenPaths = new Set();
  for (const [id, value] of raw) {
    if (!id || !SLOT_ID_RE.test(id)) {
      throw new Error(
        `workspaceSlots has an invalid slot id ${JSON.stringify(id ?? null)} ` +
          '(use letters, digits, "_" or "-", and never "::")',
      );
    }
    if (value == null || String(value).trim() === '') {
      throw new Error(`workspaceSlots slot "${id}" must have an absolute path`);
    }
    const dir = String(value).trim();
    if (!path.isAbsolute(dir)) {
      throw new Error(`workspaceSlots slot "${id}" path must be absolute, got: ${dir}`);
    }
    if (seenIds.has(id)) {
      throw new Error(`workspaceSlots has a duplicate slot id "${id}"`);
    }
    const resolved = canonicalPathKey(dir);
    if (seenPaths.has(resolved)) {
      throw new Error(`workspaceSlots slot "${id}" repeats path ${dir} already used by another slot`);
    }
    seenIds.add(id);
    seenPaths.add(resolved);
    slots.push({ id, dir });
  }
  return slots;
}

/** Choose the slot a slot-pooled task should run in this poll, or explain why
 *  none is available. `occupied` is the set of slot ids already in use on this
 *  physical machine. A prior composite affinity binds the task to its exact
 *  slot and waits if that slot is busy; anything else (new work, or a legacy
 *  exact-machine task treated as unassigned) takes the first configured free
 *  slot deterministically. */
export function selectSlot({ slots, machineField, machine, occupied }) {
  const ids = slots.map((s) => s.id);
  const { base, slot } = splitAffinity(machineField ?? '');
  if (slot != null) {
    if (base !== machine) return { ok: false, reason: `affinity for another machine (${base})` };
    if (!ids.includes(slot)) return { ok: false, reason: `slot "${slot}" is not configured by this playbook` };
    if (occupied.has(slot)) return { ok: false, reason: `slot "${slot}" is busy` };
    return { ok: true, slot };
  }
  for (const id of ids) {
    if (!occupied.has(id)) return { ok: true, slot: id };
  }
  return { ok: false, reason: 'all configured slots are busy' };
}
