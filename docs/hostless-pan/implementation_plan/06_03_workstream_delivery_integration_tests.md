# Task 6.3: Workstream Delivery Integration Tests

## Goal

Prove direct workstream prepare/edit/publish behavior against real disposable git repositories, including dirty-checkout preservation, contention, partial effects, and retry cleanup.

## Requirements addressed

REQ-WS-3–16, REQ-REL-1–5

## Background

Tasks 3.4–3.5 implement isolated workstream delivery. Unit tests cover validation, but acceptance requires real git worktrees and remotes because the critical guarantees involve fetch/base selection, commit contents, non-force push, remote confirmation, and preservation of unrelated local changes.

## Files to modify/create

- `test/workstream-delivery-integration.test.js` — end-to-end git scenarios.
- `test/workstream-delivery.test.js` — keep unit-only validation cases.
- `test/git-fixture.js` — reusable disposable repository helpers if warranted.

## Implementation details

1. Create a bare remote, a user's domain checkout, and independent competing clones using existing system git.
2. Seed workstream hierarchy and configure a default branch. Make the user's checkout contain tracked staged/unstaged edits plus untracked files before preparation.
3. Run prepare, edit only the returned README, and publish. Verify the remote default branch contains one attributable commit and no remote side branch or pull request exists.
4. Compare the user's checkout before/after byte-for-byte, including index and untracked paths.
5. Advance the remote before publish and verify the helper refuses non-fast-forward overwrite with actionable refresh guidance.
6. Lose leadership after local commit but before push; verify receipt reports the commit and omits the push.
7. Retry after successful push and after partial local commit; ensure no duplicate commit is produced.
8. Exercise branch-policy/permission-style push rejection, invalid diff, new workstream creation, cleanup after success, and retained recovery workspace after incomplete delivery.

## Testing suggestions

- Run the file independently while developing because it performs real git operations.
- Assert exact commit file lists, messages/markers, parent/base, remote reachability, and branch list.
- Use only disposable repository directories created by the test.

## Gotchas

- Do not mock git for the final integration assertions.
- Avoid relying on global git identity; configure identity inside fixtures.
- A local commit without remote confirmation is an incomplete outcome.

## Verification checklist

- [ ] Successful delivery creates exactly one attributable default-branch commit.
- [ ] No PR or remote delivery branch is created.
- [ ] Dirty user checkout and index remain unchanged.
- [ ] Remote contention, leadership loss, and push rejection are truthful and retryable.
- [ ] Integration tests: `test/workstream-delivery-integration.test.js`.
