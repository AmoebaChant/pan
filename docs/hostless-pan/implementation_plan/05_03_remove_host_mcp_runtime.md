# Task 5.3: Remove Host and MCP Runtime

## Goal

Delete resident coordination, localhost bridge, detached scheduling, and separate prompt-process code after all retained behavior is available through hostless session and stateless helpers.

## Requirements addressed

REQ-EXP-2–4, REQ-TOOL-8, REQ-MIG-7–10

## Background

Tasks 1–5.2 establish replacements for configuration, evidence, reconciliation, actions, attention, workstreams, session leadership, scheduling, and command migration. The obsolete code is currently exported from `src/index.js` and referenced by tests:

- `src/pan-host.js`
- `src/pan-mcp-server.js`
- `bin/pan-mcp.js`
- host-oriented sections of `src/pan-launcher.js`
- `src/pan-agent-client.js`
- `src/pan-runtime.js`
- domain-reasoning/timer responsibilities in `src/pan-daemon.js`

## Files to modify/create

- Delete the obsolete files listed above when no retained caller remains.
- `src/pan-cli.js` — remove factories/imports and unreachable composition.
- `src/index.js` — remove obsolete exports.
- `package.json` — remove obsolete packaged/bin artifacts.
- Delete or rewrite `test/pan-host.test.js`, `test/pan-mcp-server.test.js`, `test/pan-agent-client.test.js`, `test/pan-runtime.test.js`, and `test/pan-daemon.test.js`.
- `src/pan-launcher.js` — retain only hostless session compatibility if still needed.

## Implementation details

1. Remove localhost HTTP listening, authorization, health/shutdown endpoints, token handling, state/readiness files, MCP proxy dispatch, generated MCP configuration, and detached start/stop orchestration.
2. Remove host-owned snapshot caches, periodic review timers, repair scheduling, and separate autonomous/chat prompt processes.
3. Preserve reusable deterministic libraries moved behind commands: store, snapshot, policy, reconciliation, workstream, attention, leadership, configuration, runner, and result contracts.
4. Remove environment variables and runtime paths used only by the MCP/host bridge.
5. Remove agent instructions/tests that assume only bridge-contributed tools.
6. Keep compatible leader record data so older hosts still contend during migration, but do not retain code to launch or connect to one.
7. Search the package for obsolete symbols and user-facing terms, then remove dead imports and tests.

## Testing suggestions

- Run focused CLI/session/helper tests after each deletion.
- Add assertions that package exports and bins contain no host/MCP runtime.
- Search for `PanHost`, `pan-mcp`, endpoint/token state, `startPan`, `connectPan`, and host log references.

## Gotchas

- Do not delete `LeaderLease`, `PanStore`, attention, runner, or deterministic reconciliation just because hosts used them.
- Ensure opt-in Copilot contract tests no longer require repository-local MCP fixtures for product behavior.
- Old local artifacts may remain on disk but must be ignored.

## Verification checklist

- [ ] No shipped command starts/listens/connects to a PAN host or MCP server.
- [ ] Obsolete exports, bin entries, environment variables, and tests are removed.
- [ ] Retained helper and runner behavior remains available.
- [ ] Older durable leader records remain safely interpretable.
- [ ] Integration tests: rewritten CLI/session/helper suites; package export/bin assertions.
