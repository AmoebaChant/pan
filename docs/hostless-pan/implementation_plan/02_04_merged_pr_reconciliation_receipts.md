# Task 2.4: Merged Pull Request Reconciliation Receipts

## Goal

Expose merged-pull-request completion as an explicit reconciliation command that confirms each external effect and remains safely retryable after partial transitions.

## Requirements addressed

REQ-REC-8–9, REQ-ATTN-9, REQ-REL-2–5

## Background

`PanStore.reconcileMergedPullRequests()` and `completeMergedPullRequest()` at `src/pan-store.js:372-440` already require an `in-review` item and a confirmed merged linked PR before setting `done` and closing the Issue. The current implementation attempts rollback and throws aggregate errors, which can obscure effects that GitHub already accepted.

Task 1.2 provides the common result envelope, Task 1.3 provides leadership assertion, and Task 2.2 provides fresh expected state.

## Files to modify/create

- `src/reconciliation-service.js` — add merged-PR planning/application.
- `src/pan-store.js` — expose confirmable status and Issue-close steps without destructive rollback assumptions.
- `src/pan-cli.js` — add `pan reconcile merged-prs [--apply]`.
- `test/reconciliation-service.test.js` — merged/open/partial/retry behavior.
- `test/pan-store.test.js` — retain low-level merge confirmation coverage.

## Implementation details

1. Plan from fresh `in-review` Project items and complete linked-PR evidence.
2. Require an actual merged state or merge timestamp. Never merge a pull request and never infer completion from branch names or comments.
3. Before setting `done`, revalidate leadership, item status, active lease state, and the linked PR merge evidence.
4. Confirm the Project field update before closing the Issue. Before closing, revalidate leadership again and confirm the Issue remains the expected open backing Issue.
5. If the status update is confirmed but Issue closure fails, report that confirmed status and the remaining closure step. Retry must close the same Issue without duplicating comments or transitions.
6. If an Issue was auto-closed by GitHub, treat that effect as already satisfied after confirming identity.
7. Return per-item receipts and an aggregate summary in both human-readable and JSON forms.

## Testing suggestions

- Cover open PR, merged PR, auto-closed Issue, already-done item, and missing linked evidence.
- Inject failures after status update and before/after Issue closure; verify precise confirmed/remaining effects.
- Lose leadership between the field update and Issue close and verify no later write begins.

## Gotchas

- Do not roll a confirmed `done` update back merely because Issue closure failed.
- A linked PR being closed is not equivalent to merged.
- Preserve unrelated attention comments and runner delivery records.

## Verification checklist

- [ ] Only confirmed merged PRs complete eligible `in-review` work.
- [ ] Project and Issue effects are confirmed separately.
- [ ] Partial transitions are visible and idempotently repairable.
- [ ] Machine-readable receipts preserve the backing Issue and PR identities.
- [ ] Integration tests: `test/reconciliation-service.test.js`; `test/pan-store.test.js`.
