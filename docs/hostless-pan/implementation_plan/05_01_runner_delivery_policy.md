# Task 5.1: Runner Delivery Policy Compatibility

## Goal

Lock existing runner behavior to pull-request delivery by default while preserving explicit, policy-safe direct delivery, including PAN's own visible exception.

## Requirements addressed

REQ-RUN-1–13, REQ-MIG-3, REQ-MIG-12

## Background

Runner daemons remain separate deterministic services. `normalizePlaybooks()` and `validatePlaybook()` in `src/playbook.js:3-98` already default omitted delivery to `pull-request` and accept explicit `direct`. `LocalTaskExecutor` validates both modes, and `RunnerDaemon` moves direct delivery to `done` while PR delivery remains `in-review`.

Hostless PAN removal must not accidentally change these semantics or make domain workstream direct delivery the runner default.

## Files to modify/create

- `src/playbook.js` — retain explicit normalization and migration diagnostics.
- `schema/playbook.json` and `schema/runner-profile.json` — document default versus explicit direct mode.
- `src/local-task-executor.js` — preserve lease/no-force/conflict validation for direct mode.
- `src/runner-daemon.js` — preserve lifecycle transitions by delivery mode.
- `test/playbook.test.js` — legacy/default/explicit mode coverage.
- `test/local-task-executor.test.js` — direct/PR validation regressions.
- `test/runner-daemon.test.js` — lifecycle and merged-PR handoff.

## Implementation details

1. Keep omitted delivery normalized to `pull-request` for legacy and explicit playbooks.
2. Require `direct` to be visibly configured on the selected playbook; never infer it from repository identity or a `delivery:direct` task requirement alone.
3. Preserve isolated branch/worktree execution, active task lease checks, validation, non-force integration/push, conflict detection, and remote confirmation in direct mode.
4. Preserve PR delivery as `in-review` until Task 2.4 confirms merge. Preserve validated direct delivery as immediately eligible for `done`.
5. Ensure PAN's own development playbook may choose direct only through explicit private configuration.
6. Remove any runner dependency on PAN host/session settings; runner profiles remain independently loadable.
7. Keep sanitized runner availability readable by hostless evidence without exposing private paths or credentials.

## Testing suggestions

- Extend `test/playbook.test.js` for omitted mode, explicit PR, explicit direct, invalid mode, and legacy profiles.
- Retain direct/PR remote validation cases in `test/local-task-executor.test.js`.
- Verify `test/runner-daemon.test.js` transitions PR to `in-review` and direct to `done`.

## Gotchas

- PAN workstream updates are always direct, but runner task delivery is not.
- Do not copy session leadership settings into runner profiles.
- Direct delivery never bypasses task leases or repository policy.

## Verification checklist

- [ ] All omitted runner delivery modes remain pull-request.
- [ ] Direct mode requires explicit playbook configuration.
- [ ] Existing isolation, lease, validation, and no-force checks remain.
- [ ] Runner operation is independent of any PAN session.
- [ ] Integration tests: `test/playbook.test.js`; `test/local-task-executor.test.js`; `test/runner-daemon.test.js`.
