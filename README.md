# PAN

PAN (Personal Agent Nexus) is a reusable personal chief-of-staff agent for a
GitHub-backed domain of human and agent work. It reasons across tasks and
workstream narrative, maintains the canonical Project queue, delegates
compatible execution, and explains its decisions.

This repository contains only generic agents, runtime behavior, tools, schemas,
protocols, and conventions. User-specific workstreams, backlog items, machine
settings, runner state, leases, and credentials belong outside it.

## Status

The walking skeleton includes the shared store, local runner, singleton
rule-based daemon, and attention CLI. The target architecture adds the PAN
custom agent, complete portfolio reasoning, canonical Project ordering,
conversation, and playbook-based runner matching.

See [PAN's goals](docs/goals.md) and the
[target architecture](docs/architecture.md).

## Domain model

One PAN instance connects to one private **domain repository**. Repository names
are arbitrary. Separate domains have independent PAN instances and do not
silently share knowledge.

- Workstream narrative lives at `workstreams/<path>/README.md` in a private
  domain repository.
- Backlog items are Issues in that domain repository.
- A private GitHub Project supplies lifecycle, routing, priority, and lease
  fields.
- The Project's `workstream` text field joins an Issue to its full workstream
  path.
- Project ordering is the canonical human and agent queue. PAN updates that
  ordering directly; it does not maintain a separate generated queue.

See [the store contract](docs/store-schema.md) and its
[machine-readable field manifest](schema/project-fields.json).

## Node module

The package exports:

- `GhClient`, a safe subprocess wrapper around the authenticated `gh` CLI.
- `PanStore`, with helpers to create Issue-backed items, set Project fields,
  list by filter, and claim, heartbeat, or release leases.

The implementation has no runtime dependencies and requires Node 22 or newer.
See the [schema module contract](docs/schema-module.md) for API usage.

## PAN agent and target runtime

The package ships a generic `.github/agents/pan.agent.md` custom-agent definition
for both autonomous portfolio reviews and interactive conversation. It defines
PAN's reusable personality, complete-portfolio reasoning standards, authority
boundaries, versioned output expectations, and named PAN-only tools without
embedding domain or machine values.

The local PAN runtime polls and synchronizes one configured domain, schedules
PAN turns, hosts conversation, validates proposed actions, and maintains the
singleton lease. The runtime supplies private domain context; the agent
definition remains reusable.

The runtime decides when PAN should think; PAN decides how the portfolio should
change. See [the target architecture](docs/architecture.md).

```powershell
pan start --config C:\path\to\domain-config.json
pan stop --config C:\path\to\domain-config.json
pan review --config C:\path\to\domain-config.json
pan review --apply --config C:\path\to\domain-config.json
pan chat "What should I work on next?" --config C:\path\to\domain-config.json
pan daemon --config C:\path\to\domain-config.json
```

`start` launches a localhost-only PAN host in the background and opens a headed
Windows Terminal tab running a persistent Copilot session with the PAN agent.
The terminal reads live domain evidence and submits proposed actions through the
host's authenticated MCP bridge. Autonomous scheduled reviews are dry-run by
default; add `--apply` to `start` to let scheduled reviews apply validated
changes. Interactive proposals are always validated by the host before any
effect. Use `stop` to release the domain leader lease and stop the background
host.

`review` is a dry run unless `--apply` is present. `chat` applies validated
proposals by default; add `--dry-run` for advice only. Reviews, conversation,
and the daemon use the same generic PAN agent and complete domain snapshot.

## Runner daemon

`pan-runner` loads a private machine profile containing reusable playbooks,
pulls compatible ready work, claims it with a renewable lease, and launches a
headed Copilot CLI task in an isolated worktree. Global and per-playbook
capacity allow independent task classes to run concurrently without sharing
branches or consuming each other's reserved playbook slots.

See the [runner contract and profile format](docs/runner.md).

## Triage and attention

With domain configuration, `pan daemon` is the reasoning runtime: it polls and
synchronizes the domain, invokes PAN, and applies validated changes to the
canonical Project. Legacy runner-profile mode retains deterministic triage for
compatibility.
`pan inbox`, `pan answer`, and `pan add` provide the human attention surface.

PAN commands use an independent domain configuration. Pass
`--config <path>` or set `PAN_CONFIG`. `pan-runner` continues to use its machine
runner profile independently.

```powershell
$env:PAN_CONFIG = "C:\path\to\domain-config.json"
pan daemon --once
pan inbox
pan answer 42 "Use the existing API."
pan add "Implement the feature" --body "Acceptance criteria..." `
  --workstream orchestration/pan --repo example/tool
```

`--profile` and `PAN_PROFILE` remain as deprecated PAN-command compatibility
options during migration. Do not combine domain configuration and runner profile
inputs.

See [PAN triage and attention](docs/triage-and-attention.md).

```powershell
npm test
```
