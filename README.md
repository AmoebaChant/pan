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

Start with the setup wizard:

```powershell
pan setup
```

It creates a private domain repository and GitHub Project, clones and bootstraps
the repository, writes `pan.json` with the absolute clone path, and creates an
offline runner profile. Copilot tool approval defaults to `prompt`; selecting
`allow-all` is an explicit opt-in recorded in that private runner profile.

```powershell
# Terminal 1: visible host and activity log
pan start --config C:\path\to\domain-config.json

# Terminal 2: visible coding runner and activity log
pan-runner --profile C:\path\to\runner.json

# Terminal 3: attached interactive Copilot session
pan connect --config C:\path\to\domain-config.json

pan stop --config C:\path\to\domain-config.json
pan review --config C:\path\to\domain-config.json
pan review --apply --config C:\path\to\domain-config.json
pan chat "What should I work on next?" --config C:\path\to\domain-config.json
pan daemon --config C:\path\to\domain-config.json
```

`start` runs the localhost-only PAN host in the current terminal and tees
timestamped activity to its runtime `host.log`. Press `Ctrl+C` to release
leadership and stop it. `connect` starts Copilot in the current terminal with
the PAN agent and authenticated MCP bridge. The configured `agent.model` is
passed explicitly; `--model <id>` overrides it for that interactive session,
and `/model` shows or changes the active model.

Autonomous scheduled reviews are dry-run by default; add `--apply` to `start`
to let them apply validated changes. The previous detached experience remains
available through `start --background`, but foreground services are the
recommended transparent workflow.

An optional self-repair policy can turn unexpected scheduled-review failures
into deduplicated ready tasks for a dedicated pull-request runner playbook. PAN
keeps the original failure visible, does not retry a failing repair queue
recursively, and never merges the resulting pull request automatically.

`review` is a dry run unless `--apply` is present. `chat` applies validated
proposals by default; add `--dry-run` for advice only. Reviews, conversation,
and the daemon use the same generic PAN agent and complete domain snapshot.

## Runner daemon

`pan-runner` loads a private machine profile containing reusable playbooks,
pulls compatible ready work, claims it with a renewable lease, and launches a
headed Copilot CLI task in an isolated worktree. Global and per-playbook
capacity allow independent task classes to run concurrently without sharing
branches or consuming each other's reserved playbook slots.
It remains attached to its terminal, logs claims, capacity, heartbeats,
worktree launches, results, and delivery handoffs, and tees the same output to
`<stateDirectory>\runner.log`. Each coding worker opens in a visible Windows
Terminal tab with interactive Copilot chrome and steering, and keeps lifecycle
details in its own `copilot.log`. Pressing `Ctrl+C` stops active workers before
the runner releases their leases. The Issue comments form an append-only
execution journal with start/resume locators, operational stops, questions,
answers, and validated delivery results.

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
