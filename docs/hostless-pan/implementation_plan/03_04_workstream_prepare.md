# Task 3.4: Workstream Prepare Operation

## Goal

Prepare an isolated, bounded edit workspace for one workstream README without touching the user's existing working trees.

## Requirements addressed

REQ-WS-1–6, REQ-WS-9–10, REQ-DOM-5–7

## Background

`WorkstreamStore` in `src/workstream-store.js:17-198` already supports confined list/read/search/history. `resolveWorkstreamReadme()` and `resolveConfinedWorkstreamReadme()` at `src/workstream-store.js:200-235` prevent path and symlink escapes. No write workflow exists.

Tasks 1.1–1.3 provide domain validation and leadership contracts. Task 2.2 supplies workstream blob/git revisions. This task prepares the edit; Task 3.5 publishes it.

## Files to modify/create

- `src/workstream-delivery.js` — prepare operation and operation receipt persistence.
- `src/workstream-store.js` — share canonical path validation for existing and new workstreams.
- `src/process-client.js` — bounded git invocation support if required.
- `src/pan-cli.js` — add `pan workstream prepare <path>`.
- `test/workstream-delivery.test.js` — preparation, confinement, and cleanup tests.
- `test/workstream-store.test.js` — new-workstream path validation.

## Implementation details

1. Validate configuration, local clone identity versus configured GitHub repository, default branch, workstream path, and leadership before preparation.
2. Fetch the remote default branch without changing the user's checkout.
3. Capture the fetched base commit and current target blob identity or confirmed absence for a new workstream.
4. Create a detached isolated worktree under a PAN-owned bounded operation directory, based directly on the fetched remote default branch.
5. Create parent directories for an authorized new workstream but allow edits only to `workstreams/<path>/README.md`.
6. Write a local operation receipt containing operation/session identity, domain, path, base, expected blob/absence, workspace, rationale/source turn, expiry, and cleanup data. Do not treat it as durable domain state.
7. Return the exact workspace and file path Copilot may edit, plus the expected-state values needed by publish.
8. On any preparation failure, remove only artifacts created by this operation and report safe recovery.

## Testing suggestions

- Use a disposable repository with a bare remote, a dirty main checkout, existing and new workstreams, and a remote advance.
- Verify staged, unstaged, and untracked user files remain byte-for-byte unchanged.
- Test invalid paths, symlink escapes, repository mismatch, leadership rejection, and cleanup after failed worktree creation.

## Gotchas

- Never run reset, clean, checkout, or commit in the user's existing working tree.
- The base must be the freshly fetched remote default branch, not local `HEAD`.
- Operation receipts are conveniences, not a second workstream queue.

## Verification checklist

- [ ] Preparation uses a freshly fetched remote default-branch commit.
- [ ] Only one canonical workstream README is exposed for editing.
- [ ] Existing user working trees are unchanged.
- [ ] Receipt records base and target blob/absence for optimistic publish.
- [ ] Integration tests: `test/workstream-delivery.test.js`; `test/workstream-store.test.js`.
