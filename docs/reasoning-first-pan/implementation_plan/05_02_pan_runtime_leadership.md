# Task 5.2: PAN Runtime Leadership

## Goal

Implement the continuous and one-cycle PAN runtime that schedules reasoning, maintains the domain leader lease, prevents post-lease-loss mutations, retries safely, and shuts down cleanly.

## Requirements addressed

REQ-RUN-3–6, REQ-RUN-9–11, REQ-REL-4–6

## Background

`PanDaemon` already acquires `LeaderLease`, starts a heartbeat guard, polls, backs off, and releases on shutdown (`src/pan-daemon.js:47-144`, `src/pan-daemon.js:410-445`). Task 5.1 adds scheduling; Task 3.6 adds live reasoning application. The new `PanRuntime` should reuse these foundations rather than rewriting lease semantics.

## Files to modify/create

- `src/pan-runtime.js` — `runOnce()` and `run()` orchestration.
- `src/pan-daemon.js` — compatibility wrapper/delegation path while deterministic mode remains.
- `test/pan-runtime.test.js` — leadership contention/loss, scheduled review, rate limit, failed turn, shutdown, and release.
- `test/pan-daemon.test.js` — compatibility behavior.
- `src/index.js` — exports.

## Implementation details

1. Compose scheduler, snapshot builder, reasoning service, action executor, leader lease, logger, clock, and sleep through injection.
2. Acquire leadership before mutation-capable synchronization/review; dry observation may continue only if it cannot imply successful review.
3. Pass an `assertLeader` callback into every mutation boundary. Leadership loss during the agent turn invalidates all subsequent application until a fresh snapshot under leadership.
4. Record failed autonomous turns as visible runtime state/diagnostics and schedule bounded retry; never update review time on failure.
5. Preserve one-cycle operation for `pan daemon --once`/future `pan review`.
6. On shutdown, stop scheduling, cancel in-flight agent work, prevent new mutations, stop heartbeat, and release leadership best effort.
7. Keep attention/store commands available outside runtime failure.

## Testing suggestions

- `node --test test/pan-runtime.test.js test/pan-daemon.test.js test/leader-lease.test.js`
- Simulate lease loss after snapshot and after agent response.
- `npm test`

## Gotchas

- A completed model response is unusable after leadership loss.
- Do not release another holder's lease.
- Do not represent failed reasoning as an idle successful poll.

## Verification checklist

- [ ] Only the leader applies domain mutations.
- [ ] Lease loss blocks all remaining turn effects.
- [ ] Continuous and once modes shut down cleanly.
- [ ] Targeted tests and `npm test` pass.
