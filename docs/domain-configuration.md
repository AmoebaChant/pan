# PAN domain configuration

A PAN domain configuration connects one PAN runtime to one GitHub repository
and one Project. It contains no runner capability, machine, worktree, terminal,
or credential settings.

## Example

```json
{
  "version": 1,
  "domain": {
    "repository": "example/personal-domain",
    "projectOwner": "example",
    "projectNumber": 12,
    "path": "C:\\domains\\personal-domain"
  },
  "state": {
    "branch": "pan-state",
    "path": ".pan"
  },
  "agent": {
    "name": "pan",
    "model": "gpt-5.6-sol"
  }
}
```

`domain.path` must be the absolute path to the local clone of the configured
domain repository. The config file itself may be stored elsewhere.

The normalized defaults are:

| Setting | Default |
|---|---:|
| Active poll | 30 seconds |
| Idle poll | 300 seconds |
| Full portfolio review | 86,400 seconds |
| Leader lease | 120 seconds |
| Leader heartbeat | 30 seconds |
| Notification cadence | 300 seconds |
| General retry | 60 seconds |
| Rate-limit retry | 900 seconds |
| Transcript retention | 30 days |

`agent.model` selects the Copilot model deterministically for autonomous
reviews and is also the default for `pan connect`. If it is omitted, Copilot
uses `auto`. `pan connect --model <id>` overrides it for one interactive
session, and `/model` displays the active selection.

`agent.turnTimeoutSeconds` and `agent.maxAiCredits` are optional safeguards.
When omitted, PAN does not pass a turn timeout or AI-credit cap to Copilot.

State and transcripts are confined to the repository-relative `state.path`
namespace. With the example above, the normalized leader file is
`.pan/leader.json` and the default transcript path is `.pan/transcripts`.
Absolute paths, backslashes, empty segments, and `..` segments are rejected for
repository state paths.

## Optional higher-risk review

Higher-risk review is disabled by default. Enabling it requires an explicit list
of action kinds:

```json
{
  "reviewPolicy": {
    "higherRisk": {
      "enabled": true,
      "actionKinds": [
        "issue-create",
        "canonical-reorder"
      ]
    }
  }
}
```

This setting identifies actions for later review policy. It does not itself
grant authority or make an action automatic.

## Optional self-repair tasks

Self-repair is disabled by default. When enabled, an unexpected scheduled-review
failure creates a deduplicated Issue in the domain repository with the failure
evidence and routes it to a coding runner:

```json
{
  "selfRepair": {
    "enabled": true,
    "repository": "example/pan",
    "workstream": "pan",
    "requirements": [
      "env:local",
      "tool:node22",
      "task:self-repair"
    ]
  }
}
```

PAN automatically adds `repo:<repository>` and `delivery:pull-request` to the
task requirements. The runner profile must provide a dedicated compatible
playbook whose delivery mode is `pull-request`. An open task with the same
failure fingerprint is reused, preventing one broken review from creating an
Issue every polling cycle. Repair-task creation failures are logged but do not
trigger another repair task.

The coding task must investigate whether the failure is a reusable PAN defect or
invalid domain data. It must preserve fail-closed mutation behavior and open a
pull request for review; PAN does not merge the repair automatically.

## Migration from a runner profile

Copy only the domain identity from the runner profile's `store` object:

| Runner profile | Domain config |
|---|---|
| `store.repository` | `domain.repository` |
| `store.projectOwner` | `domain.projectOwner` |
| `store.projectNumber` | `domain.projectNumber` |
| `store.path` | `domain.path` |

Then add `state.branch`, `state.path`, and `agent.name`.

Keep `machine`, `capabilities`, `repositories`, `workspaceRoot`,
`stateDirectory`, `terminal`, capacity, task budgets, and runner Copilot
settings in the runner profile. `loadDomainConfig()` rejects those fields
rather than inferring or combining configurations. Authentication continues to
come from the execution environment and must not be stored in either public
schema.
