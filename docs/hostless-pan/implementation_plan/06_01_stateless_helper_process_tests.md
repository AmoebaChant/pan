# Task 6.1: Stateless Helper Process Integration Tests

## Goal

Prove evidence, leadership, reconciliation, action, attention, configuration, and workstream helpers operate correctly as independent CLI processes with no shared in-memory service.

## Requirements addressed

REQ-TOOL-2–8, REQ-EVD-10–16, REQ-SAFE-11–15

## Background

The implementation now exposes all deterministic mechanics through `bin/pan.js`. Unit tests cover individual services, but hostless acceptance requires process-boundary tests that reload configuration and durable state on every invocation.

## Files to modify/create

- `test/stateless-helper-integration.test.js` — independent-process system tests.
- `test/fixtures/fake-gh.js` or equivalent existing fixture location — deterministic GitHub CLI substitute.
- `test/fixtures/hostless-domain/` — synthetic, data-neutral domain fixture if needed.
- `package.json` — no script change unless the existing `npm test` glob already includes the file.

## Implementation details

1. Spawn `bin/pan.js` separately for each helper call with a temporary domain config, fake authenticated `gh`, and disposable local repository.
2. Prove a snapshot created by one process is validated against fresh state by a later action/reconciliation process.
3. Cover complete and incomplete Issue/Project evidence, PR exclusion, pagination failure, stale expected state, leader contention/loss, and idempotent retries.
4. Exercise configuration read/validate/migrate, leadership status/acquire/assert/release, attention list/answer/add, missing-Issue reconciliation, merged-PR reconciliation, and action validate/apply.
5. Assert every JSON invocation emits one parseable common envelope and appropriate process exit status.
6. Assert no host state, endpoint, bearer token, MCP config, listener, or shared cache is created.
7. Keep fixtures synthetic and free of private domain content.

## Testing suggestions

- Name tests by user-visible scenario rather than internal module.
- Include a failure after an external effect and verify the next process repairs from durable identity.
- Run this file alone during development, then through `npm test`.

## Gotchas

- Do not import service classes directly in this integration suite; invoke the CLI process.
- Ensure fake `gh` responses model pagination and concurrency, not only happy-path commands.
- Process-local operation receipts must not become authoritative across unrelated sessions.

## Verification checklist

- [ ] Helpers work across separate Node processes using only durable/local configured state.
- [ ] Fresh reads reject stale snapshots and leadership generations.
- [ ] Every status/envelope/exit-code combination is correct.
- [ ] No host or MCP artifact is produced.
- [ ] Integration tests: `test/stateless-helper-integration.test.js`.
