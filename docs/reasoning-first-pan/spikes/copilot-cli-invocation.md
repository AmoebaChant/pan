# Copilot CLI invocation spike

## Decision

PAN will execute every autonomous review and chat message as a bounded Copilot
CLI prompt-mode process. Conversation is preserved by assigning the first turn a
session UUID and resuming that UUID for later turns. PAN will not automate the
interactive terminal UI or keep a Copilot process alive between messages.

The runtime-owned tool channel is a repository-local stdio MCP server. Copilot
receives only explicitly named PAN tools through `--available-tools`, and those
tools are pre-approved with `--allow-tool`. Copilot's JSON output is consumed as
newline-delimited events; result files are not the conversational transport.

This was verified with GitHub Copilot CLI 1.0.72 on Windows on 2026-07-20.

## Exact invocation

The first turn uses:

```text
copilot
  -C <domain-or-runtime-working-directory>
  -p <request-json-and-turn-prompt>
  --agent pan
  --no-ask-user
  --disable-builtin-mcps
  --no-remote
  --no-auto-update
  --disallow-temp-dir
  --available-tools=pan-tools-read_portfolio
  --allow-tool=pan-tools(read_portfolio)
  --output-format json
  --stream off
  --session-id <uuid>
```

Later conversational turns replace `--session-id <uuid>` with:

```text
--resume=<uuid>
```

The process receives no conversational stdin. The request is supplied with
`-p`, stdout is JSONL, stderr is diagnostic output, and a final `result` event
contains `sessionId`, `exitCode`, and usage. A successful observed turn returned
process exit code 0 and a final event whose `exitCode` was 0.

`--autopilot` is intentionally omitted. Prompt mode is already non-interactive
and bounded. In 1.0.72, filtering tools during autopilot also filters its
internal `task_complete` tool unless its internal name is added, while the CLI
then reports that name as unknown. Prompt mode avoids depending on that unstable
detail.

## Custom-agent lookup

The fixture at
`test/fixtures/copilot-spike/.github/agents/pan.agent.md` was discovered as a
project agent when Copilot ran with `-C test/fixtures/copilot-spike`. Selecting
it with `--agent pan` loaded its instructions and produced the marker
`PAN_SPIKE_AGENT`.

Production must use the same repository-local path and pass `--agent pan` on
both new and resumed processes. Resuming a session does preserve conversation:
a second process resumed the test UUID and correctly recalled the exact response
from the first process.

## Structured tool channel

The selected native channel is a local MCP stdio server configured by
`.github/mcp.json`:

```json
{
  "mcpServers": {
    "pan-tools": {
      "type": "stdio",
      "command": "node",
      "args": ["<runtime-tool-adapter>"],
      "env": { "PAN_MCP_SERVER": "1" },
      "tools": ["read_portfolio"]
    }
  }
}
```

MCP requests and responses are newline-delimited JSON-RPC on the adapter's stdin
and stdout. The fixture proves `initialize`, `tools/list`, and `tools/call`.
Adapter stdout is protocol-only; diagnostics must go to stderr.

Copilot uses two different names for one MCP tool:

- `--available-tools=pan-tools-read_portfolio` controls model visibility.
- `--allow-tool=pan-tools(read_portfolio)` grants non-interactive permission.

The live fixture tool returned only synthetic structured data. Copilot invoked
it and reported `Synthetic PAN project`. A deliberately malformed `tools/call`
result was rejected as an unsuccessful tool execution with an MCP schema error;
the Copilot process still completed normally and could explain the rejection.
The runtime must therefore treat unsuccessful tool events as failed operations
and must not infer that a mutation occurred.

`--disable-builtin-mcps` disables the built-in GitHub server, not every
user-configured plugin server. `--available-tools` still prevented all but the
named fixture operation from being exposed to the model. Production should also
run with a controlled Copilot configuration and explicitly disable any
non-PAN MCP servers known to that environment.

## Event framing

With `--output-format json --stream off`, stdout contains one complete JSON
object per line. Relevant observed event types were:

- `assistant.message`, including tool requests and final response text
- `tool.execution_start`
- `tool.execution_complete`, including `success` and an error on failure
- `session.error`
- final `result`

Consumers must parse each line independently, ignore unknown event types, retain
the `sessionId`, fail a turn on a nonzero process/result exit code or a terminal
session error, and separately validate every requested action result.

## Cancellation and lifecycle

Each turn has its own child process and wall-clock deadline. Cancellation
terminates the process tree rather than closing stdin. The cancellation probe
ended the interactive process with no numeric exit code and `SIGTERM`; callers
must accept signal termination as cancellation rather than a successful turn.
The existing PAN process-tree helper is the appropriate production mechanism on
Windows.

The terminal interactive mode (`-i`) was rejected as the service transport. It
uses a human-oriented terminal UI, has no documented NDJSON stdin request
framing, and complicates deadlines and recovery. PAN chat remains interactive
at the application level through repeated `-p`/`--resume` processes.

## Offline contract and live probe

`test/copilot-invocation-contract.test.js` fixes the selected arguments, custom
agent location, MCP configuration, safe structured response, malformed
response, and stdio framing without requiring Copilot, authentication, or
network access.

The authenticated live check is opt-in:

```powershell
$env:PAN_LIVE_COPILOT_SPIKE = "1"
node --test test\copilot-invocation-contract.test.js
```

## Fallback

If session resume or native MCP behavior changes, PAN will keep separate bounded
turn processes and the same `pan` agent and request schema, but include the
required prior conversation summary in each prompt. Runtime tools will move
behind a local NDJSON stdio adapter with explicit request IDs, operation names,
validated arguments, and validated results. The fallback exposes no unrestricted
shell, GitHub, or file tools and never uses result files as the primary chat
channel.
