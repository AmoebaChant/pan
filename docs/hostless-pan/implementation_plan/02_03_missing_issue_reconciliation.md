# Task 2.3: Missing Issue Reconciliation

## Goal

Detect eligible open domain Issues missing from the Project and add those existing Issues exactly once with deterministic initial fields and truthful recovery receipts.

## Requirements addressed

REQ-REC-1–7, REQ-SAFE-3, REQ-SAFE-11–15

## Background

`PanStore.syncOpenIssues()` at `src/pan-store.js:452-489` currently compares one bounded open-Issue list to Project URLs and adds missing entries without a structured receipt or deterministic field initialization. Task 2.1 provides complete Issue evidence, Task 2.2 provides complete Project membership and expected-state identities, and Task 1.3 provides leadership assertions.

Reconciliation is deterministic maintenance and runs before model-selected portfolio mutations. A read-only session reports needed changes but does not apply them.

## Files to modify/create

- `src/reconciliation-service.js` — missing-Issue planning and application.
- `src/pan-store.js` — membership lookup and idempotent add/field confirmation primitives.
- `src/pan-cli.js` — add `pan reconcile missing-issues [--apply]`.
- `test/reconciliation-service.test.js` — plan/apply/retry/partial-effect cases.
- `test/pan-store.test.js` — membership and confirmation primitives.

## Implementation details

1. Build a reconciliation plan only from a complete Issue catalog and complete Project membership snapshot.
2. Select open Issues eligible for backlog tracking; exclude closed Issues, pull requests, foreign repositories, unsupported records, and any domain-policy exclusions.
3. Before each addition, revalidate leadership, Issue identity/state, expected catalog revision, and current Project absence.
4. Add the existing Issue URL. Never create a replacement Issue.
5. Apply required initial fields deterministically and confirm both membership and fields.
6. If membership succeeds but field setup fails, preserve the Project item and Issue identity. Return confirmed effects and remaining steps so retry repairs the same item.
7. Make retries idempotent when the Issue is already present or partially initialized.
8. In dry-run/read-only mode, return the exact planned additions and blockers without side effects.

## Testing suggestions

- Test unchanged missing Issues, already-present Issues, closed Issues, PR records, and concurrent membership changes.
- Interrupt after Project addition and after individual field writes; retry must continue the same item.
- Test leadership loss before addition and between membership and field application.

## Gotchas

- Do not use `createItem()` for reconciliation.
- Do not delete the Project item to simulate transaction rollback after an externally visible addition.
- Rebuild evidence after confirmed effects before later portfolio mutation.

## Verification checklist

- [ ] Eligible open Issues missing from the Project are detected from complete evidence.
- [ ] Apply adds the original Issue exactly once.
- [ ] Required fields are deterministic and confirmed.
- [ ] Partial effects preserve identity and are safely retryable.
- [ ] Integration tests: `test/reconciliation-service.test.js`; relevant `test/pan-store.test.js` cases.
