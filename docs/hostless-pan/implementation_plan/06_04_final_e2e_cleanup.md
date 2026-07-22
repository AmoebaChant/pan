# Task 6.4: Final End-to-End Acceptance and Cleanup

## Goal

Run the complete hostless acceptance matrix, remove remaining compatibility residue, and leave one documented session path plus independent runners.

## Requirements addressed

REQ-REC-1–15, REQ-ATTN-1–10, REQ-RUN-1–13, REQ-MIG-1–12

## Background

All prior tasks implement and test the individual hostless slices. This final task verifies their composition and removes only transitional paths whose replacements have passed. It must not introduce new product behavior.

## Files to modify/create

- `test/hostless-pan-e2e.test.js` — composed acceptance scenarios.
- `src/pan-cli.js`, `src/index.js`, `package.json` — final compatibility cleanup.
- `README.md` and `docs/*.md` — remove stale transitional notes discovered by acceptance.
- Delete obsolete fixtures/tests/files still referencing host/MCP behavior.

## Implementation details

1. Exercise first writing session, second read-only session, leadership handoff, normal exit, abnormal exit, and lease-expiry recovery.
2. Run a complete cited portfolio review and prove refusal when Issue, Project, workstream, or runner evidence is incomplete.
3. Reconcile a missing open Issue without duplicate creation, create sourced work with interruption/retry, and complete merged-PR work only after confirmed merge.
4. Apply stale field/order/Issue/leadership actions and verify rejection. Apply valid routine actions and verify durable rationale/evidence.
5. Perform direct workstream delivery with remote contention and prove no PR, force push, or unrelated working-tree modification.
6. Exercise attention list/answer/add and operational runner failure distinction.
7. Run runner selection/claim/heartbeat/worker isolation for default PR and explicit direct playbooks while no PAN session exists and while one is running.
8. Verify startup/cadence/retry/no-overlap/no-catch-up/stop-on-exit scheduling behavior.
9. Search source, package, tests, and docs for obsolete host/MCP/endpoint/token/background scheduler references. Remove remaining product code and update only intentional migration notes.
10. Run the complete existing `npm test` suite and inspect package contents.

## Testing suggestions

- Keep external GitHub/Copilot live acceptance opt-in; default E2E should use deterministic fakes and disposable git.
- Record scenario failures with enough fixture state to reproduce them.
- Do not weaken earlier fail-closed assertions to make the aggregate test pass.

## Gotchas

- Cleanup happens only after replacement scenarios pass.
- Do not remove compatibility for durable GitHub data, version 1 config reading, runner profiles, attention records, or leader records.
- No destructive GitHub migration is required.

## Verification checklist

- [ ] All acceptance scenarios pass with no resident PAN host or MCP bridge.
- [ ] Attention and runners retain their required behavior.
- [ ] Package/source/docs contain one primary `pan session` workflow.
- [ ] No obsolete runtime path remains authoritative.
- [ ] Integration tests: `test/hostless-pan-e2e.test.js`; full `npm test`.
