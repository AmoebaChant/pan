# Task 5.1: Runtime Event Scheduling

## Goal

Detect meaningful domain changes and time boundaries, coalesce related events, and decide when a full PAN portfolio review is due without embedding prioritization judgment.

## Requirements addressed

REQ-RUN-1–3, REQ-RUN-7–9

## Background

`PanDaemon.run()` currently polls on one cadence with idle/rate-limit backoff from `src/polling.js`. A reasoning turn is more expensive and should respond to new/changed tasks, comments/answers, source revisions, runner availability, and configured time boundaries while coalescing bursts. Task 1.3 defines separate cadences.

## Files to modify/create

- `src/runtime-scheduler.js` — event cursor, change detection, coalescing, and next-review calculation.
- `src/runtime-state.js` — versioned operational state stored through `GitHubStateFile`.
- `test/runtime-scheduler.test.js` — task/comment/workstream/runner/time changes, coalescing, idle, retry, and clock edges.
- `test/runtime-state.test.js` — expected-version contention and unknown version.
- `src/index.js` — exports.

## Implementation details

1. Define event categories for Project/Issue changes, answers/attention, workstream revisions, runner availability, manual order changes, full-review deadline, and retry after failure.
2. Store only cursors/hashes/timestamps needed to detect changes; do not store a task queue or duplicate portfolio.
3. Coalesce events arriving within the configured window into one review request while preserving urgent/full-review deadlines.
4. Use current `nextPollDelaySeconds()`, `isRateLimitError()`, and abortable waits where applicable, but expose all cadence inputs from domain config.
5. Make scheduler output deterministic: reason set, earliest due time, and whether full snapshot is required.
6. On transient failure, use bounded backoff with jitter injection for tests and no busy loop.

## Testing suggestions

- `node --test test/runtime-scheduler.test.js test/runtime-state.test.js test/polling.test.js`
- Use a fake clock; do not rely on real sleeps.
- `npm test`

## Gotchas

- The scheduler decides when to reason, not how to rank.
- Cursor state cannot override current GitHub state.
- Time-boundary reviews must still build a fresh complete snapshot.

## Verification checklist

- [ ] All required event sources can schedule a review.
- [ ] Bursts coalesce without losing urgent/time-boundary work.
- [ ] Operational state is not a shadow queue.
- [ ] Targeted tests and `npm test` pass.
