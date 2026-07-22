# Task 3.2: Leadership-Aware Action Validation and Apply

## Goal

Move live action validation and application into short-lived `pan action validate|apply` commands that revalidate complete evidence, policy, leadership, and expected state before every write.

## Requirements addressed

REQ-PORT-5–10, REQ-LEAD-6–8, REQ-SAFE-1–15

## Background

`PanReviewService.applyActions()` and `#apply()` in `src/pan-review-service.js:141-294` currently own validation and application inside a long-lived service. `ActionPolicy` in `src/action-policy.js:17-205` already protects active leases, protected lifecycle states, blocks, and complete reorder membership. Tasks 1.3, 2.2, and 3.1 provide leadership assertions, fresh snapshot references, and richer action contracts.

## Files to modify/create

- `src/action-service.js` — stateless validate/apply orchestration.
- `src/action-policy.js` — explicit automatic/approval/prohibited classifications and protected precedence checks.
- `src/pan-store.js` — confirmable resource mutation primitives.
- `src/pan-cli.js` — add `pan action validate|apply`.
- `src/pan-review-service.js` — reduce to reasoning/dry-run compatibility until removed.
- `test/action-service.test.js` — validation/application/leadership/partial-effect cases.
- `test/action-policy.test.js` — policy regressions.

## Implementation details

1. Load fresh version 2 configuration and snapshot for each command. Validate schema, configured domain, complete required evidence, action classification, lifecycle, leases, blocks, human precedence, and expected resource state.
2. Require the caller's current session leadership identity/generation for `apply`; `validate` may run read-only.
3. Immediately before each external write, assert leadership again and reread the affected resource. Stop all later writes after loss or mismatch.
4. Apply Project fields and ordering with compare-read-write-confirm. A reorder must contain every current item exactly once and preserve durable human relative precedence unless explicitly authorized.
5. Apply comments, attention, and other Issue operations idempotently using stable markers and confirmation reads.
6. Process independent groups one action at a time with per-action receipts. Reject unsupported all-or-none groups before mutation.
7. Never claim completion until every required effect is confirmed. Return partial external effects with remaining steps.
8. Keep approval-required and prohibited actions distinct from stale/incomplete evidence rejections.

## Testing suggestions

- Test stale fields/order, active leases, protected statuses, human precedence, missing rationale/evidence, approval-required policy, and prohibited operations.
- Lose leadership before each external step and verify no subsequent write begins.
- Retry confirmed comments/fields/reorders and verify idempotency.

## Gotchas

- Do not trust the snapshot embedded in an action without refreshing the current resources.
- Do not let ordinary GitHub credentials bypass leadership or policy.
- A successful first action does not authorize later actions from stale evidence.

## Verification checklist

- [ ] `validate` is side-effect free and usable read-only.
- [ ] `apply` independently confirms leadership and expected state before every write.
- [ ] Lifecycle, lease, block, and human-precedence protections remain intact.
- [ ] Partial effects and approvals are reported accurately.
- [ ] Integration tests: `test/action-service.test.js`; `test/action-policy.test.js`.
