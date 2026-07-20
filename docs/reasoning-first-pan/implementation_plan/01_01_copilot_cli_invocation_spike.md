# Task 1.1: Copilot CLI Invocation Spike

## Goal

Prove and document the exact supported way for Node.js to invoke Copilot CLI for autonomous PAN reviews, interactive PAN chat, repository custom-agent selection, and a constrained structured tool channel before production runtime code depends on those mechanics.

## Requirements addressed

REQ-ADV-1, REQ-CONV-1, REQ-ACT-1, REQ-REL-5

## Background

PAN will use one logical custom agent for scheduled and interactive turns. The existing worker path in `src/task-worker.js:102-129` launches `copilot` with `-p`, `--autopilot`, broad tool enablement, and result files, but it does not prove interactive reuse, `.github/agents/*.agent.md` selection, or runtime-owned tools. This first task intentionally resolves those unknowns before `PanAgentClient` is designed.

## Files to modify/create

- `docs/reasoning-first-pan/spikes/copilot-cli-invocation.md` — record commands, observed behavior, chosen transport, limitations, and fallback.
- `test/fixtures/copilot-spike/.github/agents/pan.agent.md` — minimal generic test agent with no private values.
- `test/fixtures/copilot-spike/tools/` — smallest safe tool fixture required by the discovered CLI mechanism.
- `test/copilot-invocation-contract.test.js` — offline tests for the selected argument/transport contract; skip only checks that require an installed authenticated CLI.

## Implementation details

1. Inspect the installed `copilot` version and help for prompt/autopilot, interactive input, custom-agent selection, MCP/custom tools, JSON/event output, non-interactive behavior, and permission flags.
2. Run isolated fixture probes for: one autonomous prompt; one interactive follow-up preserving PAN identity; explicit selection of the fixture `pan` agent; one read-only structured tool request/result; malformed tool output; process cancellation.
3. Prefer a native structured tool/event channel if it can restrict PAN to named operations. Otherwise choose newline-delimited JSON over stdio between Node and a local tool adapter. Do not choose result files as the primary conversational channel.
4. Record exact executable arguments, stdin/stdout framing, exit semantics, custom-agent lookup rules, and whether autonomous and interactive modes require separate processes.
5. Define a stable local contract that production code can test without invoking Copilot. Keep live probes opt-in through an environment variable.
6. State the safe fallback explicitly: separate turn processes, the same agent definition and request schema, NDJSON tool messages, no unrestricted shell/GitHub/file tools.

## Testing suggestions

- `node --test test/copilot-invocation-contract.test.js`
- Run the opt-in live probe once with the installed Copilot CLI.
- `npm test`

## Gotchas

- Do not infer flags from `src/task-worker.js`; verify the installed CLI.
- Do not expose repository credentials or private domain data in fixtures or captured logs.
- Do not make the normal test suite require authentication, network access, or Copilot installation.

## Verification checklist

- [ ] Autonomous, interactive, custom-agent, and tool-channel behavior are each demonstrated or explicitly rejected.
- [ ] A production transport and fallback are documented with exact arguments and framing.
- [ ] Targeted tests pass without external services.
- [ ] `npm test` passes.
