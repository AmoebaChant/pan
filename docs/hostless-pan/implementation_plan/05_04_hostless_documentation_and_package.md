# Task 5.4: Hostless Documentation and Package Surface

## Goal

Document the complete hostless workflow and align schemas, exports, package contents, setup, and migration guidance with the implemented product.

## Requirements addressed

REQ-TOOL-3, REQ-SCH-6, REQ-MIG-1–12, REQ-REL-7–9

## Background

The current `README.md:52-115` describes a local PAN host, MCP bridge, `pan start`, `pan connect`, `pan stop`, and daemon scheduling. `docs/domain-configuration.md` documents version 1 and host restarts. `docs/runner.md:129-132` says the PAN host completes merged PR work. Package exports in `src/index.js` and files in `package.json` include host-era surfaces.

All functional replacement and removal tasks should be complete before this documentation pass.

## Files to modify/create

- `README.md` — primary hostless quick start and architecture.
- `docs/domain-configuration.md` — version 2, migration, scheduling, product context, restart guidance.
- `docs/runner.md` — independent runner and delivery policies.
- `docs/triage-and-attention.md` — attention/reconciliation commands.
- `docs/architecture.md` — current implemented topology.
- `docs/schema-module.md` and `docs/store-schema.md` — new contracts where relevant.
- `schema/*.json` — descriptions/examples aligned with behavior.
- `src/index.js` — final public exports.
- `package.json` — final files/bin/package description.
- `test/package-surface.test.js` — package contents and no-private-data assertions.

## Implementation details

1. Document installation, `pan assets install/status/repair`, domain setup/config migration, `pan session`, writing/read-only modes, and session exit/restart behavior.
2. Document native schedule startup modes, cadence/retry bounds, no catch-up, no overlap, and manual fallback instructions.
3. Document every helper family with inputs, outputs, preconditions, side effects, result statuses, expected-state requirements, and safe recovery.
4. Explain complete Issue/Project evidence, deterministic reconciliation, action policy, and direct workstream delivery without a pull request.
5. Explain runner PR default versus explicit direct mode and its independence from PAN session leadership.
6. Remove host, endpoint, token, MCP, detached scheduler, and host-log instructions except clearly labeled migration notes.
7. Ensure package contents include user-scoped assets and schemas but no private domain data.
8. Keep examples generic and commands valid on supported Node.js 22 environments.

## Testing suggestions

- `test/package-surface.test.js` should inspect package files, bins, exports, asset manifest, and absence of removed host/MCP surfaces.
- Validate documented command names against `pan --help` output in CLI tests.
- Search docs/assets for private identities and obsolete restart guidance.

## Gotchas

- Do not imply a background PAN service continues after session exit.
- Do not conflate direct PAN workstream delivery with runner defaults.
- Documentation comments should describe intent, not duplicate mutable implementation logic.

## Verification checklist

- [ ] Quick start uses only setup/assets/session/runner commands.
- [ ] Configuration and scheduling docs match version 2 behavior.
- [ ] Every helper contract and recovery state is documented.
- [ ] Package exports/files/bins contain no obsolete runtime.
- [ ] Integration tests: `test/package-surface.test.js`; CLI help assertions.
