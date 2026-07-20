# Task 6.4: Versioned Reporting Protocol

## Goal

Add versioned, validated, idempotent records for claimed, started, heartbeat, progress, needs-human, completed, and failed execution while continuing to read current marked comments.

## Requirements addressed

REQ-REP-1–7, REQ-CONV-6, REQ-REL-3–4

## Background

Current reporting is split between lease fields, `formatNeedsHuman()` JSON comments, answer/resolution markers, and unversioned runner-result comments in `src/needs-human.js` and `src/runner-daemon.js:381-389`. `LocalTaskExecutor` polls unversioned local JSON result files. The new protocol must preserve these readers during migration.

## Files to modify/create

- `schema/execution-report.json` — versioned report union.
- `src/reporting.js` — validate, format, parse, deduplicate, and project current state.
- `src/needs-human.js` — read both legacy and versioned attention/result records.
- `test/reporting.test.js` — every record kind, unknown version, malformed record, duplicate delivery, and projection.
- `test/needs-human.test.js` and `test/attention-service.test.js` — compatibility.
- `docs/runner.md` — reporting contract.
- `src/index.js` — exports.

## Implementation details

1. Define common task ID/item ID, report ID, actor/runner, timestamp, state, and idempotency key.
2. Add kind-specific lease, progress, locator, question, summary, PR, failure, and budget details.
3. Reject unknown versions or safely ignore them with visible diagnostics; never interpret malformed data as success.
4. Format durable GitHub comments with a versioned marker and fenced JSON; parse legacy markers first-release compatibility.
5. Deduplicate unchanged report IDs/idempotency keys and prevent repeated lifecycle transitions/attention entries.
6. Project current attention/result/locator state for `AttentionService` without exposing unsanitized machine settings.

## Testing suggestions

- `node --test test/reporting.test.js test/needs-human.test.js test/attention-service.test.js`
- Verify legacy fixtures remain readable.
- `npm test`

## Gotchas

- A heartbeat report does not replace the lease field confirmation.
- Unknown versions cannot silently become completion.
- Do not put credentials or unrestricted local paths in report locators.

## Verification checklist

- [ ] All seven report kinds validate and round-trip.
- [ ] Legacy records remain readable.
- [ ] Duplicate records are idempotent.
- [ ] Targeted tests and `npm test` pass.
