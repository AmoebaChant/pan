# Task 7.1: Reasoning End-to-end Tests

## Goal

Add deterministic system-level tests that exercise complete review, dry-run, live application, manual ordering, inferred commitments, and chat through the real composition boundaries without external GitHub or Copilot services.

## Requirements addressed

REQ-DOM-1–7, REQ-REA-1–11, REQ-ORD-1–9, REQ-INF-1–9, REQ-CONV-1–13

## Background

Phases 1–5 introduced domain config, fake-agent transport, complete snapshots, constrained tools, reasoning/application, order audit, inferred tasks, runtime, and conversation. Unit tests cover modules, but the release needs a vertical proof that the same canonical state is visible in dry-run, applied Project order, rationale, and chat.

## Files to modify/create

- `test/reasoning-e2e.test.js` — system scenarios using a stateful fake GitHub adapter and fake Pan agent process.
- `test/fixtures/reasoning-domain/` — generic domain workstreams/config fixtures with no private content.
- `test/helpers/fake-github-domain.js` — Project/Issue/comment/state-branch behavior shared only by system tests.

## Implementation details

1. Compose the production CLI/runtime factories with fake `GhClient` behavior and the Task 1.5 fake agent process.
2. Cover: complete dry-run classification; applied reorder/rationale; concurrent manual drag causing re-evaluation; preserved relative constraint with urgent insertion; high-confidence inferred Issue; repeat review dedup; closed inferred suppression; ambiguous commitment question; chat “why”; chat field/order/answer action.
3. Assert GitHub Project order is the only queue state and all user-visible explanations cite fixture records.
4. Assert no mutation occurs when a Project item/comment/workstream read is incomplete.
5. Assert attention/add/answer remain available when the fake agent fails.
6. Keep fixture outputs stable and generic.

## Testing suggestions

- `node --test test/reasoning-e2e.test.js`
- Run the full suite after the targeted system test.
- `npm test`

## Gotchas

- Do not replace focused unit tests with one oversized scenario.
- The fake GitHub adapter must preserve concurrency/version behavior, not merely return canned success.
- Do not require network, authentication, or installed Copilot.

## Verification checklist

- [ ] Dry-run, apply, runtime, and chat share one canonical state.
- [ ] Manual constraints and inferred-task safety work end to end.
- [ ] Incomplete evidence fails closed.
- [ ] Targeted tests and `npm test` pass.
