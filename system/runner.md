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

Regardless of `workerPermissions`, the runner pre-authorizes each worker's
workspace folder before launch by adding it to copilot's `trustedFolders`
(`~/.copilot/config.json`, overridable via `copilotConfigPath`). copilot's
`--allow-all` covers tools, paths, and URLs but not the separate per-folder
trust gate. Each newly started task gets its own temporary directory and later
resumes reuse it; without this step every worker would stop on an interactive
"trust this folder?" prompt. The write is best-effort — on any failure the
worker simply falls back to prompting.

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
2. **Sweep stale running tasks to `paused`.** For every item with
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
unleased, then set `claimed-by` to this runner, `machine` to this machine's
name, `lease-until` to a near-future UTC time, and `Status` to `in-progress`.
Renew `lease-until` periodically while the worker runs. If a claim races with
another runner (the re-read shows it already claimed), skip it.

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

For a claimed task the runner:

1. Prepares the working directory. If the playbook's `workingDirectory` is set,
   launch there and prepare no workspace. If the playbook declares
   `workspaceSlots`, launch in the chosen slot's directory (see [workspace
   slots](#workspace-slots)). Otherwise create an isolated workspace whose path
   is stable for the task's local Copilot session. A resumed task reopens that
   same directory; it never creates a replacement workspace.
2. Writes the task context into a `.pan/` directory the worker will read (see
   the [file contract](#worker-file-contract)).
3. Launches a **headed** `copilot` session in a visible terminal window, with an
   initial prompt that tells the worker to follow
   [`system/worker-base-instructions.md`](worker-base-instructions.md), its
   playbook, and the task context in `.pan/`. The session runs under an explicit
   copilot session id (`copilot --session-id <id>`); the runner records that id
   in the Issue's `session-id` field so the work can be resumed or revisited
   later. On the first launch it mints a fresh UUID; on a re-launch of a task
   that already carries a `session-id` recorded for this same `machine`, it
   reuses that id so copilot resumes the earlier session rather than starting
   over. copilot sessions are local to a machine, so a `session-id` recorded for
   a different machine is never reused.
4. Watches `.pan/` for the human-attention and result signals below, and renews
   the lease while the worker runs.

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

The runner and worker communicate through files in the `.pan/` directory inside
the worker's working directory.

**Runner → worker (written before launch):**

- `.pan/task.json` — the task: Project item id; Issue number, title, body, URL,
  and repository; chosen `playbook`; optional `workstream`; and any recorded
  answers. Read-only to the worker. The Project item id is the runner's
  canonical identity because Issue numbers are repository-local.

**Worker → runner:**

- `.pan/needs-human.json` — **presence means the worker needs the user.** The
  worker writes it with `{ "question": "…", "since": "<RFC3339 UTC>" }` when it
  needs an answer, and **deletes** it once its question is resolved. While the
  file exists, the runner sets the Issue's `needs-human-since` (and posts a
  comment with the question); when the file is removed, the runner clears
  `needs-human-since`. The worker keeps its lease and slot the whole time.
- `.pan/result.json` — written once when the worker finishes:
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
  After a runner restart, an isolated workspace with a pending result and a
  matching `done` or `in-review` Status (or this runner's `blocked` escalation)
  is re-adopted long enough to confirm cleanup and write `worker.stop`; it is
  not mistaken for an unrelated manual transition.

**Runner → worker (written after finalizing):**

- `.pan/worker.stop` — **presence means the task is finalized; the worker should
  shut down and close its window.** Once the runner has recorded a worker's
  `result.json` on the Issue and updated the Project (for either outcome), it
  writes this file. The worker session then stops and closes its own terminal
  window so finished worker windows do not pile up. On macOS the launcher runs
  in place of the login shell (via `exec`), so once it exits the terminal tab
  has no running process and Terminal.app closes it silently — without its "Do
  you want to terminate running processes in this window?" prompt. This fires
  only on completion — a worker paused on `needs-human.json` keeps its window
  open for the user to answer in.

## Human-attention relay

`needs-human-since` on the Issue is the single signal that a human is needed. It
is set from the presence of `.pan/needs-human.json` and cleared when that file
is removed. A worker waiting for the user stays alive, holds its lease and its
concurrency slot, and spends no budget until answered. Because the runner
launches workers with `--deny-tool ask_user`, this file is a worker's only way
to reach the user; a worker cannot instead pop an interactive `ask_user`
prompt that the runner would never surface as `needs-human-since`. `Status` stays
`in-progress`; the user answers in that worker's terminal, the worker clears its
file, and the runner clears the Issue field. A future notification system will
alert the user when `needs-human-since` is set.

## Lease-driven resume

Recovery of a started task is driven by the lease at poll time, not by scanning
the filesystem and not only at startup. It replaces the earlier startup-only,
workspace-scanning `rehydrate()` recovery.

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
2. Reuses the local workspace the task ran in and relaunches copilot with the
   recorded `session-id`, so the worker picks up the earlier session's
   transcript and state instead of starting over. A `session-id` recorded for a
   different machine is never reused.
3. Sets `Status=in-progress`, a fresh `lease-until`, and `claimed-by` to this
   runner, and **clears `needs-human-since`**. A human-attention question is not
   a recovery input; if it still stands the worker re-raises it, and because it
   is surfaced on the Issue the user sees it wherever it resumes.

If the runner restarts while a worker is still alive, it re-adopts that live
worker against its saved `.pan/` context and resumes lease renewal and signal
watching. A worker it cannot verify as alive is not duplicated; its task simply
shows up as `paused` (once its lease has expired or the runner releases it) and
is resumed through the normal poll-time path above.

### Workspace hygiene

A runner-created isolated workspace whose task is no longer this runner's to
supervise — finalized, released to `ready`, missing from the Project, or
externally transitioned — and which has no live worker and is not a paused task
pinned to this machine awaiting resume, is **inert**, and the runner removes its
directory. Without this, finished workspaces pile up under the workspace root.
Only workspaces confirmed inert are removed; a workspace with a live worker, or
one holding a paused task this machine will resume, is never touched.
