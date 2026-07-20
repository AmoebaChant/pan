# Task 3.3: Rationale and Review Fields

## Goal

Add validated durable Project fields for concise per-item PAN rationale and the time of the last accepted portfolio review.

## Requirements addressed

REQ-DATA-10, REQ-ORD-7, REQ-REL-1–2

## Background

The current field manifest in `schema/project-fields.json` has no place for reasoning rationale or review time. `PanStore.getSchema()` validates all manifest fields and options before mutation. The chosen safe default is required text fields named `pan-rationale` and `pan-reviewed-at`; operational order audit remains on the `pan-state` branch rather than becoming queue truth.

## Files to modify/create

- `schema/project-fields.json` — add `rationale` and `reviewedAt` text fields.
- `src/pan-store.js` — normalize and validate RFC 3339 review time and bounded rationale text.
- `test/pan-store.test.js` — schema presence, invalid timestamp, length bounds, and field updates.
- `docs/store-schema.md` and `docs/schema-module.md` — field contract and setup/migration guidance.

## Implementation details

1. Add manifest keys `rationale`/`reviewedAt` mapped to Project text fields `pan-rationale`/`pan-reviewed-at`.
2. Validate `reviewedAt` as an RFC 3339 UTC timestamp and rationale as concise nonempty text within a documented limit.
3. Ensure existing field serialization and clearing semantics continue to work.
4. Update test manifests/fixtures so all store tests exercise the expanded required schema.
5. Document that rationale identifies the decision and durable citations compactly; full turn output is not stored in the field.
6. Document migration steps for existing Projects before enabling live reasoning.

## Testing suggestions

- `node --test test/pan-store.test.js`
- Verify missing new Project fields block mutation with clear setup errors.
- `npm test`

## Gotchas

- Adding required fields intentionally makes old Projects fail schema validation until migrated.
- Do not store full private transcripts or oversized model output in Project fields.
- Field state records accepted decisions, not a second ordering.

## Verification checklist

- [ ] The live Project schema requires both new text fields.
- [ ] Invalid review timestamps/rationale are rejected before mutation.
- [ ] Documentation includes explicit migration/setup.
- [ ] Targeted tests and `npm test` pass.
