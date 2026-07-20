# Task 6.5: Canonical Playbook Runner Selection

## Goal

Make runners select the highest-ranked compatible ready task directly from canonical Project order using enabled playbooks and available capacity, without an independent priority sort.

## Requirements addressed

REQ-ORD-3, REQ-EXEC-1–4, REQ-PLAY-6–7, REQ-PLAY-9

## Background

`RunnerDaemon.tick()` currently calls `listByFilter()` and then sorts candidates with `compareItems()` by priority and Issue number (`src/runner-daemon.js:74-82`, `src/runner-daemon.js:321-325`). Task 2.1 guarantees store order is canonical. Tasks 6.1–6.3 provide playbooks, settings, and availability/capacity. Atomic claims remain in `PanStore.claimWithLease()`.

## Files to modify/create

- `src/runner-daemon.js` — preserve store order, match playbooks, and allocate global/per-playbook slots.
- `src/playbook-matcher.js` — deterministic compatibility diagnostics.
- `test/runner-daemon.test.js` — canonical order, incompatible first item, per-playbook/global limits, offline/no slot, and claim race.
- `test/playbook-matcher.test.js` — exact requirement/repository/environment/tool matching.
- `src/index.js` — exports.

## Implementation details

1. Remove `PRIORITY`/`compareItems()` from runner selection. Iterate items in the order returned by the store.
2. Filter only ready, claimable, agent-owned items with executable autonomy and exactly one supported repository.
3. Match enabled playbooks and local capabilities; return explicit reasons for incompatibility.
4. For each free slot, choose the first compatible canonical item, atomically claim it, then reserve global and playbook-specific capacity.
5. Continue after a claim race using the remaining canonical sequence; never reorder candidates locally.
6. Preserve legacy profile behavior through the synthetic compatibility playbook.
7. Update advertisements as capacity changes.

## Testing suggestions

- `node --test test/runner-daemon.test.js test/playbook-matcher.test.js`
- Include a lower-priority Issue that appears first canonically and must be selected first.
- `npm test`

## Gotchas

- Compatibility filtering may skip an item, but local sorting may not change remaining precedence.
- Capacity reservation starts only after confirmed claim.
- Do not claim when no enabled compatible playbook has a free slot.

## Verification checklist

- [ ] Runner selection follows canonical Project order.
- [ ] Global and per-playbook limits are enforced.
- [ ] Claim races do not duplicate launches.
- [ ] Targeted tests and `npm test` pass.
