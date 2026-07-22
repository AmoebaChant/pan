# Task 3.5: Workstream Publish Operation

## Goal

Validate, commit, and non-force push one prepared workstream update directly to the domain default branch with attribution, conflict detection, confirmation, and retry safety.

## Requirements addressed

REQ-WS-7–16, REQ-LEAD-6–7, REQ-REL-1–5

## Background

Task 3.4 creates an isolated detached worktree and records the expected remote base and target blob. Hostless PAN workstream delivery intentionally differs from runner delivery: it always commits directly to the domain repository's default branch and never opens an intermediate branch or pull request.

The publish helper must be a short-lived operation. It cannot rely on a host, in-memory snapshot, or the user's checkout.

## Files to modify/create

- `src/workstream-delivery.js` — publish, confirm, retry detection, and cleanup.
- `src/pan-cli.js` — add `pan workstream publish <operation-id>`.
- `src/action-service.js` — route workstream-update actions through publish when applicable.
- `test/workstream-delivery.test.js` — commit/push/conflict/idempotency cases.

## Implementation details

1. Load and validate the prepare receipt, current configuration, domain identity, session identity, and operation expiry.
2. Reject any diff outside the intended `workstreams/<path>/README.md` plus explicitly allowlisted closely related metadata. Reject symlinks, deletes outside scope, generated files, and unrelated staged content.
3. Validate required domain README conventions without rewriting unrelated content.
4. Fetch the remote default branch again. Revalidate leadership, expected remote base, and target blob/absence immediately before commit and again immediately before push.
5. Create one attributable commit containing only the intended files. Include the operation/turn identity, concise rationale, and stable idempotency marker in commit metadata.
6. Push with an ordinary non-force `HEAD:<default-branch>` update. Never create a remote delivery branch or pull request.
7. Confirm the remote default branch contains the commit. Return separate commit-created and push-confirmed effects.
8. On remote advance, branch protection, permissions, required review, or conflict, return rejected/incomplete status with confirmed state and a safe refresh/re-evaluation path.
9. Detect an already-published marker/commit on retry and avoid duplicate commits.
10. Clean the isolated worktree after confirmed completion; retain or describe it when needed for safe recovery.

## Testing suggestions

- Test successful push, no-op diff, unrelated diff, remote advance before commit/push, non-fast-forward rejection, branch protection-style rejection, and retry after confirmed push.
- Lose leadership after commit but before push; report the local commit as confirmed and do not push.
- Verify no PR or remote side branch is created.

## Gotchas

- A local commit is not a completed workstream update until the remote is confirmed.
- Never force-push or silently rebase over concurrent remote changes.
- Do not delete a recoverable workspace before reporting its location.

## Verification checklist

- [ ] Commit contains only authorized workstream changes and durable attribution.
- [ ] Delivery is direct to the default branch with no PR or remote side branch.
- [ ] Remote contention and leadership loss stop safely.
- [ ] Retries do not create duplicate commits.
- [ ] Integration tests: `test/workstream-delivery.test.js`.
