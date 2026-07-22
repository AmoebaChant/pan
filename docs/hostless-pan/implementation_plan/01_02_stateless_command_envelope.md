# Task 1.2: Stateless Helper Command Envelope

## Goal

Define one strict CLI input/output contract for every short-lived PAN helper so callers can distinguish confirmed, rejected, incomplete, and failed operations without relying on a resident process.

## Requirements addressed

REQ-TOOL-2–4, REQ-REL-1–5, REQ-MIG-4–5

## Background

Hostless PAN invokes deterministic mechanics through ordinary shell commands. Existing structured statuses appear in `src/pan-protocol.js:20-25` and `PanToolRegistry.dispatch()` returns a smaller `{ operation, status }` shape at `src/pan-tools.js:86-107`, but host and MCP layers currently supply context and transport.

Task 1.1 adds normalized version 2 configuration. This task creates a service-independent operation envelope and CLI dispatcher that later evidence, leadership, action, attention, reconciliation, and workstream commands all reuse.

## Files to modify/create

- `schema/pan-command-result.json` — public result envelope schema.
- `src/pan-command-result.js` — validation, normalization, and error mapping.
- `src/pan-command-context.js` — load config and construct one bounded operation context per process.
- `src/pan-cli.js` — add strict nested-command dispatch and shared `--json` handling.
- `src/index.js` — export command contract helpers.
- `test/pan-command-result.test.js` — envelope validation tests.
- `test/pan-cli.test.js` — unknown command/argument and exit behavior.

## Implementation details

1. Define required fields for status, operation name, operation ID, domain identity, confirmed effects, remaining required steps, diagnostics, and safe recovery. Allow optional snapshot and expected-state identities where relevant.
2. Preserve readability of existing attention, runner, and action result records; do not mutate durable GitHub records to adopt the new envelope.
3. Map validation/policy rejection to `rejected`, missing or partial evidence/effects to `incomplete`, dependency failures before side effects to `failed`, and confirmed requested outcomes to `confirmed`.
4. Ensure thrown errors can carry a validated result so `bin/pan.js` prints useful machine-readable output while still returning a non-zero exit code for failed, rejected, or incomplete mutating commands.
5. Add a command-context factory that loads configuration, validates domain identity, and constructs fresh GitHub/store dependencies for exactly one invocation. It must not cache authoritative state across calls.
6. Make nested command parsing reject unknown operations, schema versions, flags, duplicate options, and positional arguments before invoking any operation handler.
7. Keep human-readable formatting separate from the machine contract; `--json` must always emit exactly one parseable result object.

## Testing suggestions

- Test every status and required-field combination in `test/pan-command-result.test.js`.
- In `test/pan-cli.test.js`, prove unknown commands and arguments never call injected handlers.
- Verify incomplete results preserve both confirmed effects and remaining steps.

## Gotchas

- A result is not `confirmed` merely because the process exited normally.
- Do not collapse partial external effects into an exception message.
- Avoid adding an in-memory registry that recreates host-owned shared state.

## Verification checklist

- [ ] All helper families can return the same validated envelope.
- [ ] Unknown inputs fail before side effects.
- [ ] Partial effects remain machine-readable and produce a failing command status.
- [ ] Every invocation constructs fresh bounded dependencies.
- [ ] Integration tests: `test/pan-command-result.test.js`; `test/pan-cli.test.js`.
