# Runner

The runner is a small local task/session process supervisor. `pan-runner` and
`pan-backend-runner` are two command names for the same implementation.

This document describes the terminal runner. [Pan Hub](hub.md) is the headless
ACP alternative, with browser conversations rather than worker windows. Never
run both hosts against the same task requests during cutover.

It performs one loop:

1. load the selected backend;
2. load the named machine's playbooks and `pan.md` from an explicit local
   Domain path or an explicitly pinned remote revision, plus Pan's portable
   general default playbook;
3. reconcile only processes recorded under its own state root;
4. close a managed process when its empty `worker-release.json` exists;
5. clear Agent status after an observed process closure; and
6. open or resume every task whose Agent status is `requested` unless that
   same task already has a managed process.

The runner does not read work Status as an eligibility or stop condition. It
does not inspect unrelated sessions, choose tasks, interpret results, enforce
dependencies or approvals, plan dates, allocate workspaces, claim Project
leases, reserve machines, or change business state.

Only one runner may supervise a state root at a time. A second runner must fail
clearly rather than race the first and launch a duplicate session.

An empty task playbook assignment selects the general default. A valid
non-empty assignment selects the exact configured machine playbook. When a
non-empty name is absent on this runner, the runner preserves the task field and
session ID, then opens the general default with repair instructions naming the
missing assignment, the configured Domain source and revision, and the
configured playbook definitions and launch directories in the runner profile.
Those paths are configuration metadata, not claims of runtime readiness. The
worker asks the user whether to correct the assignment or help create the
requested playbook, verifies the chosen setup, and waits before
specialist-dependent work. It does not infer global absence or mutate the
assignment automatically.

A loaded named playbook with an invalid working directory is an explicit error,
as are malformed playbooks and Domain loading or trust failures. Those
conditions do not use the missing-name fallback.

## Session launch

For a request without `sessionId`, the runner generates and persists a UUID
before launch. It passes that ID to the configured launch command. For a saved
ID, it passes the same ID. Repeated polls do not launch another process while
the runner's task record is live.

After the process starts, the runner writes `agentStatus=running`. Launch
failure leaves the durable request and session ID visible for an ordinary
retry. When the process closes, the runner clears Agent status and removes only
that task's local run directory.

After verified normal completion, the worker creates the exact empty
`worker-release.json` as its final action. An explicitly requested early close
uses the same file after its required durable checkpoint. Waiting for the user
or external work and ordinary checkpoints do not create the file. The runner
does not infer completion from work Status or validate the worker's business
decision; it observes the release request, closes the managed process, clears
Agent status, and preserves the saved session ID and work Status.

Worker sessions are interactive and visible. Their standard input and output
must remain connected to a terminal rather than being discarded by the runner.
On Windows, each worker opens in its own Windows Terminal window so the user can
observe and interact with that task independently of the runner console. The
runner starts Copilot through a task-local PowerShell 7 launcher so the complete
interactive prompt reaches Copilot as one argument.
Every worker launch includes `--allow-all-paths` and
`--add-dir <workingDirectory>`. Filesystem access is preapproved and the
working directory is available to the session. Copilot's separate persistent
folder-trust setting must also include that working directory for unattended
startup; `--allow-all-paths`, `--allow-all`, and `--yolo` do not bypass that
trust prompt.

The runner console reports startup, each backend poll, worker launches and
closures, skipped requests, restored task state, and a concise poll summary.
These messages are operational diagnostics only and are not durable task state.
Normal backend polls start five minutes apart. Pressing Enter in the runner
console polls immediately and starts a new five-minute interval.

Before every worker launch, the runner re-enumerates the complete workstream
catalog from the Domain registry and every store digest. It rejects malformed,
unavailable, or duplicate catalogs before launch and resolves the task's exact
unqualified workstream path. This happens per launch rather than once per poll.

Each task run directory contains a small `run.json`, snapshots of the task,
comments, playbook, Domain instructions, launch-time `workstreams.json`, the
selected detailed `workstream.md`, selected `workstream-source.json`
provenance, and the optional empty release file. The worker treats catalog and
document snapshots as launch-time context and re-reads live store state before
writes. These files are local process bookkeeping, not another task or
workstream store.

## Domain source

The runner config must set exactly one reviewed source:

- absolute `domainPath`; or
- `domainRepo` plus non-empty `domainRevision`.

There is no fallback to the remote default branch. The same source supplies
both playbooks and Domain instructions.

## Working directory

The playbook may declare one absolute `workingDirectory`; otherwise the runner
config must provide one. The runner starts the session there. It does not
create per-task workspaces, choose among slots, or infer repository layout.
Playbook instructions own setup and delivery decisions.

## Configuration

```json
{
  "backendConfig": "C:\\absolute\\backend.json",
  "domainPath": "C:\\absolute\\reviewed-domain-worktree",
  "machine": "machine-name",
  "stateRoot": "C:\\absolute\\runner-state",
  "workingDirectory": "C:\\Repos",
  "pollIntervalSeconds": 300,
  "launchCommand": [
    "copilot",
    "--model",
    "gpt-5.6-sol",
    "--agent",
    "pan-worker"
  ]
}
```

Use `--once` for one real poll and `--dry-run` for read-only selection.
