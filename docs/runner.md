# Pan runner

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
its own capacity in addition to global capacity. A playbook with `"capacity": 0`
is disabled: it keeps its configuration but never claims work, which is how you
take a workspace back for manual use without deleting the playbook. An offline
profile may have no repositories; an online profile must have at least one.

Repository entries use `origin` for both the default-branch base and pushes
unless configured otherwise. For a fork checkout, set `baseRemote` to the
remote for the configured upstream repository and `pushRemote` to the fork
remote. Pan validates both remotes before launch and again before accepting
completion, and requires them to be GitHub remotes. A playbook that sets
`workingDirectory` is exempt from all of that, so its repository may live on
any host.

## Delivery

The runner does not implement delivery and does not verify it. The playbook's
`instructions`, together with the Issue itself, tell the agent what to build and
how to deliver it: open a pull request, commit to the default branch, write up an
investigation, or drive a repository's own tooling. Where the two disagree, the
Issue is the more specific instruction and wins.

The agent reports one outcome when it finishes: `done` when nothing further is
needed, or `needs-review` when a human should look at the delivery first. Pan
records the agent's summary and details on the Issue and moves the Project item
to `done` or `in-review` accordingly. For work delivered as a pull request, Pan
still confirms the merge directly from GitHub before completing the Issue.

Because the runner verifies nothing about how work was delivered, the playbook
instructions are the only thing standing between the agent and an unsafe change.
Say explicitly how to isolate work, how to build and test, and how to deliver.

## Worker lifecycle

For a claimed task the runner creates a non-default branch and dedicated
worktree, supplies Issue, answer, workstream, and playbook context to Copilot,
and writes append-only Issue journal records that identify the selected
playbook and Copilot session. It owns task leases and the
isolation guarantees around them: before accepting completion it confirms the
task stayed on its own branch, left nothing uncommitted, and did not rewrite the
repository's remotes. It never deletes the task branch, so unpushed work
survives. A playbook that sets `workingDirectory` opts out of all workspace
preparation: the runner only launches the worker there, holds the lease, and
monitors progress and human-attention requests.

An operational stop, terminal closure, launch failure, lost lease, or missing
result returns work to `ready` with resumable state; it is not human attention.
A task that reaches three consecutive operational failures instead moves to
human attention so an unattended runner cannot retry it indefinitely.
Intentional runner shutdowns do not count toward that limit, and resolving the
attention request explicitly re-arms the task.

A real worker question is a pause, not a failure. The worker sets
`needs-human-since`, asks in its own terminal, and keeps running: it holds its
lease and its concurrency slot, and its budget clock stops until the answer
arrives. Answer it in that terminal and it clears the request and continues.
Because it keeps its lease, the slot stays occupied for as long as the question
goes unanswered.

If that machine restarts, the task is rehydrated there rather than anywhere
else, and the resumed worker re-states its outstanding question in the new
terminal. Interrupted worktrees and saved Copilot session IDs make that resume
safe. A task that has to start over from the beginning has its stale request
cleared instead. `blocked` is reserved for work waiting on something outside the
user's control, and no worker holds it.

Runner profile changes require restarting `pan-runner`. Pan domain, session, or
scheduling changes do not.
