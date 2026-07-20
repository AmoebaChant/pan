# PAN triage and attention

The PAN daemon keeps a private GitHub Issue backlog ready for humans and
runners. It is a local process, while its leader lease and all backlog state
remain in the private data repository.

## Configuration

Commands load the same private runner profile used by `pan-runner`.

```powershell
$env:PAN_PROFILE = "C:\path\to\data\runners\machine-a.json"
```

The profile supplies the repository, Project, local data-repository path, poll
interval, and machine identity. Pass `--profile <path>` to override the
environment variable.

## Triage daemon

```powershell
pan daemon
pan daemon --once
```

Only the instance holding the renewable lease on the data repository's
`pan-state` branch performs a poll. Each poll:

1. adds open repository Issues that are missing from the Project;
2. derives routing fields from existing Project values, the Issue body, and
   marked PAN answers;
3. requests missing details or blocks agent work that no online runner profile
   can service;
4. returns PAN-created capability blocks to `ready` when a runner appears; and
5. orders Project items by priority and lifecycle.

PAN preserves `in-progress`, `in-review`, and `done` items. It also preserves
blocks created by runners or humans.

When no lifecycle state changes, polling backs off to five minutes. A GitHub
rate-limit failure pauses polling for fifteen minutes before retrying. Project
board reads use 20-item GraphQL pages and are bounded to 100 items so idle
polling has predictable cost; PAN fails explicitly if a board outgrows that MVP
limit.

### Triage directives

An Issue body or `pan answer` can include explicit directives:

```text
workstream: orchestration/pan
owner: agent
priority: high
autonomy: full-auto
repo:example/tool
env:local
```

Capability requirements use `kind:value` tokens. Agent work requires exactly
one `repo:<owner/name>` requirement, a workstream, and a task description.
Repository requirements imply agent ownership when `owner` is unassigned;
other work defaults to human ownership.

## Attention commands

```powershell
pan inbox
pan inbox --json
```

The inbox contains unresolved `needs-human` records and every `in-review`
item. It includes Issue URLs, pull-request links, and machine, terminal, or
local-URL locators when available.

```powershell
pan answer 42 "Use option A."
pan answer https://github.com/example/data/issues/42 "Use option A."
```

Answers are marked Issue comments. Blocked and `needs-detail` items return to
`untriaged`, allowing PAN to apply answer directives and make the next runner
attempt see the response.

```powershell
pan add "Implement the feature" `
  --body "Acceptance criteria..." `
  --workstream orchestration/pan `
  --repo example/tool `
  --requirement env:local `
  --priority high `
  --owner agent `
  --autonomy full-auto
```

`--body-file` can replace `--body`; `--repo` and `--requirement` are
repeatable. New items start as `untriaged` so the daemon can validate and
enrich them. Add `--json` for machine-readable output.
