# Task 4.3: Inferred Issue Creation

## Goal

Create one sourced Issue-backed Project item for an eligible inferred commitment and recover safely when Issue creation, Project registration, or field application is only partially complete.

## Requirements addressed

REQ-DATA-1–2, REQ-DATA-12, REQ-INF-3–9, REQ-REL-4

## Background

Tasks 4.1–4.2 validate provenance and duplicate/suppression status. `PanStore.createItem()` creates an Issue, adds it to the Project, sets fields, confirms visibility, and attempts rollback (`src/pan-store.js:156-247`). For inferred work, deleting an already-created Issue on every partial failure can erase durable source evidence; retry must rediscover the marker before creating another Issue.

## Files to modify/create

- `src/inferred-task-service.js` — validate eligibility, compose sourced body, create/recover/register.
- `src/pan-store.js` — lookup Issue by inferred marker and register an existing Issue in the Project.
- `src/action-executor.js` — route eligible inferred-Issue actions through the service.
- `test/inferred-task-service.test.js` — happy path, duplicate, closed suppression, Project-add failure, field failure, and retry recovery.
- `test/action-executor.test.js` and `test/pan-store.test.js` — integration.
- `src/index.js` — exports.

## Implementation details

1. Compose an Issue body containing human-readable source path/revision/date/action/rationale plus the compact versioned marker.
2. Re-run duplicate/suppression checks immediately before creation.
3. Create with `owner=unassigned` or PAN-proposed validated owner, `Status=untriaged`, normal priority unless evidence supports another value, manual autonomy unless explicitly justified, and the source workstream path.
4. If an Issue with the source marker already exists, repair Project membership/fields instead of creating another.
5. Report confirmed Issue URL/number, Project item ID, applied fields, and incomplete steps.
6. Add the new item to the same canonical Project; no inferred-work queue.
7. Do not silently delete/close an Issue after source changes.

## Testing suggestions

- `node --test test/inferred-task-service.test.js test/action-executor.test.js test/pan-store.test.js`
- Simulate failure after Issue creation and successful retry.
- `npm test`

## Gotchas

- Retry safety depends on writing the marker in the initial Issue creation.
- Do not auto-create low-confidence or unresolved duplicate candidates.
- Partial repair must preserve the original Issue.

## Verification checklist

- [ ] One eligible commitment creates exactly one sourced Issue.
- [ ] Retry repairs incomplete registration without duplication.
- [ ] Suppressed/ambiguous work is not created.
- [ ] Targeted tests and `npm test` pass.
