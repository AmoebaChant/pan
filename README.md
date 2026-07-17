# PAN

PAN (Personal Agent Nexus) is a reusable orchestrator for a GitHub-backed
backlog of human and agent work.

This repository contains only the tool, schemas, and conventions. User-specific
workstreams, backlog items, runner profiles, leases, and credentials belong in
separate private data repositories.

## Status

The repository and initial store contract are established. The next walking
skeleton step is the Node schema module that reads and writes Issues and GitHub
Project fields through the `gh` CLI.

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
