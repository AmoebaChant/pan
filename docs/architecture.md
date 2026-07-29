# Pan architecture

Pan is a foreground Copilot session plus an independent runner. GitHub Issues
and one GitHub Project are the only work state. See [goals](goals.md) for what
this structure is meant to achieve and [open questions](open-questions.md) for
what it does not yet settle.

```text
foreground pan session -- gh CLI --> GitHub Issues + Project
                                          ^
                                          | claim, lease, deliver
                                    pan-runner
```

## Pan session

`pan session` validates the configured domain and Project schema, then launches
the Pan agent in the domain checkout. The agent reads and writes Issues and
Project fields directly with `gh`. Skills provide workflow guidance. Pan keeps
no portfolio snapshot, no cached state, and no second queue.

The agent re-reads a target before mutation and verifies it afterward. This is
enough for Pan's single-user workflow while still protecting active runner
leases and detecting changed Issue state.

Native recurring reviews belong to the foreground Copilot session. Launch-local
due metadata prevents catch-up work but is not durable task state.

Nothing runs once the session exits. That is a current limitation rather than a
target design, and it bounds how proactive Pan can be; see
[open questions](open-questions.md).

## Product context and self-repair

A session may be given read-only product-context roots. They are reference
material and grant no authority to modify the repositories they point at.

The Pan tool repository is the one exception. When Pan's own durable guidance is
insufficient to finish a task, Pan may repair that guidance in the Pan
repository under its normal branch-and-review policy, then resume. Self-repair
never bypasses the configured domain boundary, live-state re-reads, user
approval, or runner-owned execution fields.

## Shared schema

[`schema/project-fields.json`](../schema/project-fields.json) is the contract
shared by setup, the Pan agent, and the runner. The agent sets triage fields:
owner, status, priority, requirements, and workstream. The runner
claims eligible `owner=agent`, `status=ready` work and owns its active
`claimed-by` and `lease-until` fields. A worker that needs an answer sets
`needs-human-since` and waits in its own terminal without giving up its lease.

The [store contract](store-schema.md) describes those fields in detail, and
[module and schemas](schema-module.md) covers the `@amoebachant/pan` package
surface.

## Runner

`pan-runner` polls GitHub independently, claims compatible ready work, and runs
headed Copilot workers as its playbooks specify. Leases coordinate concurrent
workers operating on the same domain.
