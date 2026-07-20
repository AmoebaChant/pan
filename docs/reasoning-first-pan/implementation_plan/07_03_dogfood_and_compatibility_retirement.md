# Task 7.3: Dogfood and Compatibility Retirement

## Goal

Exercise reasoning-first PAN against one real configured domain in dry-run and controlled live mode, document results, then retire transitional deterministic triage and legacy runner configuration only after explicit compatibility gates pass.

## Requirements addressed

REQ-DATA-3, REQ-REA-11, REQ-PLAY-10, REQ-REL-6–7

## Background

Tasks 7.1–7.2 provide offline end-to-end coverage. The repository still contains transitional `deriveTriage()`, `compareBacklogItems()`, `PanDaemon` rule application, and legacy runner profiles. Retirement must preserve attention/store availability and Node 22/no-runtime-dependency compatibility. Dogfood must not commit private domain data or captured live content to this public repository.

## Files to modify/create

- `docs/dogfood.md` — generic procedure, acceptance checklist, rollback, and sanitized outcome summary.
- `src/pan-daemon.js` and `src/triage-policy.js` — remove or isolate deterministic portfolio mutation after gates pass.
- `src/runner-profile.js`, `schema/runner-profile.json`, and `bin/pan-runner.js` — finalize deprecation/retirement path according to observed compatibility.
- `README.md`, `docs/architecture.md`, `docs/triage-and-attention.md`, `docs/runner.md` — current behavior and migration status.
- Relevant existing tests — remove only tests for retired behavior; retain compatibility tests for supported adapters.

## Implementation details

1. Prepare a private domain config and Project fields outside this repository. Run schema/config validation, `pan review --dry-run`, and compare every Project item/classification/order/rationale with the GitHub UI.
2. Exercise controlled live reorder, rationale, manual drag preservation, inferred commitment creation/dedup/suppression, chat changes, attention, one runner claim, report, and PR handoff.
3. Record only sanitized counts/outcomes and defects in `docs/dogfood.md`; never copy private titles, paths, comments, locators, or credentials.
4. Gate retirement on: all end-to-end tests green; dogfood complete; attention works when reasoning is unavailable; no fixed priority/status sorting remains in live reasoning; runner canonical-order behavior verified.
5. Remove deterministic triage as a live fallback. If retained temporarily, make it an explicit opt-in compatibility command that cannot silently run after reasoning failure.
6. Retire legacy profile support only after documented migration; otherwise keep the adapter with a dated deprecation notice.
7. Confirm Node 22 and no runtime dependencies remain.

## Testing suggestions

- `node --test test/reasoning-e2e.test.js test/runner-e2e.test.js`
- `npm test`
- Run the documented private dogfood checklist manually.

## Gotchas

- Never commit private dogfood fixtures or logs.
- Do not fall back to fixed triage when the agent is unavailable.
- Compatibility retirement is conditional; keep adapters if the gate is not met.

## Verification checklist

- [ ] One real domain is validated end to end with sanitized documentation.
- [ ] Live portfolio judgment no longer uses fixed priority/status sorting.
- [ ] Unsupported legacy paths are removed only after migration gates pass.
- [ ] Targeted tests and `npm test` pass.
