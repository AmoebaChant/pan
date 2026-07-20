# Task 3.6: Live Reasoning Application

## Goal

Apply accepted PAN portfolio actions through authority, lifecycle, lease, domain, manual-order, and concurrency validation, then persist concise rationale and auditable results.

## Requirements addressed

REQ-REA-9–11, REQ-ORD-1–9, REQ-ACT-1–10

## Background

Task 3.1 produces validated dry-run proposals. Tasks 3.3–3.5 add durable rationale fields, safe ordering, and manual constraints. `PanStore` already confirms leases and field transitions, while `PanDaemon.#setStatus()` demonstrates lease-protected status changes. This task creates the common live action executor; runtime and chat will both call it.

## Files to modify/create

- `src/action-executor.js` — ordered validation/application with structured effects.
- `src/reasoning-service.js` — enable `dryRun: false` through the executor.
- `src/action-policy.js` — complete automatic/explanation/approval authority decisions.
- `test/action-executor.test.js` — fields, order, comments, approvals, stale state, lease/lifecycle blocks, and partial effects.
- `test/reasoning-service.test.js` — live success and re-evaluation request.
- `src/index.js` — exports.

## Implementation details

1. Revalidate the current snapshot/order/lease state before each mutation group.
2. Apply actions in a safe sequence: questions/comments; non-racing metadata; canonical order; rationale/review fields; audit confirmation. Defer inferred Issue creation to Phase 4.
3. Reject automated changes to in-progress, in-review, done, active leases, and human/runner blocks unless explicitly authorized and targeted.
4. Require material changes to have citations and concise rationale. Route approval-required actions to a durable needs-human record instead of applying.
5. Use Task 3.4 for order and existing store confirmations for fields/comments. Record confirmed and incomplete effects in the turn result.
6. If current state invalidates reasoning assumptions, stop and return `re-evaluate`; do not patch the old plan heuristically.
7. Persist `pan-rationale` and `pan-reviewed-at` only for accepted decisions.

## Testing suggestions

- `node --test test/action-executor.test.js test/reasoning-service.test.js test/pan-store.test.js`
- Include leadership/assertion callback failure between validation and mutation.
- `npm test`

## Gotchas

- Valid protocol does not imply allowed authority.
- Never report a proposed action as applied without confirmation.
- Do not use `deriveTriage()` or `compareBacklogItems()` as fallback judgment.

## Verification checklist

- [ ] Live actions pass all deterministic safety checks.
- [ ] Stale/concurrent state causes re-evaluation.
- [ ] Rationale and audit correspond only to confirmed effects.
- [ ] Targeted tests and `npm test` pass.
