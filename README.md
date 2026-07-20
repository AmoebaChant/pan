# PAN

PAN (Personal Agent Nexus) is a reusable orchestrator for a GitHub-backed
backlog of human and agent work.

This repository contains only the tool, schemas, and conventions. User-specific
workstreams, backlog items, runner profiles, leases, and credentials belong in
separate private data repositories.

## Status

The repository, store contract, shared Node schema module, and local runner
daemon are established.

## Store model

- Workstream narrative lives at `workstreams/<path>/README.md` in a private data
  repository.
- Backlog items are Issues in that data repository.
- A private GitHub Project supplies lifecycle, routing, priority, and lease
  fields.
- The Project's `workstream` text field joins an Issue to its full workstream
  path.

See [the store contract](docs/store-schema.md) and its
[machine-readable field manifest](schema/project-fields.json).

## Node module

The package exports:

- `GhClient`, a safe subprocess wrapper around the authenticated `gh` CLI.
- `PanStore`, with helpers to create Issue-backed items, set Project fields,
  list by filter, and claim, heartbeat, or release leases.

The implementation has no runtime dependencies and requires Node 22 or newer.
See the [schema module contract](docs/schema-module.md) for API usage.

## Runner daemon

`pan-runner` loads a private machine capability profile, pulls compatible ready
work, claims it with a renewable lease, and launches a headed Copilot CLI task
in an isolated worktree. The runner owns branch push and pull-request creation,
reports needs-human locators, and always hands completed work off as
`in-review`.

See the [runner contract and profile format](docs/runner.md).

```powershell
npm test
```
