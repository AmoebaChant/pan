# Task 6.6: Parallel Runner Worktrees

## Goal

Execute multiple claimed tasks concurrently with distinct branches, worktrees, state, worker sessions, leases, and versioned reports while preserving runner-owned delivery and security controls.

## Requirements addressed

REQ-EXEC-5–16, REQ-PLAY-8, REQ-REP-3–5, REQ-SEC-4–7

## Background

`RunnerDaemon` already tracks active slot promises, and `LocalTaskExecutor.start()` creates timestamped task branches/worktrees/state paths. `task-worker.js` strips GitHub/SSH credentials and denies git/gh shells; `LocalTaskHandle.complete()` verifies branch, remote, commits, pushes, creates a PR, and returns the worktree for cleanup. Task 6.4 adds versioned reports, and Task 6.5 allocates playbook slots.

## Files to modify/create

- `src/local-task-executor.js` — accept resolved playbook/settings, collision-proof task identity, and reporting callback.
- `src/task-worker.js` — consume playbook context and emit versioned started/progress/needs-human/completed/failed records.
- `src/runner-daemon.js` — publish reports, capacity updates, and independent heartbeat per task.
- `test/local-task-executor.test.js` — unique parallel paths/branches/context and credential stripping contract.
- `test/runner-daemon.test.js` — two concurrent tasks, same repository isolation, one lease loss, one success.
- `test/task-worker.test.js` — arguments/context/report validation through a fake Copilot process.

## Implementation details

1. Generate branch/worktree/state identities using Issue number plus collision-resistant token; never rely only on second-resolution timestamps.
2. Merge shared playbook instructions with local paths/tools/budgets at launch without serializing local secrets into repository files or GitHub.
3. Emit versioned claimed/started/heartbeat/progress/needs-human/completed/failed records; runner remains lease/heartbeat owner even if worker stalls.
4. Keep each task's handle, deadline, heartbeat, reports, and cleanup independent.
5. Revalidate repository identity, branch, lease, commit existence, remote, and base ancestry before push/PR.
6. Preserve best-effort release/blocked behavior on timeout, budget exhaustion, failure, or report errors.
7. Ensure one task losing its lease cannot publish completion while other slots continue.

## Testing suggestions

- `node --test test/local-task-executor.test.js test/task-worker.test.js test/runner-daemon.test.js`
- Use injected process/filesystem fakes; do not launch real terminals or push.
- `npm test`

## Gotchas

- Parallel tasks in one repository must never share a branch, worktree, state directory, or report ID.
- Worker progress cannot renew the lease.
- Never pass unnecessary delivery credentials to Copilot.

## Verification checklist

- [ ] Multiple tasks run independently up to configured limits.
- [ ] Lease loss blocks only the affected task's publication.
- [ ] Delivery remains runner-owned and PR-based.
- [ ] Targeted tests and `npm test` pass.
