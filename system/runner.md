# Runner

The runner is mechanical. One instance polls the selected backend, launches
explicitly runnable AI work within local capacity, and maintains only the
process/workspace guards needed to avoid duplicate local workers. It does not
triage, choose priority, reinterpret holds, plan dates, expand scope, decide
deliverable correctness, create recurring occurrences, or manage the backlog.
Pan's main chief-of-staff session decides and writes `ready-for-ai`.

Read [task lifecycle](task-lifecycle.md), [project
schema](project-schema.md), [playbooks](playbooks.md), and [worker base
instructions](worker-base-instructions.md).

## Backend runner pilot

`pan-backend-runner` is an implemented experimental thin-backend path, not a
stub. It lists through `pan-task`, selects only `ready-for-ai/execute` records
with explicit authorization, empty dependencies, no recorded worker, and free
capacity, then invokes the configured launcher. It preserves backend order and
never gates or sorts on `next-action-date`.

The pilot config is deliberately disabled until reviewed:

```json
{
  "enabled": false,
  "backendConfig": "/absolute/path/to/backend.json",
  "machine": "stable-machine-name",
  "stateRoot": "/durable/private/path",
  "workingDirectory": "/trusted/working/path",
  "playbookName": "tool-development",
  "playbookPath": "/private/domain/playbooks/machine/tool-development.md",
  "domainInstructionsPath": "/private/domain/pan.md",
  "panTaskCommand": "/absolute/trusted/pan/bin/pan-task.js",
  "taskIds": ["optional-exact-task-id-allowlist"],
  "maxConcurrent": 1,
  "launchCommand": ["copilot", "--model", "gpt-5.6-sol", "--allow-all"]
}
```

Use `--dry-run` to inspect a poll while disabled. Enabling is an explicit local
operation after review. No cron or second intelligent dispatcher is installed:
scheduled triage wakes the same main Pan session; this runner only consumes the
set that session authorized.

The implementation uses exclusive per-task local launch files. It does not
implement distributed claims: multiple machines must not poll the same task
scope. Worker progress/questions/results are recorded through backend
`report`/`update` operations, not GitHub Issue mutation.

An enabled pilot also requires an absolute trusted `panTaskCommand`, one
resolved `playbookName` and private `playbookPath`, and private
`domainInstructionsPath`. The runner snapshots those files plus current native
reports into the launch state and gives the worker exact read/report commands.
The headed Copilot command receives `--add-dir` only for the resolved working
directory, its owned launch-state directory, the configured `pan-task`
directory, the backend-config directory, and the directory containing the
runner's resolved Node executable. The Node directory is required because the
worker's exact `pan-task` command invokes that executable; without path access,
Copilot prompts even when the shell tool itself is explicitly allowed. This
satisfies Copilot's path-access boundary without granting broad home-directory
access; tool approvals remain separately controlled by the explicit
`launchCommand`.
Before launch, the runner copies `copilotConfigPath` (default
`~/.copilot/config.json`) into a private per-run `COPILOT_HOME`. In that copy it
disables cross-session memory and adds only the resolved working directory and
owned launch-state directory to `trustedFolders`. It preserves leading `//`
comments, authentication/account metadata, unrelated settings, and existing
trusted entries; the user's source config is never modified. The runner reads
the isolated config back and fails the launch if either exact trust entry cannot
be verified. Per-run `trust.json` records the isolated home and additions.
`taskIds`, when non-empty, is an additional exact allowlist applied after
backend scope and checked again by `launchTask` immediately before terminal
spawn. It is suitable for a one-task demonstration but does not replace backend
project scoping.

Each poll inventories durable run and owner records, verifies both PID and
process-start identity, and counts live sessions against capacity. An uncertain
record fails closed. A dead matching session is recorded as stopped before its
lock is released. A live worker reserves the configured working directory, so
two tasks are not launched into one shared checkout.

One process-identity-checked lock under `stateRoot` excludes a second local
backend runner across inventory and launch. A dead holder is recoverable. A
valid pre-terminal `exit.json` also makes a launch without `owner.json`
conclusively stale, so a failed terminal start is reconciled instead of wedging
the workspace as permanently uncertain.

The runner acquires the task lock before writing `worker=starting`, writes
private task/prompt/session files, and opens a headed terminal launcher. The
launcher inherits terminal I/O, exports `PAN_STATE_DIR` and
`PAN_WORKING_DIRECTORY`, and records its process identity and exit. Launch
errors are awaited and reported. Dry-run reports `selected` separately and
always reports an empty `launched` list.

Native recurring tasks are excluded from automatic dispatch in this pilot.
Their recurrence remains usable through Todoist, but automated occurrence
execution needs a later explicit design.

## GitHub compatibility runner configuration

The required local config names:

- Domain repository and Project;
- machine and stable runner identity;
- the explicit Pan checkout workers read;
- worker permissions and headed terminal;
- durable `stateRoot` and disposable `workspaceRoot`; and
- optional capacity and attention-backpressure policy.

`stateRoot` and `workspaceRoot` must not overlap. Fixed/slot workspaces must not
overlap durable state. Local config is process configuration, not task
authority.

```json
{
  "humanAttentionBackpressure": {
    "softLimit": 5,
    "mode": "prefer-autonomous"
  }
}
```

`mode` is `off` or `prefer-autonomous`. At/above `softLimit`, the latter skips
only new `may-request` starts while allowing `autonomous` playbooks,
supervision, finalization, and cleanup. It never pauses live work.

The runner re-reads `playbooks/<machine>/*.md` each cycle. A playbook declares
capacity, optional fixed `workingDirectory` or `workspaceSlots`, and optional
`humanAttention: autonomous|may-request`.

## Startup

Normal startup and `--validate-config`:

1. resolve Domain/project and fully page Project field metadata;
2. validate every canonical field/option, while tolerating additive legacy
   recovery fields/options;
3. read and validate every machine playbook;
4. inventory configured legacy launchers and durable session roots;
5. reconcile launch manifests under per-task locks; and
6. only then poll.

The runner never mutates schema. Drift exits nonzero with instructions to run
interactive schema reconciliation.

## Runnable selection

Every poll fully pages Project items and computes Needs me pressure. An item is
runnable only when:

- `Status=ready-for-ai`;
- `next-action=execute`;
- `execution-authorized=yes`;
- `dependencies` is empty;
- the Issue has no `## Recurrence` section;
- playbook is non-empty, present, enabled, and permitted by current
  backpressure;
- global/playbook capacity is free;
- required workspace is free or already affined to this same task/session; and
- there is no active/uncertain local generation or unprocessed result.

The runner sorts one combined set of new starts and valid resumes by priority
and then canonical Project order. Resume affinity affects eligibility and
workspace selection, never ordering precedence. It never gates or sorts by
`next-action-date`, deadline, occurrence date, or source-system date.

`ready-for-human`, `external-waiting`, `deliberate-hold`, terminal states, and
legacy states are not new-lifecycle candidates. A reusable session does not
make them runnable.

## Claim protocol

Before claiming:

1. take the durable per-task launch lock;
2. re-read the Issue and Project item;
3. require the expected revision and runnable predicate;
4. validate playbook capacity and resource occupancy again;
5. reuse a matching session affinity or provision durable state for a new
   session;
6. mint a random `claim-generation`;
7. write machine/session/generation, `claimed-by`, lease,
   `worker-state=starting`, and `Status=ai-executing`;
8. increment `task-revision` last; and
9. re-read and require the exact revision, checked pair, claim, lease,
   generation, session, and machine/slot values before launching.

If a race or verification failure appears, launch nothing and do not overwrite
the winner. Operational recovery may repair only fields still proven to belong
to this generation.

## State and workspace layout

Durable session state:

```text
<stateRoot>/pan-<issue>-<session-id>/.pan/
  task.json
  playbook.md
  pan.md
  launch.json
  attempts.json
  runs/<launch-id>/
    attempt.json
    owner.json
    exit.json
    task.json
    playbook.md
    needs-human.json
    result.json
    result-consumed.json
    checkpoint-consumed.json
    worker.stop
```

Each launch generation is immutable and append-only. `owner.json` is created
exclusively before Copilot starts and carries PID plus process-start identity.
Liveness requires both to match. `exit.json` becomes conclusive only after the
owner process is gone.

State directories/files are private on POSIX (`0700`/`0600`). Every session
and attempt root is `lstat` checked; symlinks/junctions fail closed. Fixed/slot
repositories never receive Pan control files.

## Launch locking and generations

The per-task lock is an append-only contender/holder set. A holder removes only
its own UUID record. Dead records may remain as evidence; takeover never uses a
shared compare-then-unlink pathname.

Before creating a generation, scan the manifest and every indexed run:

- exactly one matching live attempt is adopted;
- multiple live attempts, unknown children, missing entries, malformed
  ownership, or unreadable process identity are `uncertain` and launch nothing;
- a new generation is created only when all older attempts are positively dead
  and no unprocessed result/checkpoint exists; and
- interrupted creation uses a durable creation key so restart repairs the same
  generation rather than appending another.

After writing a claim and its revision, the runner re-reads immediately before
launch. The exact claim/session/machine/generation/revision tuple must still
match, the Issue must still be open, and `resource-semantics` must still be
empty. A concurrent closure or persistent provenance marker rolls back the
unlaunched active claim without erasing the session/generation evidence and
launches nothing.

Signals authorize writes only when the launch id remains the manifest's current
generation and the live Project `claim-generation`, session, machine/slot,
runner claim, and revision still match. Finalization and checkpoint relay take
the same task lock and recheck immediately before mutation.

## Worker signals

### Human attention

`needs-human.json` follows the worker contract and includes exact
`action`, `question`, `detail`, `since`, and `safeToRelease`.

After a fresh generation/revision check, the runner:

- updates the Issue current-next-action block and transition comment;
- sets `Status=ready-for-human`, exact `next-action`, and
  `needs-human-since`;
- keeps `worker-state=waiting-human`, claim, lease, and slot when the worker
  remains live; and
- increments the task revision last and verifies.

Thus a live session can coexist with Needs me. Removing the signal does not
silently resume a task whose lifecycle still says human: the user must
explicitly answer/handoff so the checked pair returns to
`ready-for-ai/execute`. A stale generation never clears attention.

For `safeToRelease=true`, the runner verifies the durable checkpoint and
playbook permission, records a recovery-readable checkpoint receipt, writes
`worker.stop`, and proves the exact owned launcher dead before changing Project
ownership. It then sets `worker-state=checkpointed`, clears active claim/lease,
verifies the preserved machine/session/generation affinity, and marks the
receipt released. Startup resumes any interrupted receipt phase idempotently.
Machine/session/generation affinity persists, so another task cannot steal the
workspace. The task remains `ready-for-human`.

### Result

`result.json` accepts:

- `done` — whole outcome complete;
- `needs-human` plus exact action — AI part complete, human checkpoint next; or
- `external-waiting` — outside event next.

Legacy `needs-review` is accepted only by pilot recovery and maps to an exact
`review` checkpoint. Invalid/partial files do nothing and are retried while
supervision continues.

For every valid result the runner:

1. locks and rechecks revision/generation/session/resource ownership;
2. posts one idempotent result/transition comment;
3. applies the checked outcome pair and Issue current-next-action block;
4. for `done`, clears/verifies attention date, closes/verifies the Issue, then
   writes terminal state;
5. increments revision last and confirms;
6. for terminal workspace release, writes a digest/generation-bound release
   journal before clearing any lease/claim/machine/session/generation field;
7. clears and verifies every remaining release field, recovering any
   monotonic interrupted prefix from that journal or, for a pre-journal crash,
   reconstructing it only from the exact terminal projection plus immutable
   result/manifest evidence;
8. writes and re-reads a digest-bound `result-consumed.json`; and
9. writes `worker.stop`.

No generic review is inserted because AI acted. The playbook decides whether
review, merge, rollout, restart, or live validation remains. A worker whose
playbook requires explicit finish/live validation does not emit `done` early.

Repeated finalization failure enters `ready-for-human/review` with an exact
repair action instead of fabricating an external block or discarding the
result. Cleanup keeps retrying idempotently.

## Liveness, pause, and resume

The lease means active runner supervision; it does not own outcome state or
workspace release.

- Live worker + valid ownership → renew lease and maintain
  `worker-state=running|waiting-human`.
- Worker/runner interruption → preserve outcome state and current next action,
  clear active claim/lease only while still generation owner, and set
  `worker-state=paused`.
- Restart with one exact live generation → re-adopt and renew without clearing
  attention.
- Stopped paused/checkpointed session → preserve state root and workspace.
- Resume → only after an explicit live `ready-for-ai/execute` transition with
  `worker-state=paused`; require the same session/machine/slot/generation, no
  pending result, an open Issue, empty `resource-semantics`, and capacity. A
  resume retains its generation. Closed Issues and historical/held provenance
  are never dispatch or resume candidates.
- Deliberate hold or human checkpoint → never automatic resume.

Process exit alone never frees a workspace. Slot occupancy includes active,
waiting, checkpointed, paused, and uncertain affined sessions until explicit
handoff or terminal cleanup.

## Recovery

Startup binds a root using all of:

- canonical `pan-<issue>-<session-id>` name;
- `task.json`, `launch.json`, manifest, and attempt metadata;
- Project item id and Issue repository/number;
- machine/slot, session-id, claim-generation, and runner identity; and
- live process-start identity where a launcher may remain.

Any mismatch preserves evidence and fails closed. Unprocessed results are
finalized before pause/resume decisions. A terminal release journal binds any
monotonic partial resource-clear prefix back to its exact attempt and result so
startup can resume it. A state root is never pruned while any result, terminal
release journal, or pending checkpoint receipt remains. A consumed result is
never replayed. An old human checkpoint is never cleared merely because the
process restarted.

Legacy workspace-root migration is idempotent. It corroborates old launchers by
exact PID, command, and process-start identity, writes durable metadata, and
does not stop or replace them. Configured legacy PIDs whose source directory
vanished create durable occupancy evidence and block startup when uncertain.

Operator recovery requires stopping every runner sharing `stateRoot`,
making the task non-runnable, preserving the session root, inspecting every
attempt/owner/exit/result/checkpoint, and proving possible owners dead. Never
delete an unprocessed signal or uncertain owner. Reconstruct a corrupt manifest
only from complete matching immutable attempt evidence. Release a workspace as
a last resort only after results are preserved, all launchers are dead, and
loss of local resume state is explicitly accepted. The browser task UI never
clears workspace affinity; release is a runner/operator recovery operation
under the per-task lock with the exact expected machine/session/generation
tuple.

## Shutdown

SIGINT/SIGTERM stops new claims and keeps supervising live workers. Graceful
drain records liveness interruption without changing outcome state or making a
human/held task runnable. A second interrupt exits immediately. No broad
process kill is used.
