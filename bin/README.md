# pan-runner

`pan-runner` is the single program in the Pan system. One instance runs per
machine. It polls the Domain GitHub Project for **ready agent work** matching the
playbooks this machine runs, claims each task with a lease, and launches a
**headed `copilot` worker session** in a visible terminal window to do it. It
implements no task logic and verifies no deliverables — the
[playbook](../system/playbooks.md) and the Issue do that. See
[`system/runner.md`](../system/runner.md) for the full contract.

All GitHub access goes through the `gh` CLI (spawned with argv arrays, never
shell strings). No external npm dependencies; Node 22+ built-ins only, ESM.

## Usage

```sh
node bin/pan-runner.js --config <path-to-config.json> [--once] [--validate-config]
node bin/pan-runner.js --help
```

- `--config <path>` — path to the local JSON config (required).
- `--once` — run a single poll cycle, then supervise whatever it launched until
  those workers finish, then exit.
- `--validate-config` — validate the config **and** Domain access
  (every `playbooks/<machine>/<name>.md` in this machine's folder, and
  the Project), then exit `0`. This also validates the Project **schema**
  against the canonical contract in
  [`system/project-schema.md`](../system/project-schema.md): every canonical
  field must be present with the correct type, and every canonical single-select
  option must exist. Performs **no polling**. Exits non-zero with a clear
  message on any failure (missing/wrong-typed fields and missing options are all
  reported together).
- `--help` — print usage and exit `0`.

Without `--once` the runner loops until interrupted (`SIGINT`/`SIGTERM`),
draining active workers on shutdown.

**Startup schema check.** Every normal startup (not just `--validate-config`)
validates the Project metadata it already loads against the canonical
[`system/project-schema.md`](../system/project-schema.md) contract before it
polls, adding no extra GitHub round trip. If a canonical field or single-select
option is missing, the runner exits once, non-zero, with an actionable message
to open Pan chat, run the
[reconcile Project schema](../system/project-schema.md#reconciling-the-project-schema)
action, and restart — rather than looping on per-poll claim writes that fail
because the Project lacks a field. The runner never mutates the schema itself.

## Local config

The config is a small per-machine JSON file, written at onboarding. The Domain's
canonical data always lives in GitHub; this file only names the binding and local
launch preferences. See [`example-config.json`](example-config.json).

| Field | Required | Meaning |
| --- | --- | --- |
| `domainRepo` | yes | Domain repository as `owner/name`, e.g. `AmoebaChant/pan-domain`. |
| `project` | yes | Project as `<owner>/<number>`, e.g. `AmoebaChant/7`. |
| `machine` | yes | This machine's name; reads `playbooks/<machine>/*.md` from the Domain repo. |
| `identity` | yes | Stable runner identity string written to the `claimed-by` field. |
| `panCheckout` | yes | Absolute path to this Pan checkout, so workers get `system/` docs, agents, and skills. |
| `terminal` | no | `{ "kind": "macos-terminal" \| "windows-terminal" }`. Auto-detected by platform if omitted. |
| `copilotBin` | no | Command that starts a worker session. Default `copilot`. |
| `copilotArgs` | no | Extra args placed before the prompt argument. Default `[]`. |
| `nodeBin` | no | Node binary used to run the generated `.pan/launch.mjs`. Default `node`. |
| `pollIntervalSeconds` | no | Idle poll cadence. Default `30`. |
| `leaseMinutes` | no | Lease duration; renewed at one-third of this interval. Default `15`. |
| `maxConcurrent` | no | Optional global cap on concurrent workers. Default unlimited. |
| `workspaceRoot` | no | Root for the worker's isolated workspaces. Default `os.tmpdir()/pan-workspaces`. |

Per-playbook concurrency (`capacity`) and any `workingDirectory` come from each
`playbooks/<machine>/<name>.md` front matter in the Domain, **not** this file.
Changing playbooks in the Domain takes effect without editing local config;
changing local config requires restarting the runner.

A **fixed `workingDirectory`** should use **capacity 1**. That directory's
`.pan/` is shared, so two concurrent workers would clobber each other's signals
and task context. The runner therefore **refuses to run concurrent workers in
the same fixed directory**: if a claimed task resolves to a fixed
`workingDirectory` already in use by another active worker (whether from
`capacity > 1` on one playbook or two playbooks pointing at the same directory),
the runner returns that task to `ready` (clearing `claimed-by`/`lease-until`)
**without** counting an operational strike, so another cycle or runner can take
it later. Isolated workspaces are per-task unique and never collide.

When present, `pollIntervalSeconds` and `leaseMinutes` must be numbers greater
than `0` (they cannot be `null`; omit them to use the default), and
`maxConcurrent` must be an integer `>= 1` (or `null`/omitted for
unlimited); invalid values fail fast with a clear message. A playbook's
`workingDirectory` (from the playbook front matter) must be an absolute path.

Each `playbooks/<machine>/<name>.md` is validated strictly (during both
`--validate-config` and normal startup): its front matter must have a `name`
equal to the filename basename, a non-empty `description`, and a
**non-negative integer** `capacity` (`0` disables that playbook on this
machine). A missing/mismatched `name`, a missing/empty `description`, a
missing, non-numeric, fractional, or negative `capacity`, or a non-absolute
`workingDirectory` is a hard error. The machine's runnable set is exactly the
`.md` files in `playbooks/<machine>/`; an empty or missing folder is a hard
error.

### Note on temp directories

The worker's **isolated workspaces** under `workspaceRoot` (default
`os.tmpdir()/pan-workspaces`) are an intentional product feature — that is where
a playbook without a fixed `workingDirectory` gets a clean checkout. The runner
itself keeps **no** scratch, log, or state files under any temp directory.

## How a task flows

1. **Poll** — read the full Project item set (GraphQL cursor pagination),
   passively sweep expired, unsupervised `in-progress` items to `paused`, then
   select this machine's resumable `paused` items before new `ready` items. The
   sweep re-reads each stale item and changes only `Status`; active or malformed
   leases are untouched. A local item swept to `paused` is eligible in that
   same poll. Candidate work must have `owner=agent`, a non-empty `playbook`
   this machine runs, spare capacity (global and per-playbook), and a free
   lease. Order each group by `priority` (`urgent` > `high` > `normal` > `low`),
   preserving Project order among ties.
2. **Claim or resume** — re-read the item to avoid races, then set `claimed-by`,
   `machine` (this machine's name), `lease-until` (near-future UTC), and
   `Status=in-progress`.
   Immediately after writing, the runner **re-reads once more to confirm** it
   still owns the claim (`claimed-by` is still this runner and `lease-until` is
   exactly the value it wrote); if another runner won the race, it abandons the
   item **without overwriting** the winner's fields. This is best-effort optimistic
   concurrency (GitHub has no atomic compare-and-swap); the confirming re-read is
   the point. The lease is renewed periodically while the worker runs.
3. **Launch** — prepare the working directory (fixed `workingDirectory` if set,
   else an isolated workspace under `workspaceRoot` whose path is stable for the
   recorded Copilot session), write the task context into `.pan/`, and open a
   headed `copilot` session in a visible terminal window under
   an explicit copilot session id (`--session-id`), recording that id in the
   Issue's `session-id` field. A fresh UUID is minted for a new task; a paused
   task carrying a `session-id` recorded for this same `machine` is relaunched
   in the same workspace with that id so Copilot **resumes** the earlier
   session. If
   the resolved directory is a fixed `workingDirectory` already in use by another
   active worker, the runner does **not** launch: it returns the task to `ready`
   (a benign capacity collision, not an operational strike).
4. **Supervise** — watch the `.pan/` signal files and relay them to the Issue.

While the runner is looping, **Enter** or **Space** queues an immediate ordinary
poll. The request remains pending even when the key is pressed during polling
or supervision rather than during the idle sleep.

### `.pan/` file contract

Written by the runner before launch:

- `.pan/task.json` —
  `{ itemId, number, title, body, url, repo, playbook, workstream, answers }`.
  `itemId` keys runner state because Issue numbers are repository-local.
- `.pan/playbook.md` — the chosen playbook's instructions (fetched from the Domain).
- `.pan/launch-prompt.txt` — the initial prompt handed to `copilot`.
- `.pan/launch.mjs` — a generated Node launcher (ESM). Run with its CWD set to
  the working directory, it passes the prompt to `copilot` as a single argv
  element (no shell ever re-parses the prompt on any platform), maintains the
  liveness marker below, and runs a **title watchdog** that periodically
  re-asserts the worker's task title on the terminal. `copilot` rewrites the
  window title (`OSC 0`) repeatedly during a session with its own AI-generated
  summary — which overrides any terminal-side "custom title" — so the launcher
  keeps re-emitting the stable `#<number> <title>` so each worker window stays
  identifiable (a brief flicker to copilot's title can appear right after each of
  its infrequent updates). The launcher also watches for `.pan/worker.stop`
  (below) and, on that signal, stops `copilot` and closes its own terminal
  window (on macOS via Terminal.app matched by tty; on Windows by exiting 0 so
  Windows Terminal auto-closes the tab).

Written by the worker:

- `.pan/needs-human.json` — presence means the worker needs the user
  (`{ question, since }`). While present, the runner sets the Issue's
  `needs-human-since` and posts a comment with the question; when the worker
  deletes it, the runner clears `needs-human-since`. If the file is present but
  cannot be parsed yet or has no usable `question` (a partial write in progress),
  the runner does **nothing** — it neither sets `needs-human-since` nor posts a
  comment — and retries parsing on the next supervise tick, so a half-written
  signal never posts a placeholder question.
- `.pan/result.json` — `{ outcome: "done" | "needs-review", summary, details }`,
  written once when finished. The runner records it on the Issue and moves the
  Project item to `done` or `in-review`. For `done`, it closes and re-reads the
  Issue before committing the Project status. Only the exact outcomes `done`
  and `needs-review` are accepted; a missing, misspelled, or otherwise invalid
  outcome does **not** default to `done` — the runner logs the problem and
  leaves the worker active (retried each tick). An invalid or unreadable
  `result.json` does **not** disable supervision: the runner keeps supervising
  that worker the same tick (human-attention relay, liveness check, and lease
  renewal all continue) so the worker can correct its result without the task
  stalling.
  Completion comments carry a durable marker so retries do not duplicate them.
  Finalization retries use backoff without consuming worker capacity. Three
  failures before the terminal Status is committed move the task to `blocked`
  with a durable Issue comment. Partial terminal lease cleanup keeps retrying
  and is independently repaired by each poll. The runner does not set
  `needs-human-since` for either path because the finished worker is no longer
  waiting at its terminal.
  Rehydration recognizes pending results whose `done` or `in-review` Status was
  committed before a crash, as well as this runner's partial `blocked`
  escalation, and finishes cleanup plus `worker.stop` instead of orphaning a
  live terminal.

Written by the runner after finalizing:

- `.pan/worker.stop` — written once the runner has recorded a worker's
  `result.json` on the Issue and updated the Project (for `done` or
  `needs-review`). Its presence tells the launcher the task is finished, so the
  worker session shuts down and closes its terminal window instead of lingering.
  It is not written while a worker is merely paused on `needs-human.json`.

Before each launch or resume the runner clears any stale `.pan/` signal files
(`result.json`, `needs-human.json`, `worker.running`, `worker.pid`,
`worker.stop`) so a reused fixed `workingDirectory` cannot make a new task
finalize on a prior task's signals.

Internal liveness marker: `.pan/worker.running` is created by the Node launcher
(`.pan/launch.mjs`) and removed when the worker process exits — including on
window-close signals (`SIGINT`/`SIGTERM`/`SIGHUP`) — on both platforms, so the
runner can detect a closed terminal or vanished worker.

## Failure handling

Closing or losing a worker releases its lease and moves the started task to
`paused`, preserving `machine`, `session-id`, and its isolated workspace for
resume. An operational launch failure restores the pre-launch state: a new task
returns to `ready`, while a failed resume remains `paused`. **Three
consecutive** operational failures on the same task instead raise human
attention: the runner clears the lease, sets `needs-human-since`, moves the item
to `blocked`, and posts an explanatory Issue comment, so an unattended runner
cannot retry forever.
At lease-renewal cadence the runner re-reads the item and, if the claim is no
longer its own (`claimed-by`/`Status` changed out from under it — a **lost
lease**), it stops supervising that worker and writes **nothing**: it no longer
owns the item, so it never clears or overwrites fields another runner may now
hold. A lost lease still counts toward the three-strike streak, but even at the
third strike it writes no fields while it does not own the item.

`SIGINT`/`SIGTERM` drains: the runner stops claiming new work, keeps supervising
and renewing leases for active workers until they finish, then exits. An
interrupt **promptly wakes** the runner from its idle/backoff sleep (the wait is
abortable) so shutdown is not delayed. Workers run in their own terminals and are
unaffected; a second interrupt exits immediately.

## Project fields

The runner reads and writes exactly the fields defined in
[`system/project-schema.md`](../system/project-schema.md); that table is the
single source of truth for their names, types, and single-select options. Empty
selects read as their documented defaults. Field ids and single-select option
ids are resolved from the Project once via GraphQL (paged when the Project has
more than one page of fields) and cached for the process lifetime; writes use
`gh project item-edit`.

## Known limitations / TODOs (v1)

- **PR merge confirmation.** For `outcome: "done"` the runner does **not** yet
  independently confirm that a pull request merged before setting `Status=done`;
  it trusts the worker's `result.json` and notes this in the Issue comment.
  `runner.md` calls for confirming the merge from GitHub first.
- **Rehydration is best-effort.** On restart the runner re-adopts surviving
  workers by scanning `workspaceRoot` for isolated workspaces whose Project item
  is still `claimed-by` this runner. A workspace that already holds a
  `.pan/result.json` (a result produced while the runner was down) is **adopted
  and finalized** through the normal result path rather than dropped. A workspace
  is treated as alive only when its liveness marker is present **and** its
  recorded PID (`.pan/worker.pid`) is a live process (`process.kill(pid, 0)`); a
  missing marker, or a marker whose PID is dead/missing/unparseable, is a
  stopped worker, and if its item is still `claimed-by` this runner and
  `in-progress` it is released to `paused` (clearing
  `claimed-by`/`lease-until`) while retaining the workspace for resume — the
  runner never renews the lease of a dead PID forever. Workers launched into a
  **fixed `workingDirectory`** are not rediscovered (there is no persisted
  registry of launched handles), but their expired Project leases are swept to
  `paused` during polling and the owning machine can relaunch them in that fixed
  directory. The exact child process for an isolated workspace is not
  re-attached — only file-signal supervision and lease renewal resume. A paused
  isolated workspace remains discoverable across runner restarts. An isolated
  workspace that is **inert** — no live worker and no
  longer this runner's to supervise (finalized, released, missing from the
  Project, or externally transitioned) — has its directory **pruned** during
  rehydration, so finished workspaces do not accumulate under `workspaceRoot` and
  get re-scanned and re-logged on every restart. Only workspaces confirmed inert
  are removed; a live or still-owned-and-adoptable workspace is never touched.
- **A hard kill can leave the liveness marker.** Both platforms launch the
  worker through the generated `.pan/launch.mjs`, whose signal handlers remove
  `.pan/worker.running` on window close (`SIGINT`/`SIGTERM`/`SIGHUP`) and on
  normal exit. A **hard** kill (`SIGKILL` / force terminate) cannot run those
  handlers, so the marker may linger; the runner's rehydration pause and
  liveness grace still recover a truly-gone worker.
- **`copilot` invocation.** The worker is started as
  `<copilotBin> [copilotArgs...] <prompt>` by `.pan/launch.mjs`, passing the
  prompt as a single positional argv element (never re-parsed by any shell).
  Current `copilot` builds do **not** accept a bare positional prompt (they fail
  with `too many arguments`); they seed an interactive session with
  `-i/--interactive <prompt>`. So `copilotArgs` should end with `--interactive`
  (e.g. `["--allow-all", "--interactive"]`) — the runner appends the prompt as
  its value. Adjust `copilotBin`/`copilotArgs` if your build seeds a session
  differently.
- **Recorded answers.** `.pan/task.json` currently ships an empty `answers`
  array; there is no durable answer store yet, so answers arrive live in the
  worker's terminal.
