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
- terminal settings for launching a visible worker window (Windows Terminal on
  Windows, Terminal.app on macOS).

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
4. Back off when idle, and handle GitHub rate limits with bounded retries.

`--once` runs a single cycle and then supervises whatever it launched;
otherwise the runner loops until interrupted (SIGINT/SIGTERM), draining active
workers on shutdown.

## Claiming (leases)

To claim an item, re-read it, confirm it is still dispatchable and unleased,
then set `claimed-by` to this runner, `lease-until` to a near-future UTC time,
and `Status` to `in-progress`. Renew `lease-until` periodically while the worker
runs. If a claim races with another runner (the re-read shows it already
claimed), skip it.

An operational failure — terminal closed, launch failed, lease lost, worker
vanished — returns the item to `ready` with its state intact (clear
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
   playbook, and the task context in `.pan/`.
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
  to `done` (outcome `done`) or `in-review` (outcome `needs-review`). For
  pull-request work, the runner should confirm the merge from GitHub before
  setting `done`; in the current implementation this merge confirmation is
  best-effort and not yet enforced — a playbook that must not auto-complete
  before merge should report `needs-review` rather than `done`.

## Human-attention relay

`needs-human-since` on the Issue is the single signal that a human is needed. It
is set from the presence of `.pan/needs-human.json` and cleared when that file
is removed. A worker waiting for the user stays alive, holds its lease and its
concurrency slot, and spends no budget until answered. `Status` stays
`in-progress`; the user answers in that worker's terminal, the worker clears its
file, and the runner clears the Issue field. A future notification system will
alert the user when `needs-human-since` is set.

## Restart and rehydration

If the runner restarts while a worker survives, it re-adopts that worker against
its saved `.pan/` context and resumes lease renewal and signal watching before
polling for new work. A task waiting on the user is only ever rehydrated on the
machine that asked, so the question is re-posed in a terminal the user can
reach. A worker that cannot be verified is left alone rather than duplicated; a
worker that is truly gone releases its task back to `ready`.

In the current implementation re-adoption is best-effort: it rediscovers workers
in runner-created isolated workspaces by process liveness. A worker launched in
a playbook's fixed `workingDirectory` is not yet rediscovered across a runner
restart; until it is, its lease simply expires and the task returns to `ready`
for a normal, resumable re-claim.
