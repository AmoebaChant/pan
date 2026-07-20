# Task 3.4: Validated Project Ordering

## Goal

Add a concurrency-safe store operation that validates a proposed complete order, re-reads current state, applies positions, confirms the result, and reports partial effects.

## Requirements addressed

REQ-ORD-1–3, REQ-ORD-9, REQ-ACT-2–8, REQ-STORE-9

## Background

`PanStore.reorderItems()` at `src/pan-store.js:399-424` blindly applies a sequence of position mutations and does not compare the order assumed by reasoning or confirm the final order. Task 2.1 added canonical snapshot identity. Task 1.2 actions carry expected state and idempotency keys. This task provides the safe primitive used by live reasoning.

## Files to modify/create

- `src/pan-store.js` — `applyCanonicalOrder()` or equivalent compare/apply/confirm operation.
- `test/pan-store.test.js` — invalid permutations, stale snapshot, concurrent drag, partial mutation, retry/idempotency, and confirmation.
- `docs/schema-module.md` — ordering API and failure result contract.

## Implementation details

1. Require a complete permutation of current Project item IDs, expected snapshot/order identity, turn ID, and idempotency key.
2. Re-read current canonical Project state immediately before mutation. If identity/order differs, return a stale-state result without applying.
3. Reject duplicates, missing IDs, unknown IDs, and attempts to omit non-actionable items from the canonical order.
4. Apply only necessary position mutations while preserving the requested complete order.
5. Re-read and confirm final order. Return confirmed effects or a structured incomplete result identifying the last confirmed position and current order.
6. Make retry safe: an already-confirmed target order with the same idempotency key returns success without repeated movement.
7. Do not change item fields in this operation.

## Testing suggestions

- `node --test test/pan-store.test.js`
- Extend `FakeGh` to inject a current-order change between preflight and mutation and a failure after one position update.
- `npm test`

## Gotchas

- Sequential GraphQL mutations are not atomic; incomplete state must be visible.
- Never treat the reasoning snapshot as current after a failed preflight.
- Canonical order includes all Project items, not only actionable ones.

## Verification checklist

- [ ] Stale assumptions cause re-read/re-evaluation, not overwrite.
- [ ] Final order is confirmed before success.
- [ ] Partial effects are structured and actionable.
- [ ] Targeted tests and `npm test` pass.
