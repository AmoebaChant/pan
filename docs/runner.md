# PAN runner

`pan-runner` is an independent, pull-based local worker. It reads a private runner
profile, selects compatible `owner=agent`, `ready` Project items by priority
while preserving Project order among ties, claims them with a renewable lease,
and launches headed Copilot workers in isolated worktrees.

## Profile and startup

Runner profiles are private domain data, normally
`runners/<machine>.json`. They contain local paths, terminal settings,
capabilities, global capacity, repositories, and playbooks. The public shape is
in [`schema/runner-profile.json`](../schema/runner-profile.json).

```powershell
pan-runner --profile C:\domains\personal-domain\runners\machine-a.json --validate-profile
pan-runner --profile C:\domains\personal-domain\runners\machine-a.json --once
pan-runner --profile C:\domains\personal-domain\runners\machine-a.json
```

`--validate-profile` performs no polling. `--once` runs one cycle and waits for
its selected tasks. Without it, the foreground runner continues until SIGINT or
SIGTERM. It backs off while idle and uses bounded rate-limit handling.

Each enabled playbook matches repository and capability requirements and has
its own capacity in addition to global capacity. An offline profile may have no
repositories; an online profile must have at least one.

Repository entries use `origin` for both the default-branch base and pushes
unless configured otherwise. For a fork checkout, set `baseRemote` to the
remote for the configured upstream repository and `pushRemote` to the fork
remote. PAN validates both remotes before launch and again before accepting
delivery.

## Delivery policy

Playbooks default to `"delivery": "pull-request"`. That policy creates or
updates a pull request and leaves the Project item in `in-review`; Pan confirms
the merge directly from GitHub before completing the Issue and Project item.

`"delivery": "direct"` is exceptional and must be explicitly authorized for
that playbook. The worker integrates with the configured default branch and
reports a commit. The runner validates that the commit is reachable from the
default branch before moving the item to `done` and closing its Issue.

`"delivery": "report"` is read-only investigation. The worker may inspect and
reproduce behavior but cannot change tracked files or create commits. PAN
records the complete report on the Issue and moves the item to `in-review`.

## Worker lifecycle

For a claimed task the runner creates a non-default branch and dedicated
worktree, supplies Issue, answer, workstream, and playbook context to Copilot,
and writes append-only Issue journal records. It owns task leases and
deterministic delivery validation. It validates the reported remote commit or
pull request before Project transition and cleanup.

An operational stop, terminal closure, launch failure, lost lease, or missing
result returns work to `ready` with resumable state; it is not human attention.
A task that reaches three consecutive operational failures instead moves to
human attention so an unattended runner cannot retry it indefinitely.
Intentional runner shutdowns do not count toward that limit, and resolving the
attention request explicitly re-arms the task.
A real worker question writes a structured needs-human record and blocks the
task. Pan records the answer directly in the Issue and restores it to ready
agent work. Interrupted worktrees and saved Copilot session IDs allow a
compatible runner to resume safely.

Runner profile changes require restarting `pan-runner`. PAN domain, session, or
scheduling changes do not.
