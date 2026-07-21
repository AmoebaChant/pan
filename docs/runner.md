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
    "window": "0"
  },
  "copilot": {
    "executable": "copilot",
    "model": "gpt-5.6-sol"
  }
}
```

Playbook capacity, clone paths, worktree roots, machine names, and terminal
settings are private machine configuration. Commit them only to the private
domain repository, never to this public package. Profiles without `playbooks`
remain supported as one compatibility playbook using the global capacity.

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
   comments and answers, and workstream README as context;
4. posts structured needs-human records, including the machine, terminal title,
   and optional local URL;
5. commits any remaining changes, pushes only the task branch, opens a pull
   request, and moves the item to `in-review`.

The worker denies Copilot access to `git push`, GitHub CLI commands, and the
built-in GitHub MCP. The runner alone owns push and pull-request creation.
Machine-wide concurrency, per-playbook concurrency, and lease limits come from
the profile. Tasks using another playbook do not consume the selected
playbook's slots. `copilot.model` selects the coding model deterministically.

`taskBudget.wallClockMinutes`, `taskBudget.maxAiCredits`, and
`taskBudget.maxAutopilotContinues` are optional safeguards. Omitting the first
two removes PAN's wall-clock and AI-credit caps. Copilot CLI requires a finite
autopilot continuation count, so PAN uses a high default of 1,000 for unattended
tasks when no explicit value is configured.

Run one polling cycle and wait for its selected tasks:

```powershell
node .\bin\pan-runner.js --profile C:\path\to\runner.json --once
```

Omit `--once` to keep polling until the process receives `SIGINT` or `SIGTERM`.
The configured interval is used while work is active. Idle polling backs off to
five minutes, and GitHub rate-limit failures pause polling for fifteen minutes.
The foreground runner prints normal lifecycle activity and tees it to
`<stateDirectory>\runner.log`; each visible worker terminal also writes
`copilot.log` under its task state directory. `Ctrl+C` stops active workers
before releasing their leases; interrupted tasks move to `blocked` with their
local locator so partial work is not silently discarded. A lost lease also
stops its worker immediately to prevent duplicate execution.

When `pan answer` resolves blocked work, PAN returns the item to triage. The
next runner attempt receives the marked answer comment in its task context.

## Bootstrap a task manually

During bootstrap, put one compatible task in `ready` with `owner=agent`, then
run one cycle:

```powershell
node .\bin\pan-runner.js --profile C:\path\to\runner.json --once
```

The worker receives the canonical Issue body, comments and answers, workstream
README, target branch/worktree, and playbook instructions. It implements and
validates the change. The runner independently owns the lease, creates a
collision-resistant isolated worktree, commits remaining changes, pushes only
the feature branch, opens the pull request, records its URL, moves the task to
`in-review`, and exposes it through `pan inbox`.
