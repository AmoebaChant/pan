# Task 4.5: Native Schedule Bootstrap

## Goal

Use Copilot's supported session-scoped scheduling to establish bounded, non-overlapping PAN portfolio reviews only in the active writing session.

## Requirements addressed

REQ-SCH-1–12, REQ-EXP-5, REQ-EVD-13

## Background

Task 4.4 identifies writing versus read-only sessions and supervises their lifetime. Hostless PAN must not recreate scheduling with Node timers, detached processes, or host-owned queues. The architecture selects Copilot's supported `/every` and `/after` or equivalent native contract, with a manual fallback if automated bootstrap is unsupported.

## Files to modify/create

- `assets/copilot/instructions/pan.instructions.md` — startup and recurring schedule behavior.
- `assets/copilot/skills/pan-portfolio/SKILL.md` — scheduled review workflow and due check.
- `src/copilot-contract.js` — supported version/scheduling capability preflight.
- `src/pan-session.js` — pass startup instructions and writing/read-only mode.
- `src/session-due-state.js` — bounded launch-local due metadata for long cadences.
- `test/copilot-invocation-contract.test.js` — offline scheduling contract.
- `test/pan-session.test.js` — writer/read-only bootstrap behavior.

## Implementation details

1. Isolate supported Copilot schedule creation/list/removal semantics behind a versioned contract. Do not depend on keystroke injection or private session files.
2. For writing sessions, provide explicit startup instructions that establish the configured recurring review and apply `immediate`, `after-interval`, or `manual` startup policy at most once.
3. For read-only sessions, instruct and verify that no autonomous review schedule is created.
4. Scheduled prompts must enter the same session queue as interactive turns and invoke the same Pan agent and helper commands.
5. Every scheduled review begins with a fresh due check/reconciliation/evidence read. It must not use conversation memory as authorization.
6. When configured cadence exceeds Copilot's maximum native interval, schedule at the supported maximum and use launch-local due metadata to decide whether the full review interval elapsed.
7. Missed reviews while no session runs are not replayed. New launches follow startup policy instead.
8. Failures, rejection, and incomplete evidence must be visible in the session. Retries follow bounded general/rate-limit guidance and remain idempotent.
9. If automatic schedule bootstrap is unsupported, fail writing startup with an actionable manual command rather than silently running unscheduled.

## Testing suggestions

- Offline contract tests should assert supported launch instructions, recurring/startup semantics, no schedule in read-only mode, and no catch-up state.
- Simulate delayed scheduled prompts during another turn and verify the workflow refreshes evidence when actually run.
- Verify session exit leaves no PAN-owned detached scheduler.

## Gotchas

- The launcher may supervise a lease, but it must not own review timers.
- Launch-local due metadata is not a durable task queue.
- Do not claim non-overlap from custom locks when Copilot's session queue is the mechanism.

## Verification checklist

- [ ] Only writing sessions establish native review scheduling.
- [ ] Startup policy runs at most once per launch and never catches up missed reviews.
- [ ] Scheduled turns refresh reconciliation and evidence before decisions.
- [ ] Session exit ends all reviews from that session.
- [ ] Integration tests: `test/copilot-invocation-contract.test.js`; `test/pan-session.test.js`.
