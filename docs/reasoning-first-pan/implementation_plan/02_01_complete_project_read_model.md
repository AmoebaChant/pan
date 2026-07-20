# Task 2.1: Complete Project Read Model

## Goal

Extend `PanStore` so a caller can enumerate the complete canonical Project order with all Issue and field evidence required for portfolio classification, while failing closed on truncation or unsupported content.

## Requirements addressed

REQ-DATA-2–4, REQ-DATA-11, REQ-REA-1–3, REQ-STORE-9

## Background

`PanStore.#listItems()` already preserves GraphQL connection order and rejects Projects above a fixed 100-item limit. `PROJECT_ITEM_SELECTION` in `src/pan-store.js:8-55` includes core Issue content and 20 field values but omits update timestamps and pagination evidence for assignees/labels. `listComments()` is a separate per-Issue CLI read. The portfolio layer needs explicit completeness metadata rather than assuming a partial read is complete.

## Files to modify/create

- `src/pan-store.js` — richer ordered item reads, completeness checks, current-order identity, and batch Issue detail/comment retrieval.
- `test/pan-store.test.js` — pagination, truncation, order identity, timestamps, non-Issue items, and comment failures.
- `docs/schema-module.md` — document the complete-read API.

## Implementation details

1. Add a named method such as `readCanonicalProject()` returning ordered items plus a stable snapshot identity derived from current item IDs and mutable evidence timestamps/field values.
2. Include Issue `updatedAt`, created time, comments or complete comment metadata, labels, assignees, state, repository, and all required Project fields.
3. Reject draft/redacted/unsupported items if they prevent complete classification; report the item ID and reason.
4. Remove the silent fixed 100-item product limit by paginating to completion with a configurable safety ceiling. If the ceiling is exceeded, fail closed rather than returning a partial portfolio.
5. Detect pagination on field values, labels, assignees, and comments. Either page them completely or reject the snapshot.
6. Keep `listItems()` compatibility for existing attention/runner callers, implemented over the richer normalized model where practical.
7. Preserve Project connection order exactly.

## Testing suggestions

- `node --test test/pan-store.test.js`
- Add tests named for complete multi-page enumeration, field/comment truncation rejection, and stable snapshot identity.
- `npm test`

## Gotchas

- Do not sort in the store; GraphQL order is canonical.
- Do not fabricate empty comments or fields after a failed read.
- Rate-limit and permission failures must remain distinguishable.

## Verification checklist

- [ ] Every Project item is returned in canonical order or the read fails.
- [ ] Required Issue/comment/field evidence has explicit completeness checks.
- [ ] Existing store and lease tests remain green.
- [ ] Targeted tests and `npm test` pass.
