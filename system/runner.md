# Runner

The runner is a small local task/session process supervisor. `pan-runner` and
`pan-backend-runner` are two command names for the same implementation.

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

An empty task playbook assignment selects the general default. A non-empty
assignment must match the configured machine's loaded Domain playbooks exactly.
Missing named playbooks remain requested and are reported as skipped; the
runner never substitutes the default without an explicit task edit.

## Session launch

For a request without `sessionId`, the runner generates and persists a UUID
before launch. It passes that ID to the configured launch command. For a saved
ID, it passes the same ID. Repeated polls do not launch another process while
the runner's task record is live.

After the process starts, the runner writes `agentStatus=running`. Launch
failure leaves the durable request and session ID visible for an ordinary
retry. When the process closes, the runner clears Agent status and removes only
that task's local run directory.

Each task run directory contains a small `run.json`, snapshots of the task,
comments, playbook, and Domain instructions, plus the optional empty release
file. This is local process bookkeeping, not a second task store.

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
  "pollIntervalSeconds": 10,
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
`--inspect-playbooks` loads the same configuration and resolver without loading
the task backend or changing task or runner state. It reports the configured
named playbooks and whether the default and each named playbook has a usable
working directory.
