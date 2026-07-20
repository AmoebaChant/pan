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

The local PAN runtime will poll and synchronize one configured domain, schedule
PAN turns, host conversation, validate proposed actions, and maintain the
singleton lease. The runtime supplies private domain context and implements the
constrained tools; the agent definition remains reusable.

The runtime decides when PAN should think; PAN decides how the portfolio should
change. See [the target architecture](docs/architecture.md).

## Runner daemon

`pan-runner` currently loads a private machine capability profile, pulls
compatible ready work, claims it with a renewable lease, and launches a headed
Copilot CLI task in an isolated worktree. The target model evolves profiles into
shared domain playbooks plus local machine settings, allowing multiple matching
tasks to run concurrently without idle per-repository agents.

See the [runner contract and profile format](docs/runner.md).

## Triage and attention

`pan daemon` currently applies deterministic triage rules. It will evolve into
the PAN runtime: polling and synchronizing the domain, invoking the PAN agent for
portfolio reasoning, and applying validated changes to the canonical Project.
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
