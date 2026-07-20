# Task 1.5: PAN Agent Client

## Goal

Implement a dependency-free process client that invokes the generic PAN custom agent for one autonomous or interactive turn using the transport selected by the invocation spike.

## Requirements addressed

REQ-ADV-1, REQ-RUN-11, REQ-ACT-1, REQ-REL-4–5

## Background

Task 1.1 documented exact Copilot CLI arguments and structured transport. Task 1.2 added PAN protocol validators, and Task 1.4 added `.github/agents/pan.agent.md`. `ProcessClient` in `src/process-client.js` already handles timeouts, output bounds, and process-tree termination, while `src/task-worker.js` demonstrates credential stripping and Copilot process launch concerns. This client must not know domain policy or mutate GitHub.

## Files to modify/create

- `src/pan-agent-client.js` — `PanAgentClient` with `review()` and `chat()` turn methods.
- `test/pan-agent-client.test.js` — fake executable/transport success, tool exchange, malformed output, timeout, cancellation, and nonzero exit.
- `test/fixtures/fake-pan-agent.js` — deterministic local process fixture.
- `src/index.js` — export `PanAgentClient`.

## Implementation details

1. Accept executable, custom-agent name, model/options, timeout/output limits, working directory, environment, and a tool-message callback through constructor injection.
2. Build arguments exactly from the Task 1.1 spike rather than copying worker arguments.
3. Validate outgoing turn requests and incoming tool/final messages with `src/pan-protocol.js`.
4. Support multiple tool request/result exchanges within one turn and reject unknown tool names before callback execution.
5. Propagate AbortSignal cancellation and terminate the process tree using existing process utilities.
6. Strip delivery credentials unless explicitly required for the runtime-owned tool adapter; the Copilot child should not receive unnecessary GitHub or SSH secrets.
7. Return an error that includes turn ID, exit/transport state, and whether any tool side effects were confirmed.

## Testing suggestions

- `node --test test/pan-agent-client.test.js`
- Cover both review and chat through the same custom-agent option.
- `npm test`

## Gotchas

- Do not let raw model text bypass protocol validation.
- Do not retry a turn inside the client after a tool mutation; the runtime owns safe retry decisions.
- Keep live Copilot tests opt-in.

## Verification checklist

- [ ] Review and chat use one client and one agent identity.
- [ ] Structured tool exchanges are bounded and validated.
- [ ] Timeout/cancellation leaves no child process running.
- [ ] Targeted tests and `npm test` pass.
