# Runner

The runner is the one program in Pan. It is a small Node script, one instance
per machine, that polls the Domain Project for ready work matching the playbooks
this machine runs, claims it with a lease, and launches a headed Pan worker
session to do it. It implements no task logic and verifies no deliverables — the
[playbook](playbooks.md) instructions and the Issue do that. The runner only
finds work, coordinates leases, launches the worker in a terminal, and relays
the worker's human-attention and completion signals to the Issue.

Everything the runner reads or writes on GitHub follows the
[project schema](project-schema.md). The runner uses `gh`.

## Configuration

The runner is given, from local machine config written at onboarding:

- the Domain repository and Project (`<owner>/<number>`);
- this machine's name, used to read `playbooks/<machine>/*.md` from the Domain
  repo (see [playbooks](playbooks.md)) for the playbooks, capacities, and
  working directories it may run;
- a stable runner identity string for `claimed-by`;
- the **default worker permissions** for agents this runner launches
  (`workerPermissions`): `yolo` (default — launch workers with `--allow-all`,
  auto-approving every tool, path, and URL so workers run fully unattended) or
  `standard` (no auto-approve flags, which requires a human at the terminal to
  confirm each tool). Regardless of this setting the runner always launches
  workers with `--deny-tool ask_user`: a worker's only channel for reaching the
  user is `.pan/needs-human.json` (see below), so the interactive `ask_user`
  tool — which would block silently in the worker's own terminal without setting
  `needs-human-since` — is never available to it. A raw `copilotArgs` escape
  hatch is still appended after the derived permission flags for anything not
  expressed by this setting;
- terminal settings for launching a visible worker window (Windows Terminal on
  Windows, Terminal.app on macOS).
- an optional durable `stateRoot` and disposable `workspaceRoot`. `stateRoot`
  defaults per user to `%LOCALAPPDATA%\Pan\<runner>` on Windows,
  `~/Library/Application Support/Pan/<runner>` on macOS, and
  `$XDG_STATE_HOME/pan/<runner>` (or `~/.local/state/pan/<runner>`) on Linux.
  `workspaceRoot` remains configurable and defaults below the system temporary
  directory. The roots must not overlap.

Regardless of `workerPermissions`, the runner pre-authorizes each worker's
folders before launch by adding them to copilot's `trustedFolders`
(`~/.copilot/config.json`, overridable via `copilotConfigPath`). copilot's
`--allow-all` covers tools, paths, and URLs but not the separate per-folder
trust gate. It trusts both the worker's working directory and its session state
directory (they differ for a fixed/slot playbook); without this step every
worker would stop on an interactive "trust this folder?" prompt. The write is
best-effort — on any failure the worker simply falls back to prompting.

Each worker window is given a stable, human-readable title (`#<number> <short
title>`) so the user can tell at a glance which task each spawned window is
working on. On macOS this is pinned as a Terminal.app custom title; on Windows
via `--title`/`--suppressApplicationTitle`.

The runner re-reads the `playbooks/<machine>/` folder and every
`playbooks/<machine>/<name>.md` from GitHub each cycle, so playbook changes take
effect without editing local config. Local config changes require restarting the
runner.

## Startup schema check

The runner is unattended and **never mutates the Project schema**. It already
loads the Project's field and option metadata once at startup to resolve field
and option ids. Normal startup — not only `--validate-config` — validates that
already-loaded metadata against the canonical [project schema](project-schema.md)
before it begins polling, so it reuses the read it already performs and adds no
GitHub round trip to the happy path.

If a canonical field is missing or wrong-typed, or a canonical single-select is
missing an option the runner reads or writes, the runner **exits once, nonzero**,
with a loud, actionable message: the Project schema is out of date, open Pan chat
and run the [reconcile Project schema](project-schema.md#reconciling-the-project-schema)
action to bring it up to date, then restart the runner. Failing fast here
replaces the per-poll failure mode where every claim write would otherwise fail
with "Project has no field …" and the runner would loop indefinitely. Bringing
the schema back into line is an interactive Pan-chat action, never something the
runner does on its own. `--validate-config` performs the same check and reports
the same problems before exiting.

## Poll cycle

Each cycle:

1. Read the full Project item set; do not stop at a default page.
2. **Sweep stale running tasks to `paused`.** For every `owner=agent` item with
   `Status=in-progress` and an expired lease that this runner is not itself
   supervising, re-read it to confirm that the lease is still expired, then
   change only `Status` to `paused` (see [the paused
   sweep](project-schema.md#the-paused-sweep-documented-non-owner-write)).
   Active leases and malformed lease timestamps are left untouched. A local
   item swept this way can be selected for resume in this same cycle.
3. **Resume this machine's paused tasks.** For items with `Status=paused` and
   `machine` equal to this machine, resume them (see [resume](#lease-driven-resume)),
   subject to the same capacity limits, before or alongside claiming new `ready`
   work. Paused tasks pinned to another machine are left untouched.
4. Read ready agent work: items with `owner=agent`, `Status=ready`, and a
   non-empty `playbook` (the [dispatch rule](project-schema.md#dispatch-rule)).
5. Keep only items whose `playbook` names a playbook in this machine's
   `playbooks/<machine>/` folder with spare capacity (global and per-playbook),
   and whose lease is free (`lease-until` empty or in the past, or `claimed-by`
   is this runner). Order by `priority` (`urgent` > `high` > `normal` > `low`),
   preserving Project order among ties, and claim from the top while capacity
   remains.
6. Back off when idle, and handle GitHub rate limits with bounded retries.

`--once` runs a single cycle and then supervises whatever it launched;
otherwise the runner loops until interrupted (SIGINT/SIGTERM), draining active
workers on shutdown.

When looping in a terminal, the runner backs off between polls while idle. An
operator who has just added or unblocked work can skip that wait: pressing
**Enter** or **Space** in the runner's terminal queues a poll cycle immediately.
The request remains queued if the runner is currently polling or supervising,
so it cannot be lost merely because no idle wait is active. The resulting cycle
is an ordinary poll and the trigger is ignored while draining.

Supervising active workers is decoupled from the poll cadence: while workers are
running the runner wakes frequently to service their signals and renew leases,
but it still polls the Project no more often than `pollIntervalSeconds`. A
running worker therefore never accelerates polling.

## Console output

Timestamps the runner prints to its terminal are in the machine's **local
time** (`YYYY-MM-DD HH:MM:SS`), since that output is for the person watching the
window. Timestamps written to the Project or to signal files (leases,
needs-human `since`) remain RFC 3339 UTC.

## Claiming (leases)

The lease is Pan's **single liveness signal**. The runner renews an active
worker's `lease-until` periodically while the worker runs (about every 1/3 of
the lease window), so a valid lease means the owning runner is alive and
supervising, and an expired lease means the task is not running. Recovery is
therefore driven by the lease at poll time — not by scanning the filesystem, and
not only at startup.

To claim a `ready` item, re-read it, confirm it is still dispatchable and
unleased, then provision the durable session root and persist its `session-id`
and `machine` before setting `claimed-by`, `lease-until`, and finally `Status`
to `in-progress`. The confirming re-read includes the exact session id. This
ordering ensures that a crash cannot leave an in-progress claim with no
recoverable session: after lease expiry, the normal paused sweep can resume the
already-provisioned root. Renew `lease-until` periodically while the worker
runs. If a claim races with another runner (the re-read shows it already
claimed), skip it.

When a worker's PID dies, the owning runner should **proactively release the
lease** immediately rather than waiting for it to expire: clear `lease-until` and
`claimed-by` and set `Status=paused`, keeping `machine` and `session-id` so the
task can resume on this machine. This collapses the one inconsistent state
(`lease valid` + dead worker) into `paused` at once. A graceful shutdown/drain
does the same for the runner's active tasks.

A crash the owning runner cannot report itself (the whole runner died) leaves an
`in-progress` item with an expiring lease; the [poll-time sweep](project-schema.md#the-paused-sweep-documented-non-owner-write)
on any runner flips it to `paused` once the lease has expired.

Every poll also clears stale `claimed-by` and `lease-until` values from terminal
`in-review`, `done`, and `blocked` items after a confirming re-read. This
finishes cleanup after a crash between non-atomic GitHub field writes without
changing the terminal lifecycle state.

An operational failure that is not a crash — launch failed, terminal could not
open — restores the state from which launch was attempted: a new task returns
to `ready`, while a failed resume remains `paused` so its established session
and workspace are not discarded. It is not human attention. Repeated
operational failures on the same task (three in a row) should instead raise
human attention so an unattended runner cannot retry forever.

## Launching a worker

Every task has two distinct locations. Its authoritative **session state
directory** lives under durable `stateRoot`; its **working directory** is the
worker's terminal CWD and may be disposable. A resumed `session-id` must have
the exact UUID shape Pan mints, and resolved state/workspace paths must remain
inside their configured roots. `stateRoot` and `workspaceRoot` may not overlap,
and a fixed/slot checkout may not overlap the state directory.

Within a session, every launch gets a distinct UUID launch id and an isolated
`.pan/runs/<launch-id>/` directory. Ordinary launch ids are derived from a
durable, monotonically numbered creation key recorded in the manifest before
the attempt directory is populated. Restart therefore repairs the same launch
operation instead of minting another UUID around a partial attempt. PID is
owner data, never directory identity.
Before any launch or resume the runner takes an atomic per-task launch lock.
The lock is an append-only set of uniquely named contender/holder records; dead
records may remain as evidence, and stale takeover never removes or replaces a
shared lock pathname. Every holder removes only its own UUID record. This makes
stale-owner recovery serialized without a compare-then-unlink race on macOS,
Linux, or Windows. Claim scans restart when another contender removes a record
between directory enumeration and inspection, so a changing cross-process
snapshot cannot make every contender withdraw. The runner then scans the durable
attempt manifest and every recorded attempt:

- exactly one process whose PID **and process-start identity** match its
  `owner.json` is adopted; no new process starts;
- multiple confirmed live attempts are an operational conflict and no third
  process starts;
- missing, malformed, inaccessible, or otherwise unverifiable ownership fails
  closed and no process starts;
- a missing/malformed manifest, a missing `runs/` directory, a manifest entry
  whose directory vanished, or an unexpected/renamed child is uncertain and
  fails closed;
- a new attempt may be created only when every prior attempt is positively dead
  and no prior attempt carries an unprocessed result.

The process-start identity uses the Linux boot id plus `/proc` start ticks,
macOS `ps` start time for the exact PID, or the invariant UTC tick count of the
Windows process creation time. Windows PowerShell returns a JSON record whose
start ticks and command line are separate fields; command metadata is never
folded into identity, and no locale-formatted timestamp is parsed. A live PID
with a different start identity is a reused PID and the old attempt is dead.
Process-table command-line matching is not used for normal ownership; it is
only a one-time corroboration when adopting a pre-generation legacy worker that
never recorded a start identity.

For a claimed task the runner:

1. Resolves the two locations. If the playbook's `workingDirectory` is set, or it
   declares `workspaceSlots` (see [workspace slots](#workspace-slots)), the
   working directory is that real in-place checkout. Otherwise the task is
   isolated and receives a separate directory under disposable
   `workspaceRoot`. The durable state directory and disposable isolated
   workspace use the same stable `pan-<issue>-<session-id>` basename, so a
   resume reopens both without storing control state in the checkout.
2. Immediately before each launch or relaunch, re-reads the live Issue and
   rewrites durable session context, then snapshots it into the new launch
   attempt directory (see the [file contract](#worker-file-contract)). The payload
   includes the current body and complete chronological comment history, while
   retaining structured recorded answers from the existing session. Because
   that directory is out of the repository tree for a fixed/slot task, the
   worker is told its absolute path (in the launch prompt and in the
   `PAN_STATE_DIR` environment variable) and copilot is granted access to it.
3. Launches a **headed** `copilot` session in a visible terminal window, with an
   initial prompt that tells the worker to follow
   [`system/worker-base-instructions.md`](worker-base-instructions.md), its
   playbook, and the task context in `.pan/`. The session runs under an explicit
   copilot session id (`copilot --session-id <id>`). The runner records that id
   in the Issue's `session-id` field so the work can be resumed or revisited
   later. On any later launch with a session id recorded for this machine, it
   reuses that id — including `in-review` work returned to `ready` — so copilot
   resumes the earlier session rather than starting over. Copilot sessions are
   local to a machine, so a `session-id` recorded for a different machine is
   never reused.
4. Watches only the owned attempt directory for the human-attention and result
   signals below, and renews the lease while the worker runs.

The runner never edits task content, never pushes on the worker's behalf, and
never bypasses the playbook.

## Workspace slots

A playbook may declare `workspaceSlots` instead of a single `workingDirectory`
(see [playbooks](playbooks.md)): a fixed set of named, reusable directories that
concurrent tasks of that playbook draw from, one task per slot. Because a task
holds exactly one slot, the playbook's `capacity` may not exceed its slot count.

The chosen slot becomes durable affinity: the runner writes the `machine` field
as a composite `<machine>::<slot>` when it claims a slot-pooled task, and
confirms that exact composite value (alongside `claimed-by`, `lease-until`, and
`Status=in-progress`) on the post-claim re-read. A prior composite affinity
belongs only to its base machine and that exact slot: a runner resumes it in the
same slot and waits if that slot is busy, and skips an affinity for another
machine or for a slot the live playbook no longer configures. New work — and a
legacy exact-machine task migrating into this scheme for the first time — takes
the first configured free slot deterministically.

Each poll computes the slots occupied on this physical machine from its own
in-memory active workers (including finalization-pending ones whose directory is
not yet released) and from live Project items that are `in-progress` with a
composite affinity for this machine and a lease that is not expired (a malformed
lease fails closed and occupies; an expired lease frees its slot). A slot chosen
this poll is reserved locally the moment its claim succeeds, so two claims in one
cycle cannot take the same slot. This is sufficient for the
**one-runner-per-machine** contract Pan assumes — occupancy is derived from
Project lease state and this runner's own workers, not from scanning processes,
PIDs, or the filesystem — and the same-resolved-directory active-worker guard
remains the final backstop against launching two workers in one slot directory.

## Worker file contract

Durable session context lives in
`<stateRoot>/pan-<issue>-<session-id>/.pan/`. Launch-specific files live below
`.pan/runs/<launch-id>/`. The worker receives that attempt directory as
`PAN_STATE_DIR`; it never writes another attempt's files or a `.pan/` inside its
checkout.

**Durable session files:**

- `.pan/task.json`, `.pan/playbook.md`, and optional `.pan/pan.md` — the latest
  task context and instructions. Before launch these are refreshed and copied
  into the new attempt, giving the worker a generation-stable snapshot.
- `.pan/launch.json` — runner-owned session metadata: task/session identity,
  machine and runner identity, workspace kind, working directory, and slot.
  Rehydration requires exact agreement among the canonical root name, this
  marker, `task.json`, and the live Project item.
- `.pan/attempts.json` — durable append-only index binding the session identity
  to every launch UUID and naming the current owned launch. Each ordinary entry
  carries its durable creation key. It is written before a new attempt directory
  is populated, so restart can finish the same ownerless, non-exited creation
  after interruption before/after the manifest, directory, attempt metadata,
  or terminal handoff. Deletion, rename, malformed children, conflicting
  ownership, or missing `runs/` structure still fail closed. Restart recovery
  consumes signals only from that current launch.
- `.pan/runs/` — immutable launch generations. Every indexed UUID child has
  `attempt.json`, including its launch id and the full task/session/workspace
  binding.

Pan creates runner state directories with owner-only permissions (`0700`) and
runner-written state files with owner read/write permissions (`0600`) on POSIX.
Atomic replacements are staged with the same private mode. Windows uses its
native ACL behavior; POSIX mode bits are not assumed there.

**Attempt ownership and launcher files:**

- `owner.json` — exclusively created by the launcher before it starts Copilot:
  `{ launchId, pid, processStart, ... }`. A repeated terminal handoff for the
  same recovered attempt cannot replace this file; only the launcher that wins
  the exclusive create may start Copilot. The runner accepts liveness only when
  the PID exists and its current process-start identity exactly matches.
- `exit.json` — atomically written by that launcher during cleanup. It does not
  make an exact still-live owner dead; it becomes conclusive once the owner
  process is gone. A terminal-launch failure may record an exit before an owner
  exists.
- `launch.mjs` and `launch-prompt.txt` — private to that attempt. The generated
  launcher reads and cleans only its own directory. `worker.running` and
  `worker.pid` may still be emitted as diagnostics and for legacy compatibility,
  but neither is authoritative for normal liveness.
- attempt-local `task.json`, `playbook.md`, and optional `pan.md` — the launch
  snapshot read by the worker.

**Worker → runner, scoped to the owned attempt:**

- `needs-human.json` — **presence means the worker needs the user.** The
  worker writes it with `{ "question": "…", "since": "<RFC3339 UTC>" }` when it
  needs an answer, and **deletes** it once its question is resolved. While the
  file exists, the runner sets the Issue's `needs-human-since` (and posts a
  comment with the question); when the file is removed, the runner clears
  `needs-human-since`. The worker keeps its lease and slot the whole time.
- `result.json` — written once when the worker finishes:
  `{ "outcome": "done" | "needs-review", "summary": "…", "details": "…" }`.
  The runner records the summary/details on the Issue and moves the Project item
  to `done` (outcome `done`) or `in-review` (outcome `needs-review`). When it
  sets `done` it first confirms the Issue is closed as completed, per the
  [project schema](project-schema.md) (`done` and a closed Issue go together).
  For pull-request work, the runner should confirm the merge from GitHub before
  setting `done`; in the current implementation this merge confirmation is
  best-effort and not yet enforced — a playbook that must not auto-complete
  before merge should report `needs-review` rather than `done`.
  A task reported as `needs-review` stays `in-review` until
  [triage](triage.md) reconciles the merge from the PR link the worker recorded
  on the Issue.
  Completion writes are idempotent and retried with backoff without consuming
  worker capacity. Three failures before the terminal Status is committed move
  the task to `blocked` and post a durable escalation comment. If the terminal
  Status was committed but lease cleanup was interrupted, the runner keeps
  retrying only that cleanup and every poll independently repairs stale
  terminal lease fields. Neither path sets `needs-human-since`, because no live
  worker remains waiting at a terminal.
  After a runner restart, an owned attempt with a pending result and a matching
  `done` or `in-review` Status (or this runner's `blocked` escalation)
  is re-adopted long enough to confirm cleanup and write `worker.stop`; it is
  not mistaken for an unrelated manual transition.
  Supervision accepts result and attention signals only when the worker's launch
  id is still the manifest's current generation and every attempt remains
  verifiable. A manifest advance quarantines the superseded attempt and surfaces
  a fail-closed diagnostic; its result, attention, and stop files remain
  evidence and authorize no mutation. Finalization takes the same per-task
  launch lock used by creators and rechecks the manifest immediately before its
  first Issue/Project mutation, closing the signal-discovery-to-write race.

**Runner → worker (written after finalizing):**

- `worker.stop` — **presence means the task is finalized; the worker should
  shut down and close its window.** Once the runner has recorded a worker's
  `result.json` on the Issue and updated the Project (for either outcome), it
  writes this file only in the owned attempt. The worker session then stops and closes its own terminal
  window so finished worker windows do not pile up. On macOS the launcher runs
  in place of the login shell (via `exec`), so once it exits the terminal tab
  has no running process and Terminal.app closes it silently — without its "Do
  you want to terminate running processes in this window?" prompt. This fires
  only on completion — a worker paused on `needs-human.json` keeps its window
  open for the user to answer in.

## Human-attention relay

`needs-human-since` on the Issue is the single signal that a human is needed. It
is set from the presence of the owned attempt's `needs-human.json` and cleared
when that file is removed. A worker waiting for the user stays alive, holds its lease and its
concurrency slot, and spends no budget until answered. Because the runner
launches workers with `--deny-tool ask_user`, this file is a worker's only way
to reach the user; a worker cannot instead pop an interactive `ask_user`
prompt that the runner would never surface as `needs-human-since`. `Status` stays
`in-progress`; the user answers in that worker's terminal, the worker clears its
file, and the runner clears the Issue field. A future notification system will
alert the user when `needs-human-since` is set.

## Lease-driven resume

Project recovery remains lease-driven at poll time, while durable attempt
reconciliation at startup prevents a false lease expiry or lost convenience
marker from creating another local worker.

Session reuse is not limited to `paused`. Whenever a dispatchable task already
has a `session-id` for this machine, the runner reuses that id and refreshes
`task.json` before relaunch. This includes review feedback that moves an
`in-review` task back to `ready`.

A started task that is not running is `Status=paused` (see [status
transitions](project-schema.md#status-transitions)). Because the copilot
`session-id` and the local workspace are machine-local, only the machine that
ran the task can reuse them, so **paused tasks are machine-pinned**: a runner
resumes only items whose `machine` base equals this machine and whose `Status`
is `paused`. For a slot-pooled task the pin is a composite `<machine>::<slot>`
value; the runner matches on the base machine and resumes in that exact slot.

To resume such a task the runner, subject to its capacity limits:

1. Re-reads the item and confirms it is still `paused` and pinned to this
   machine. If another cycle or machine changed it, skip.
2. Reuses the same session state directory (stable by session id) and, for a
   fixed/slot task, its recorded working directory, then relaunches copilot with
   the recorded `session-id`, so the worker picks up the earlier session's
   transcript and state instead of starting over. An isolated task also reopens
   its separate checkout under `workspaceRoot`. A `session-id`
   recorded for a different machine is never reused.
3. Sets `Status=in-progress`, a fresh `lease-until`, and `claimed-by` to this
   runner, and **clears `needs-human-since`**. A human-attention question is not
   a recovery input; if it still stands the worker re-raises it, and because it
   is surfaced on the Issue the user sees it wherever it resumes.

A resume never discards a finished worker's result. If any owned prior attempt
holds an unprocessed `result.json`, the runner refuses the relaunch (leaving the
task `paused` with its result intact) so the outcome is finalized instead.

If the runner restarts while a worker is still alive, it re-adopts that live
worker against its saved attempt and resumes lease renewal and signal watching
only after binding the durable session root to the live Project item and
confirming the attempt owner. Every restart action (adopt, finalize, or delete)
requires exact agreement across the canonical root name
`pan-<issue>-<minted session UUID>`, `task.json`, `launch.json`,
`attempt.json`, and the live Project item on issue number, item id, base
machine, `session-id`, workspace kind, and slot. Each session and attempt root
is `lstat`-checked so a symlink or Windows junction is never followed.
A stale session-A root therefore never finalizes or deletes session B.
If a scan finds multiple live attempts or any uncertain attempt, the runner
keeps the task fail-closed, consumes no attempt's worker signals, and prints a
diagnostic listing launch ids, statuses, and known launcher PIDs. It periodically
rechecks: one remaining confirmed live attempt is adopted, all-confirmed-dead
attempts release the task to `paused`, and ambiguity continues to block launch.
Because a live worker's fixed/slot checkout must never receive a second worker,
restart reconciliation keeps that directory reserved: a still-ours live worker is
re-adopted only after an immediate re-read confirms it is `in-progress`+ours or
the exact passive-sweep state (`paused`, our claim, an expired lease), which is
restored with a fresh claim/lease/`in-progress` and a confirming re-read; on any
mismatch, concurrent transition, or foreign claim the worker is reserved without
being adopted so newer Project state is never overwritten. A pending result on a
still-ours item swept to `paused` — our surviving claim plus an expired lease — is
finalized rather than stranded, while an unclaimed (manual) pause is left alone.
Finalization itself re-reads the item immediately before any Issue or Project
write and re-validates the exact session-id and machine/slot affinity (and, for a
swept finalization, the still-paused, still-claimed, still-lapsed state), so a
startup snapshot can never authorize a write onto drifted state. A worker it
cannot verify as alive is not duplicated; its task simply shows up as `paused`
(once its lease has expired or the runner releases it) and is resumed through the
normal poll-time path above.

### Workspace hygiene

A runner-created session state root whose task is no longer this runner's to
supervise — finalized, released to `ready`, missing from the Project, or
externally transitioned — and which has no live worker and is not a paused task
pinned to this machine awaiting resume, is **inert**, and the runner removes it.
The runner also preserves a fully bound stopped `in-review` or `ready` root when
it carries a recorded session, so follow-up work can reuse the transcript and
isolated checkout.
Pruning deletes an owned inert session root only under `stateRoot`. For an
isolated task it may also delete the corresponding canonical disposable
workspace under `workspaceRoot`; it never deletes a fixed `workingDirectory` or
`workspaceSlots` checkout. Deletion is **fail-closed on ownership**: an invalid,
foreign, linked, or unmarked root is preserved.

Dead launch-attempt directories remain useful diagnostics and are not shared
with newer generations. An old launcher's cleanup can remove only files in its
own attempt, so it cannot erase a newer launch's liveness, result, question, or
stop signal.

### Upgrade migration

At startup the runner scans the old `workspaceRoot` layout
(`pan-<issue>-<session-id>/.pan/`) before scanning durable state. A legacy root
is migrated only when its name, task context, launch marker (when present), and
live Project item bind to the same task and session.

- Session context is copied into `stateRoot`; an isolated checkout stays where
  it is and becomes the recorded disposable workspace.
- A stopped legacy result is copied into a dead launch generation so it can be
  finalized rather than cleared.
- A live legacy launcher is not moved, stopped, or modified. Pan verifies the
  exact PID's command is that legacy `launch.mjs`, captures its current
  process-start identity in a durable migrated attempt, and supervises signals
  at the old path until that launcher exits. This is the only compatibility path
  that uses command-line corroboration.
- A live PID that cannot be corroborated becomes an uncertain attempt. The
  runner reports it and launches nothing until an operator can resolve it.

If the old temporary state directory vanished before upgrade, the operator may
temporarily configure `legacyLauncherPids` with the known launcher PIDs. Pan
adopts only when the exact live command is a legacy `launch.mjs`, the
issue/session parsed from that command has exactly one matching Project item,
and process-start identity can be captured. It creates only durable metadata;
it does not recreate the vanished directory, signal the process, or launch a
replacement. If the configured PID is live but its start identity or command
cannot be read, Pan writes an owner-only
`stateRoot/legacy-launcher-occupancy/<pid>.json` record and aborts startup.
That record continues to block startup even if the PID is removed from
configuration; remove it only after explicit operator reconciliation. Remove
the configured PID after that legacy launcher exits.

This migration is idempotent and leaves legacy source files in place while a
launcher may still depend on them. Thus upgrading while active or paused work
exists does not strand the Copilot session, and losing the old temporary files
after migration cannot cause a duplicate: the durable owner record still
identifies the live process. Configured-PID and discovered-directory migration
recognize the same launcher by its PID plus process-start identity, independent
of which source found it. Migration attempts use that identity in a deterministic
creation key, so concurrent or repeated startup repairs the same manifest entry
and attempt directory after a crash before or after directory creation,
`attempt.json`, or `owner.json`; it never appends a second generation for the
same verified process. Distinct or unverifiable process identities remain
separate and fail closed.

For deployment, keep the old runner stopped while reconciling the startup
inventory. Put every expired task without a corroborated live launcher into a
non-dispatchable operational hold before starting the upgraded runner. List
each known surviving legacy launcher PID in `legacyLauncherPids`, start only
after the held tasks are confirmed, and let startup migrate/adopt those live
processes without stopping or replacing them. Remove a configured PID only
after its launcher exits; an uncertain occupancy record requires explicit
operator reconciliation. This order prevents the first poll from treating an
expired, not-yet-held task as launchable while preserving live workers.

A still older runner that wrote `.pan/` directly into a fixed/slot repository
is not moved or deleted automatically. Clean that repository operationally only
after all workers using it have stopped.

### Operator recovery for durable-state ambiguity

Fail-closed diagnostics are evidence of possible ownership, not permission to
delete state. Before manual recovery, stop every Pan runner that uses the same
`stateRoot`, prevent the Project item from becoming dispatchable, and make a
copy of the affected session root outside `stateRoot`. Inspect:

1. `task.json` and `launch.json` plus the canonical root name to identify the
   exact Project item and session;
2. every `attempts.json` entry and every UUID child under `runs/`;
3. each `attempt.json`, `owner.json`, `exit.json`, pending `result.json`, and
   `needs-human.json`;
4. every recorded owner PID using both liveness and process-start identity.

Never remove an attempt, owner record, manifest entry, or uncertain occupancy
while its exact process may still be alive. Never discard an unprocessed result
or recorded answers. For an interrupted keyed migration, restart with the same
configuration first: Pan repairs its deterministic attempt automatically.

For a corrupt `attempts.json`, restore a known-good copy or reconstruct it only
from UUID attempt directories whose complete bindings all agree with the session
and Project item; include every such directory exactly once and select
`currentLaunchId` deliberately. An unexpected directory may be removed only
after its contents identify the same session, every possible owner is positively
dead, and its signals have been preserved or processed. If a malformed entry
cannot be attributed safely, leave it fail-closed rather than guessing.

An uncertain configured-legacy occupancy record may be removed only after the
named PID is positively dead or its current process-start identity and command
prove it is not the legacy Pan launcher. An uncertain attempt with a valid
terminal `exit.json` and no owner can be left for Pan to classify as dead; do
not fabricate ownership. As a last resort, delete an entire session root only
when all possible launchers are positively dead, no result/question is pending,
the Project item is paused and unclaimed (or permanently unbound from that
session), and losing its local resume state is acceptable. Restart Pan and
confirm one clean reconciliation before making the item dispatchable again.
