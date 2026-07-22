# Task 4.4: Session Leadership Supervision

## Goal

Make the foreground launcher acquire and heartbeat writing leadership, fall back to read-only when unavailable, terminate safely on leadership loss, and release on exit.

## Requirements addressed

REQ-LEAD-1–12, REQ-EXP-8–9, REQ-REL-2–4

## Background

Task 4.3 launches the domain-rooted Copilot child. Task 1.3 exposes compatible leadership primitives. Existing `PanRuntime` and `PanHost` keep a `LeaderLease` instance in memory, but the hostless launcher must supervise only child lifetime and lease heartbeat; it exposes no domain-operation API or shared service container.

## Files to modify/create

- `src/pan-session.js` — writer/read-only acquisition and child supervision.
- `src/leader-lease.js` — session metadata support if not completed in Task 1.3.
- `src/process-tree.js` — precise child termination support on leadership loss.
- `src/pan-cli.js` — surface startup mode and exit diagnostics.
- `test/pan-session.test.js` — contention, heartbeat, loss, release, and signal cases.
- `test/process-tree.test.js` — child process termination regression coverage.

## Implementation details

1. Before launching Copilot, attempt one bounded leadership acquisition for a new session identity.
2. On success, launch in writing mode and pass the session ID/generation needed by mutating helpers. Start heartbeat at the configured cadence.
3. On a live/unverifiable competing leader, launch a fresh read-only session, clearly identify the mode, omit mutation authority from the environment, and create no schedule.
4. If heartbeat returns lost, contended, expired, or unverifiable while writing, stop the Copilot child before any further scheduled or interactive mutation can begin. Report restart/read-only guidance.
5. Handle Ctrl+C, termination, child exit, and launch failure by stopping heartbeat, then performing best-effort release for the same generation.
6. Preserve expiry-based recovery after abnormal launcher exit. Never edit Issues or Project data to recover leadership.
7. Keep runner task leases completely independent.
8. Do not expose a socket, health endpoint, shutdown endpoint, tool dispatch, or other service behavior.

## Testing suggestions

- Start two fake sessions against one state file and prove one writer/one read-only.
- Simulate successful heartbeats, token replacement, expiry, heartbeat exceptions, child launch failure, Ctrl+C, and child exit.
- Verify a stale session cannot release the replacement leader.

## Gotchas

- Read-only is a valid session mode, not a startup failure.
- Leadership loss must stop the writing child because its native schedule cannot be safely rewritten externally.
- Terminate only the known child process tree, never processes by name.

## Verification checklist

- [ ] Concurrent sessions confirm at most one writer.
- [ ] Read-only sessions receive no mutation generation and schedule nothing.
- [ ] Leadership loss ends the writing child and blocks later writes.
- [ ] Normal exit releases promptly; abnormal exit recovers by expiry.
- [ ] Integration tests: `test/pan-session.test.js`; `test/process-tree.test.js`.
