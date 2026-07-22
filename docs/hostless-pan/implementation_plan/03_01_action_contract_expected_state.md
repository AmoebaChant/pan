# Task 3.1: Action Contract and Expected State

## Goal

Extend the action protocol to describe resource-specific optimistic concurrency, action-group semantics, workstream updates, and truthful partial-effect results.

## Requirements addressed

REQ-SAFE-1, REQ-SAFE-11–15, REQ-TOOL-3–4, REQ-MIG-4–5

## Background

`schema/pan-action.json` and `validatePanAction()` in `src/pan-protocol.js:51-87` currently require one snapshot ID plus action-specific target fields. `PanReviewService.#apply()` at `src/pan-review-service.js:200-294` applies at most one mutation and has no explicit independent/all-or-none action-group contract.

Tasks 1.2 and 2.2 provide the result envelope and resource-specific snapshot references. This task updates schemas and validators only; live application follows in Task 3.2.

## Files to modify/create

- `schema/pan-action.json` — add version 2 actions and groups.
- `schema/pan-command-result.json` — align effect records with action/group IDs.
- `src/pan-protocol.js` — validate/normalize new contracts and read legacy version 1.
- `test/pan-protocol.test.js` — action, expected-state, and group validation.
- `.github/agents/pan.agent.md` — update later in Task 4.1, not in this task.

## Implementation details

1. Add resource-specific expected-state fields for Project item/field value, complete order and membership, Issue catalog revision, Issue identity/state, workstream blob/base revision, attention record, and leadership generation.
2. Add a workstream-update action kind that references a prepared operation, intended workstream path, expected blob/base, rationale, and idempotency marker.
3. Define action-group semantics as independent or all-or-none. Reject all-or-none groups up front when the requested external operations cannot be implemented transactionally.
4. Require every material mutation to include evidence, rationale, idempotency, domain target, and the expected states relevant to its resources.
5. Keep version 1 action and structured result records readable for migration/diagnostics. Do not allow an old snapshot/action combination to authorize completeness-sensitive hostless mutation.
6. Define confirmed and incomplete effect records that identify the action/group, resource, external identity, confirmed state, remaining steps, and recovery guidance.
7. Reject unknown action kinds, fields, versions, and unsupported group combinations before side effects.

## Testing suggestions

- Extend `test/pan-protocol.test.js` with every new expected-state shape and invalid cross-resource combinations.
- Verify version 1 normalization remains readable but is marked insufficient for hostless live apply.
- Verify unsupported all-or-none groups fail validation.

## Gotchas

- A global snapshot ID does not replace resource-specific expected state.
- Do not promise atomicity GitHub and git cannot provide.
- Keep schemas data-neutral; no domain names or local paths belong in examples.

## Verification checklist

- [ ] Every mutation names all mutable resources it depends on.
- [ ] Workstream updates are representable in the action protocol.
- [ ] Independent and unsupported all-or-none groups are distinguished.
- [ ] Legacy records remain readable without gaining new authority.
- [ ] Integration tests: `test/pan-protocol.test.js`.
