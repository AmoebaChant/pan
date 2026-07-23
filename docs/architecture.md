# PAN architecture

PAN is a foreground Copilot session plus an independent runner. GitHub Issues
and one GitHub Project are the only work state.

```text
foreground pan session -- gh CLI --> GitHub Issues + Project
                                          ^
                                          | claim, lease, deliver
                                    pan-runner
```

## Pan session

`pan session` validates the configured domain and Project schema, then launches
the Pan agent in the domain checkout. The agent reads and writes Issues and
Project fields directly with `gh`. Skills provide workflow guidance; PAN does
not maintain portfolio snapshots, action documents, reconciliation state,
leadership leases, or a second queue.

The agent re-reads a target before mutation and verifies it afterward. This is
enough for PAN's single-user workflow while still protecting active runner
leases and detecting changed Issue state.

Native recurring reviews belong to the foreground Copilot session. Launch-local
due metadata prevents catch-up work but is not durable task state.

## Shared schema

[`schema/project-fields.json`](../schema/project-fields.json) is the contract
shared by setup, the Pan agent, and the runner. The agent sets triage fields:
owner, status, priority, requirements, autonomy, and workstream. The runner
claims eligible `owner=agent`, `status=ready` work and owns its active
`claimed-by` and `lease-until` fields.

## Runner

`pan-runner` polls GitHub independently, claims compatible ready work, and runs
headed Copilot workers in isolated worktrees. Runner leases are retained
because they coordinate actual concurrent workers; Pan session leadership is
not needed.
