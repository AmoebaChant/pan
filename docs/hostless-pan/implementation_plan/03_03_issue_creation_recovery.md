# Task 3.3: Sourced Issue Creation and Recovery

## Goal

Create explicit or high-confidence sourced tasks without semantic/source duplicates, preserving Issue identity across incomplete Project registration and retry.

## Requirements addressed

REQ-REC-10–15, REQ-EVD-4–6, REQ-REL-3–5

## Background

`PanReviewService.#applyAction()` at `src/pan-review-service.js:334-375` uses an idempotency marker and can recover an existing open Issue into the Project. However, `PanStore.createItem()` at `src/pan-store.js:203-268` deletes a newly created Issue when Project setup fails, and duplicate checks currently rely on markers plus current Project titles.

Tasks 2.1–2.3 provide a complete Issue catalog and deterministic Project registration. Task 3.2 provides leadership-aware action application.

## Files to modify/create

- `src/issue-creation-service.js` — candidate validation, duplicate checks, creation, and repair.
- `src/action-service.js` — route `issue-create` through the new service.
- `src/pan-store.js` — split Issue creation from Project registration; remove destructive cleanup from this path.
- `test/issue-creation-service.test.js` — duplicate, partial-effect, and retry coverage.
- `test/pan-review-service.test.js` — retain only compatibility behavior until removal.

## Implementation details

1. Require complete open and closed Issue evidence before automatic creation.
2. Check stable source identity/idempotency markers and semantic duplicates across the full catalog, not just current Project items.
3. Require durable evidence location, interpreted action, relevant date/revision, and specific rationale. Reject ambiguous or low-confidence candidates as recommendations/questions.
4. Create the Issue first with a stable marker. Confirm and record its identity before attempting Project registration.
5. Register that exact Issue through the Task 2.3 reconciliation path and deterministically initialize fields.
6. If Project addition or fields fail, return the confirmed Issue identity and remaining steps. Never delete the Issue and never create a second Issue on retry.
7. If a matching sourced Issue is closed or explicitly rejected, report suppression and do not reopen or recreate it from unchanged evidence.
8. Source narrative changes must not silently close or delete an existing Issue.

## Testing suggestions

- Cover stable-marker duplicate, semantic duplicate, closed/rejected suppression, ambiguous candidate, and changed source revision.
- Interrupt after Issue creation, Project addition, and field initialization; retries must converge on one Issue.
- Verify leadership loss stops later steps while preserving confirmed identity.

## Gotchas

- Project absence does not mean the Issue was never created.
- Do not reopen closed inferred work automatically.
- Semantic duplicate checks require complete evidence; fail closed when the catalog is partial.

## Verification checklist

- [ ] Complete open/closed evidence gates task creation.
- [ ] Stable source identity and semantic duplicates prevent recreation.
- [ ] Partial registration preserves one confirmed Issue for retry.
- [ ] Closed/rejected work is suppressed without reopening.
- [ ] Integration tests: `test/issue-creation-service.test.js`.
