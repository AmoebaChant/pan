# Task 7.2: Runner End-to-end Tests

## Goal

Add deterministic system tests for playbook matching, sanitized advertisements, canonical-order claims, parallel isolated execution, versioned reporting, lease loss, and PR handoff.

## Requirements addressed

REQ-EXEC-1–16, REQ-PLAY-1–10, REQ-REP-1–7

## Background

Phase 6 adds playbooks, local settings, advertisements, reporting, canonical selection, and parallel executor integration. Existing `test/runner-daemon.test.js` verifies focused lifecycle behavior with fakes; these system tests should compose the actual runner modules while replacing terminal, git, gh, and Copilot processes with deterministic adapters.

## Files to modify/create

- `test/runner-e2e.test.js` — complete runner scenarios.
- `test/helpers/fake-runner-environment.js` — fake process/git/GitHub/terminal surfaces.
- `test/fixtures/playbooks/` — generic shared playbooks and local settings fixtures.

## Implementation details

1. Compose production playbook/settings loaders, matcher, runner daemon, executor, reporting, and advertisement publisher.
2. Cover canonical order where the first item is incompatible and the next compatible item is claimed without local resorting.
3. Run two tasks against the same repository concurrently and assert distinct branches, worktrees, state paths, sessions, leases, and reports.
4. Complete one task to a PR/in-review while making the other lose its lease; assert the lost task cannot push/create a PR.
5. Cover needs-human, timeout/budget failure, duplicate report delivery, advertisement capacity decrement/restore, and legacy profile adapter.
6. Assert worker environment lacks delivery credentials and all publication stays on task branches.

## Testing suggestions

- `node --test test/runner-e2e.test.js`
- Run focused runner tests if the system fixture exposes a failure.
- `npm test`

## Gotchas

- Avoid real git remotes, terminals, GitHub, or Copilot.
- Parallel assertions must not depend on nondeterministic completion order.
- Do not make legacy compatibility bypass playbook/capacity safety.

## Verification checklist

- [ ] Canonical-order selection and playbook filtering work together.
- [ ] Parallel tasks are fully isolated.
- [ ] Reports/advertisements are idempotent and sanitized.
- [ ] Targeted tests and `npm test` pass.
