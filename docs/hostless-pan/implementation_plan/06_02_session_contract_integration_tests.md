# Task 6.2: Session Contract Integration Tests

## Goal

Verify the foreground hostless session contract: domain-rooted launch, user-scoped asset discovery, writer/read-only contention, heartbeat lifetime, leadership loss, native scheduling instructions, and exit cleanup.

## Requirements addressed

REQ-EXP-1–9, REQ-SCH-1–12, REQ-LEAD-1–12

## Background

Tasks 4.1–4.5 implement the user-scoped PAN assets and `pan session` supervisor. Existing `test/pan-launcher.test.js` and `test/copilot-invocation-contract.test.js` assert host/MCP arguments and must now validate ordinary Copilot behavior instead.

## Files to modify/create

- `test/pan-session-integration.test.js` — fake-child lifecycle and two-session tests.
- `test/copilot-invocation-contract.test.js` — hostless offline contract and opt-in live probe.
- `test/pan-launcher.test.js` — retain only non-duplicative launcher unit cases or remove.
- `test/fixtures/fake-copilot.js` — controllable foreground child.

## Implementation details

1. Launch a fake Copilot child and assert `cwd=domain.path`, explicit Pan agent selection, model/defaults, inherited IO, bounded environment, and no MCP arguments.
2. Verify current user-scoped assets are discovered and stale/conflicting assets block writing startup with repair guidance.
3. Run two concurrent sessions against one leader state: exactly one writer receives mutation generation and scheduling instructions; the other starts read-only.
4. Simulate heartbeats, child exit, Ctrl+C, termination, launcher failure, and leadership replacement. Verify release/expiry behavior and precise exit propagation.
5. Verify writing startup applies the configured native scheduling instructions once, read-only startup creates none, long cadence uses due checking, and session exit leaves no detached scheduler.
6. Verify leadership loss terminates the writing child and no later scheduled mutation process begins.
7. Keep an opt-in authenticated probe for a disposable private domain to select the installed Pan agent, invoke a helper through shell, run one native scheduled review, and confirm activity stops on exit.

## Testing suggestions

- Keep the default suite offline and deterministic.
- Gate the live probe with an environment variable and generous timeout.
- Inspect process arguments/files rather than relying only on child output text.

## Gotchas

- Do not revive repository-local agent/MCP fixture assumptions as product requirements.
- Read-only mode is expected under contention.
- Native schedule behavior must be tested as a session contract, not replaced by a test-only Node timer.

## Verification checklist

- [ ] Copilot launches in the domain root with user-scoped PAN assets and ordinary tools.
- [ ] Exactly one concurrent session is a writer.
- [ ] Scheduling belongs only to the writer and ends with the session.
- [ ] Leadership loss and process signals cleanly stop the child and lease.
- [ ] Integration tests: `test/pan-session-integration.test.js`; `test/copilot-invocation-contract.test.js`.
