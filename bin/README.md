# Pan programs

Node 22+, ESM, built-ins only. GitHub access uses `gh` with argv arrays rather
than shell command strings.

## Everyday task UI

Public fixture mode:

```sh
node bin/pan-tasks.js --demo
```

Live GitHub mode:

```sh
node bin/pan-tasks.js \
  --config /absolute/path/to/machine.json \
  --checkout /absolute/path/to/pan
```

Live mode requires both bindings and listens on `127.0.0.1:4320`; demo defaults
to `127.0.0.1:4321`. Use `--port` to override. The service validates canonical
Project schema, fully pages Project data, constrains Issues to the configured
Domain plus `taskBacklogRepos`, and performs no write during startup or GET.

Browser code has no credentials. Writes require exact loopback Host/Origin,
JSON content type, bounded bodies, allowed repository, expected task revision,
and safe worker/resource state. Stale or partial operations return errors; the
service never substitutes fixture or success-shaped fallback data.

The UI provides Today, Needs me, In motion, Recent activity, and All tasks;
capture/edit, priority/workstream/schedule/deadline, exact action,
authorization/dependencies, hold/handoff/defer/finish/reject, recurrence
rollover, details/history/artifacts, and honest worker-terminal instructions.
Daily commitment approval remains in the Daily Briefing flow.

See [`system/briefing-ui.md`](../system/briefing-ui.md) and
[`system/task-lifecycle.md`](../system/task-lifecycle.md).

## Todoist import and recovery

```sh
node bin/pan-todoist-migrate.js snapshot --output /private/path/snapshot.json
node bin/pan-todoist-migrate.js plan \
  --snapshot /private/path/snapshot.json \
  --config /absolute/path/to/machine.json \
  --checkout /absolute/path/to/pan
node bin/pan-todoist-migrate.js apply \
  --snapshot /private/path/snapshot.json \
  --config /absolute/path/to/machine.json \
  --checkout /absolute/path/to/pan \
  --confirm-import
node bin/pan-todoist-migrate.js verify ...
node bin/pan-todoist-migrate.js recovery-plan \
  --config /absolute/path/to/machine.json \
  --checkout /absolute/path/to/pan
```

The Todoist token comes from `TODOIST_API_TOKEN` by default; choose another
environment variable with `--todoist-token-env`. Snapshot/report files can
contain private task data and must stay outside this public repository.

The importer fully pages active tasks/projects/sections/labels/comments,
excludes tasks assigned to another authenticated user, preserves source ids and
metadata, never deletes originals/history, and is idempotent by durable Issue
markers. Independent failures produce a nonzero partial report and are repaired
by rerunning. Current Project state is never overwritten from a stale migration
baseline. See
[`system/todoist-migration.md`](../system/todoist-migration.md).

## Additive lifecycle migration

```sh
node bin/pan-lifecycle-migrate.js plan \
  --config /absolute/path/to/machine.json \
  --checkout /absolute/path/to/pan
node bin/pan-lifecycle-migrate.js apply \
  --config /absolute/path/to/machine.json \
  --checkout /absolute/path/to/pan \
  --confirm-runners-stopped
```

Plan translates the current live legacy pilot state and flags every legacy
`in-progress` item as `requires-cutover-hold`; a stale lease is not workspace
release evidence. Apply is idempotent, re-reads every item, preserves
legacy owner/options for rollback, refuses changed/live items, and verifies new
revision/action state. The tool is provided for a reviewed operational cutover;
starting it is not authorization to stop runners or mutate a live Domain.

## Daily Briefing MCP service

```sh
node bin/pan-briefing-mcp.js [--host 127.0.0.1] [--port 4318]
node bin/pan-briefing-mcp.js --demo [--port 4319]
```

The MCP transport uses stdin/stdout. The review URL and errors use stderr.
Fixture mode starts no MCP protocol and touches no live task system. See
[`system/briefing-ui.md`](../system/briefing-ui.md).

## Runner

```sh
node bin/pan-runner.js --config /absolute/path/to/config.json [--once] [--validate-config]
```

The runner selects only canonical `ready-for-ai/execute` tasks with
`execution-authorized=yes`, empty dependencies, no recurrence, a matching
enabled playbook, capacity, and safe resources. It orders by priority then
Project order; no date gates or sorts AI execution.

Claims mint a `claim-generation`, change outcome to `ai-executing`, maintain
separate worker liveness, increment task revision last, and confirm the complete
tuple before launch. Human checkpoints can remain live or release execution
capacity under an allowed durable checkpoint. Crash pause preserves outcome and
workspace affinity. Human checkpoints and deliberate holds never auto-resume.

### Config additions

Alongside the existing Domain, machine, terminal, permission, state/workspace,
lease, and capacity fields:

| Field | Meaning |
| --- | --- |
| `humanAttentionBackpressure` | `{ "softLimit": 5, "mode": "off" \| "prefer-autonomous" }`. At the soft limit, `prefer-autonomous` skips only new `may-request` playbooks. |
| `taskBacklogRepos` | Optional `owner/repository` allowlist additions for the everyday UI. |

Playbook front matter supports:

```yaml
capacity: 1
humanAttention: may-request # autonomous | may-request
checkpointRelease: forbidden # allowed | forbidden
workingDirectory: null
```

`autonomous` affects only attention backpressure; it never bypasses a real gate.
`checkpointRelease=allowed` permits `safeToRelease=true` only after the worker
has made its state durable.

The durable launch lock, immutable generations, PID/process-start ownership,
result receipts, legacy adoption, rehydration, workspace slots, and operator
recovery remain defined in [`system/runner.md`](../system/runner.md).
