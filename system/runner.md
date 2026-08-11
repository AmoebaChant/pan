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
  confirm each tool). A raw `copilotArgs` escape hatch is still appended after
  the derived permission flags for anything not expressed by this setting;
- terminal settings for launching a visible worker window (Windows Terminal on
  Windows, Terminal.app on macOS).

Regardless of `workerPermissions`, the runner pre-authorizes each worker's
workspace folder before launch by adding it to copilot's `trustedFolders`
(`~/.copilot/config.json`, overridable via `copilotConfigPath`). copilot's
`--allow-all` covers tools, paths, and URLs but not the separate per-folder
trust gate, and each worker runs in a fresh temporary directory; without this
step every worker would stop on an interactive "trust this folder?" prompt. The
write is best-effort — on any failure the worker simply falls back to prompting.

Each worker window is given a stable, human-readable title (`#<number> <short
title>`) so the user can tell at a glance which task each spawned window is
working on. On macOS this is pinned as a Terminal.app custom title; on Windows
via `--title`/`--suppressApplicationTitle`.

The runner re-reads the `playbooks/<machine>/` folder and every
`playbooks/<machine>/<name>.md` from GitHub each cycle, so playbook changes take
effect without editing local config. Local config changes require restarting the
runner.

## Poll cycle

Each cycle:

1. Read ready agent work from the Project: items with `owner=agent`,
   `Status=ready`, and a non-empty `playbook` (the [dispatch
   rule](project-schema.md#dispatch-rule)). Read the full item set; do not stop
   at a default page.
2. Keep only items whose `playbook` names a playbook in this machine's
   `playbooks/<machine>/` folder with spare capacity (global and per-playbook),
   and whose lease is free (`lease-until` empty or in the past, or `claimed-by`
   is this runner).
3. Order by `priority` (`urgent` > `high` > `normal` > `low`), preserving
   Project order among ties. Claim from the top while capacity remains.
4. **Resume this machine's paused tasks.** For items with `Status=paused` and
   `machine` equal to this machine, resume them (see [resume](#lease-driven-resume)),
   subject to the same capacity limits, before or alongside claiming new `ready`
   work. Paused tasks pinned to another machine are left untouched.
5. **Sweep stale running tasks to `paused`.** For any item that is
   `in-progress` with an expired lease that this runner is not itself
   supervising, flip it to `paused` (see [the paused sweep](project-schema.md#the-paused-sweep-documented-non-owner-write)).
   This is a safe, visibility-only write.
6. Back off when idle, and handle GitHub rate limits with bounded retries.

`--once` runs a single cycle and then supervises whatever it launched;
otherwise the runner loops until interrupted (SIGINT/SIGTERM), draining active
workers on shutdown.

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

An operational failure that is not a crash — launch failed, terminal could not
open — returns the item to `ready` with its state intact (clear
`claimed-by`/`lease-until`, set `Status=ready`); it is not human attention.
Repeated operational failures on the same task (three in a row) should instead
raise human attention so an unattended runner cannot retry forever.

## Launching a worker

For a claimed task the runner:

1. Prepares the working directory. If the playbook's `workingDirectory` is set,
   launch there and prepare no workspace. Otherwise create an isolated workspace
   as the playbook instructs.
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

## Worker file contract

The runner and worker communicate through files in the `.pan/` directory inside
the worker's working directory.

**Runner → worker (written before launch):**

- `.pan/task.json` — the task: Issue number, title, body, URL, chosen
  `playbook`, optional `workstream`, and any recorded answers. Read-only to the
  worker.

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
  sets `done` it also closes the Issue as completed, per the
  [project schema](project-schema.md) (`done` and a closed Issue go together).
  For
  pull-request work, the runner should confirm the merge from GitHub before
  setting `done`; in the current implementation this merge confirmation is
  best-effort and not yet enforced — a playbook that must not auto-complete
  before merge should report `needs-review` rather than `done`. A **cross-repo**
  PR (its Issue in the Domain repository, its PR in another) cannot be confirmed
  this way at all, since GitHub links neither the PR nor the merge back to the
  Issue; such a task stays `in-review` until [triage](triage.md) reconciles the
  merge from the PR link the worker recorded on the Issue.

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
concurrency slot, and spends no budget until answered. `Status` stays
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
resumes only items where `machine` equals this machine and `Status` is `paused`.

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
