# PAN runtime and attention

The current PAN daemon keeps a private GitHub Issue backlog ready for humans and
runners through deterministic triage rules. It is the walking-skeleton precursor
to the PAN runtime described in [the target architecture](architecture.md).

The target runtime polls and synchronizes one domain repository, invokes the PAN
custom agent for complete portfolio reasoning, hosts conversation, and applies
validated changes directly to the canonical GitHub Project.

## Configuration

PAN commands load the private domain configuration described in
[PAN domain configuration](domain-configuration.md).

```powershell
$env:PAN_CONFIG = "C:\path\to\domain-config.json"
```

The configuration supplies the repository, Project, local domain-repository
path, runtime cadence, and state namespace without requiring machine, terminal,
repository checkout, or runner capability settings. Pass `--config <path>` to
override the environment variable.

`--profile` and `PAN_PROFILE` remain available as deprecated compatibility
inputs and emit a warning. Do not provide them together with `--config` or
`PAN_CONFIG`. `pan-runner` remains independently profile-based.

## Current triage daemon

```powershell
pan daemon
pan daemon --once
```

Only the instance holding the renewable lease on the domain repository's
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

The fixed triage and ordering policy is transitional. In the target design,
deterministic code continues to validate lifecycle transitions and leases, but
the PAN agent reasons about owner, requirements, commitments, and Project
ordering using all actionable tasks and relevant workstream narrative.

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

## Target conversation

The target `pan chat` interface attaches to the same PAN personality and domain
context used for scheduled planning. It reads and changes the same GitHub
Project exposed by the UI, so there is no separate conversational queue.

PAN can explain ordering, accept relative-order overrides, add or reschedule
work, answer worker questions, and promote durable conversational outcomes into
Issues, Project fields, or workstream markdown.

### Interactive mutation envelope

`read_portfolio` returns a short first result block before the complete
portfolio. Its `snapshotReference` is always available even if the complete
portfolio is truncated:

```json
{
  "snapshotReference": {
    "field": "actions[].expectedState.snapshotId",
    "value": "sha256:<64 lowercase hexadecimal characters>",
    "usableForMutation": true
  }
}
```

Every mutation action passed to `propose_actions`, including `issue-create`,
must copy that exact `snapshotReference.value` into
`expectedState.snapshotId`. All mutation actions in one call must reference the
same snapshot. A validated task-creation request is:

```json
{
  "actions": [
    {
      "version": 1,
      "actionId": "create-task-unique-id",
      "kind": "issue-create",
      "rationale": "Why the cited evidence should become durable work.",
      "confidence": 0.95,
      "evidence": [
        {
          "kind": "workstream",
          "locator": "workstream/path"
        }
      ],
      "idempotencyKey": "stable-key-for-this-task",
      "expectedState": {
        "snapshotId": "sha256:<exact value from read_portfolio>"
      },
      "target": {
        "repository": "owner/domain-repository",
        "title": "Task title",
        "body": "Task details and acceptance criteria",
        "workstream": "workstream/path"
      }
    }
  ]
}
```

All actions require protocol `version`, an `actionId`, supported `kind`,
material `rationale`, `confidence` from 0 through 1, and at least one durable
evidence citation. Mutations additionally require an `idempotencyKey`,
`expectedState`, and kind-specific `target`; `no-op` uses `recommendation`
instead. PAN rejects missing, mismatched, unknown, or stale snapshot references
without applying any mutation.
