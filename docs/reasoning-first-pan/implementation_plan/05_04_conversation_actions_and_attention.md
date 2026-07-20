# Task 5.4: Conversation Actions and Attention

## Goal

Allow chat to explain and safely change the canonical queue, task fields, relative precedence, schedules, new work, and pending answers while preserving existing attention behavior and promoting every durable outcome.

## Requirements addressed

REQ-ACT-9–10, REQ-CONV-2–13, REQ-REL-6

## Background

`AttentionService` already lists unresolved attention/in-review work, answers by item ID/Issue URL, and creates untriaged Issue-backed tasks. Task 5.3 adds chat; Task 3.6 provides the common action executor; Task 3.5 provides explicit relative-constraint replacement. Chat must call these services rather than creating alternate conversational state.

## Files to modify/create

- `src/conversation-service.js` — map validated chat actions to existing services/executor.
- `src/attention-service.js` — expose reusable find/answer/add operations and durable result details without weakening current behavior.
- `src/action-policy.js` — explicit-user-directive authority handling.
- `test/conversation-service.test.js` — why-order, field change, relative precedence, add, answer, reschedule/question, and stale state.
- `test/attention-service.test.js` — compatibility and no-pending-answer error.

## Implementation details

1. Answer “why” from current rationale and cited evidence; if rationale is stale, say so and offer/re-run review rather than inventing.
2. Route add and answer through `AttentionService`; preserve JSON-compatible result details and durable marked comments.
3. Treat explicit user directives for workstream, owner, priority, autonomy, requirements, and relative precedence as durable inputs subject to schema/domain/lifecycle validation.
4. Implement reschedule as a validated durable field/comment representation chosen by the existing Project schema; if no scheduling field exists, record a sourced Issue comment and trigger reconsideration rather than adding a hidden local value.
5. For approval-required actions, create one needs-human record and deduplicate it across repeated turns.
6. Re-read state before applying and return clear rejected/stale explanations.
7. Preserve inbox locators, in-review entries, and errors when no unresolved attention exists.

## Testing suggestions

- `node --test test/conversation-service.test.js test/attention-service.test.js test/pan-cli-integration.test.js`
- Cover a concurrent Project drag between user request and apply.
- `npm test`

## Gotchas

- A chat acknowledgment is not durable completion.
- Do not overwrite active worker state because the user changed unrelated priority.
- Do not duplicate needs-human questions on retry.

## Verification checklist

- [ ] Chat reads/changes the same canonical Project and attention records.
- [ ] Explicit directives are durable and validated.
- [ ] Existing inbox/add/answer behavior remains compatible.
- [ ] Targeted tests and `npm test` pass.
