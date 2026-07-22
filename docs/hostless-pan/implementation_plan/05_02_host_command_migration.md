# Task 5.2: Host Command Migration

## Goal

Make `pan session` the primary experience, preserve useful one-shot workflows, and redirect or retire commands/options whose only purpose was a PAN host, bridge, or detached scheduler.

## Requirements addressed

REQ-MIG-1–10, REQ-EXP-9, REQ-REL-6

## Background

`src/pan-cli.js:346-513` currently parses `start`, `stop`, `host`, `connect`, `daemon`, `review`, `chat`, `inbox`, `answer`, and `add`. Hostless replacements now exist: `session`, evidence/action/leadership/reconcile/workstream/config/assets helpers, and `attention` commands.

This task changes user-facing command behavior but does not yet delete all underlying host files; Task 5.3 performs removal after command tests pass.

## Files to modify/create

- `src/pan-cli.js` — new command table, aliases, errors, and usage.
- `bin/pan.js` — preserve structured result/error output.
- `test/pan-cli.test.js` — parser and migration guidance.
- `test/pan-cli-integration.test.js` — replacement workflow composition.
- `README.md` and command docs — finalized in Task 5.4.

## Implementation details

1. Make `pan session --config <path>` the documented primary foreground experience.
2. Retain `pan review` as one-shot review. Dry-run needs no leadership; mutating mode acquires a bounded lease, applies through stateless action/reconciliation commands, and releases it.
3. Retain attention/task operations through `pan attention`; keep `inbox`, `answer`, and `add` as temporary aliases with deterministic deprecation guidance and equivalent JSON.
4. Retire `pan host`, `pan stop`, detached/background options, and domain-reasoning `pan daemon` with actionable guidance to exit/restart `pan session`.
5. Make `pan start` and `pan connect` either explicit transitional aliases to `pan session` or deterministic errors that name the replacement. They must never start/discover a host.
6. Retire `pan chat` in favor of the ordinary interactive session, or keep only a clearly one-shot compatibility path that invokes no host.
7. Update configuration restart guidance: session/domain/scheduling changes require exiting and rerunning `pan session`; runner changes require restarting only `pan-runner`.
8. Ignore old endpoint/token/state/log artifacts during command routing and diagnostics.

## Testing suggestions

- Verify every retired command produces actionable guidance and no host/bridge side effects.
- Verify aliases preserve expected JSON payloads where compatibility is promised.
- Verify one-shot mutation contends for the same leader record as `pan session`.

## Gotchas

- Do not silently retain old behavior behind familiar command names.
- `pan stop` cannot stop an ordinary Copilot session from another process; guidance should say to exit that session.
- Keep runner commands unchanged.

## Verification checklist

- [ ] `pan session` is the primary command and all help text reflects hostless behavior.
- [ ] Useful one-shot and attention workflows remain available.
- [ ] Host-only commands never launch/discover/connect to a host.
- [ ] Migration guidance is actionable and machine-readable where appropriate.
- [ ] Integration tests: `test/pan-cli.test.js`; `test/pan-cli-integration.test.js`.
