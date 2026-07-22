# Runner daemon

The runner is a pull-based local worker. It reads its current capability profile,
claims compatible ready Issues with a lease, and runs each task in an isolated
git worktree. It is a lightweight non-AI process; no Copilot session waits idle
in each repository.

The private runner profile combines machine settings with reusable playbooks.
Machine-wide and per-playbook capacity are independent limits: a launch needs a
free global slot and a free slot in its selected playbook.

## Capability profile

Profiles live at `runners/<machine>.json` in the private domain repository. The
public schema is [`schema/runner-profile.json`](../schema/runner-profile.json).
Capabilities are exact strings, and every configured repository must have a
matching `repo:<owner/name>` capability.

```json
{
  "version": 1,
  "id": "machine-a",
  "machine": "machine-a",
  "online": true,
  "maxConcurrentDaemons": 1,
  "capabilities": [
    "env:local",
    "os:windows",
    "tool:copilot-cli",
    "repo:example/tool"
  ],
  "playbooks": [
    {
      "id": "tool-development",
      "capacity": 2,
      "capabilities": [
        "env:local",
        "os:windows",
        "tool:copilot-cli",
        "repo:example/tool"
      ],
      "repositories": [
        "example/tool"
      ],
      "delivery": "pull-request",
      "instructions": [
        "Inspect repository guidance before editing.",
        "Implement the complete task and run relevant existing validation."
      ]
    }
  ],
  "store": {
    "repository": "example/private-data",
    "projectOwner": "example",
    "projectNumber": 1
  },
  "repositories": {
    "example/tool": {
      "path": "C:\\path\\to\\tool",
      "defaultBranch": "main"
    }
  },
  "workspaceRoot": "C:\\path\\to\\pan-worktrees",
  "stateDirectory": "C:\\path\\to\\pan-state",
  "githubAssignee": "example",
  "terminal": {
    "type": "windows-terminal",
    "executable": "wt",
    "window": "0",
    "profile": "PowerShell"
  },
  "copilot": {
    "executable": "copilot",
    "model": "gpt-5.6-sol",
    "approvalMode": "prompt"
  }
}
```

Playbook capacity, clone paths, worktree roots, machine names, and terminal
settings are private machine configuration. Commit them only to the private
domain repository, never to this public package. Profiles without `playbooks`
remain supported as one compatibility playbook using the global capacity.
`copilot.approvalMode` defaults to `prompt`, which leaves tool approval with the
interactive Copilot session. Set it to `allow-all` only as an explicit opt-in.
`delivery` defaults to `pull-request`. Set it to `direct` only for repositories
where the worker is explicitly authorized to integrate and push completed work
to the configured default branch without human review.

Self-repair tasks include the `delivery:pull-request` requirement. Reserve a
dedicated playbook with that capability and `delivery: "pull-request"` so
ordinary direct-delivery playbooks cannot claim repair work. A capacity of one
keeps repairs serialized; reserve an additional machine-wide slot if repairs
must start while normal playbooks are full.

When the profile is loaded from `runners/<machine>.json`, the domain repository
path is inferred from the profile location. `store.path` can override it when a
profile is stored elsewhere.

Validate a profile without polling:

```powershell
node .\bin\pan-runner.js --profile C:\path\to\runner.json --validate-profile
```

## Task lifecycle

The runner selects `owner=agent`, `Status=ready`, claimable items in canonical
Project order. A task must match every requirement and repository declared by
an enabled playbook with free capacity. `manual` items are not started.
For each task it:

1. claims the Project item and starts a renewable lease;
2. creates a non-default task branch in a dedicated worktree;
3. opens a visible Windows Terminal tab running Copilot CLI with the Issue, its
   comments and answers, and workstream README as the initial interactive
   prompt;
4. appends an `Agent started` or `Agent resumed` Issue comment containing the
   machine, runner, playbook, branch, worktree, and terminal title;
5. lets the worker complete the playbook delivery policy, including committing,
   integrating the latest default branch, resolving conflicts, rerunning affected
   checks, and either pushing directly or creating a pull request;
6. validates the reported remote commit or pull request before updating Project
   state and cleaning the worktree.

`pull-request` delivery leaves the Issue open and moves the item to `in-review`;
the PAN host moves it to `done` and closes the Issue after the linked PR merges.
`direct` delivery moves the item to `done` and closes the Issue after the runner
confirms the reported commit is reachable from the default branch.

The worker may use `git` and `gh` only for the target repository and
playbook-selected delivery. The runner retains deterministic ownership of leases,
delivery validation, Project transitions, and cleanup.
Machine-wide concurrency, per-playbook concurrency, and lease limits come from
the profile. Tasks using another playbook do not consume the selected
playbook's slots. `copilot.model` selects the coding model deterministically.

`taskBudget.wallClockMinutes` and `taskBudget.maxAiCredits` are optional
safeguards. Omitting them removes PAN's wall-clock and AI-credit caps.
`taskBudget.maxAutopilotContinues` remains accepted for compatibility with
existing profiles but is not applied because runner tasks now start in
interactive mode instead of autopilot.

`pan setup` creates an offline starter profile with no service repositories.
An offline profile may keep `repositories` empty while it is being configured;
an online profile must configure at least one repository.

Run one polling cycle and wait for its selected tasks:

```powershell
node .\bin\pan-runner.js --profile C:\path\to\runner.json --once
```

Omit `--once` to keep polling until the process receives `SIGINT` or `SIGTERM`.
The configured interval is used while work is active. Idle polling backs off to
five minutes, and GitHub rate-limit failures pause polling for fifteen minutes.
The foreground runner prints normal lifecycle activity and tees it to
`<stateDirectory>\runner.log`; each visible worker terminal also writes worker
lifecycle details to `copilot.log` under its task state directory. Copilot
remains attached directly to that terminal so its interactive chrome and
steering controls are available, including `/model` and session commands. The
configured model is shown in the worker's visible startup line and lifecycle
log. PAN does not redirect or consume Copilot's stdin; the terminal remains
usable for follow-up instructions until Copilot exits. The configured terminal
`profile` defaults to `PowerShell`. `Ctrl+C` stops active workers before
releasing their leases. Interrupted tasks retain their worktree and explicit
Copilot session ID, return directly to `ready` without creating a needs-human
request, and resume that saved session when a runner claims them again. A lost
lease also stops its worker immediately to prevent duplicate execution.
Resumable items remain affiliated with the machine and playbook holding their
local state. On startup, the runner also returns legacy unclaimed `blocked`
items to `ready` when their latest unresolved PAN request is specifically a
`Runner failure: Runner stopped` message; those older tasks restart without
session history because previous runner versions did not save a session ID.

When `pan answer` resolves blocked work, PAN returns the item to triage. The
next runner attempt receives the marked answer comment in its task context.

## Bootstrap a task manually

During bootstrap, put one compatible task in `ready` with `owner=agent`, then
run one cycle:

```powershell
node .\bin\pan-runner.js --profile C:\path\to\runner.json --once
```

The worker receives the canonical Issue body, comments and answers, workstream
README, target branch/worktree, and playbook instructions. It implements,
validates, commits, integrates, and delivers the change. The runner independently
owns the lease, creates the collision-resistant isolated worktree, records
append-only lifecycle comments on the Issue, validates the reported delivery,
and applies Project transitions. Operational stops return the task to `ready`
with resumable local state; only genuine blocking questions use human attention.
