# Runner daemon

The runner is a pull-based local worker. It reads a capability profile from a
private PAN data repository, claims compatible ready Issues with a lease, and
runs each task in an isolated git worktree.

## Capability profile

Profiles live at `runners/<machine>.json` in the private data repository. The
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
  }
}
```

When the profile is loaded from `runners/<machine>.json`, the data repository
path is inferred from the profile location. `store.path` can override it when a
profile is stored elsewhere.

Validate a profile without polling:

```powershell
node .\bin\pan-runner.js --profile C:\path\to\runner.json --validate-profile
```

## Task lifecycle

The runner selects `owner=agent`, `Status=ready`, claimable items whose
requirements are all present in its profile. `manual` items are not started.
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
Wall-clock, AI-credit, per-runner concurrency, and lease limits come from the
profile. Copilot CLI requires `taskBudget.maxAiCredits` to be at least 30.

Run one polling cycle and wait for its selected tasks:

```powershell
node .\bin\pan-runner.js --profile C:\path\to\runner.json --once
```

Omit `--once` to keep polling until the process receives `SIGINT` or `SIGTERM`.

When `pan answer` resolves blocked work, PAN returns the item to triage. The
next runner attempt receives the marked answer comment in its task context.
