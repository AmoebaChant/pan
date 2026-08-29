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
| `nodeBin` | no | Node binary used to run the generated `launch.mjs` in the session state directory. Default `node`. |
| `pollIntervalSeconds` | no | Idle poll cadence. Default `30`. |
| `leaseMinutes` | no | Lease duration; renewed at one-third of this interval. Default `15`. |
| `maxConcurrent` | no | Optional global cap on concurrent workers. Default unlimited. |
| `workspaceRoot` | no | Root for per-session state directories (and, for isolated playbooks, the worker workspace). Resolved to an absolute path, and **must be outside every fixed `workingDirectory` and `workspaceSlots` path** (the runner refuses to launch otherwise, so Pan's `.pan/` can never land inside a repository). Default `os.tmpdir()/pan-workspaces`. |

Per-playbook concurrency (`capacity`) and any `workingDirectory` come from each
`playbooks/<machine>/<name>.md` front matter in the Domain, **not** this file.
Changing playbooks in the Domain takes effect without editing local config;
changing local config requires restarting the runner.

A **fixed `workingDirectory`** should use **capacity 1**. It is a real in-place
checkout shared by every task of that playbook (Pan's own state lives elsewhere,
under `workspaceRoot`, never inside it). Two concurrent workers in the same
checkout would collide on the working tree, so the runner **refuses to run
concurrent workers in the same fixed directory**: if a claimed task resolves to a
fixed `workingDirectory` already in use by another active worker (whether from
`capacity > 1` on one playbook or two playbooks pointing at the same directory),
the runner returns that task to `ready` (clearing `claimed-by`/`lease-until`)
**without** counting an operational strike, so another cycle or runner can take
it later. Isolated tasks each get their own session directory and never collide.

A playbook may instead declare **`workspaceSlots`** — a mapping of named slot
ids to absolute paths, mutually exclusive with `workingDirectory` — to pool work
across a fixed set of reusable directories, one task per slot. Its `capacity`
may not exceed the slot count. The chosen slot is recorded as a composite
`<machine>::<slot>` value in the `machine` field, so a paused slot-pooled task
resumes in the exact slot it ran in; new work takes the first free slot. Each
poll derives the slots occupied on this physical machine from this runner's own
active workers (finalization-pending included) and from live Project items that
are `in-progress` with a composite affinity for this machine and a non-expired
lease (a malformed lease fails closed; an expired one frees the slot). This
matches Pan's **one-runner-per-machine** contract and needs no process, PID, or
filesystem rehydration; the same-resolved-directory active-worker guard is the
final backstop. A physical machine name in config may not contain `::`.

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
`workingDirectory` is a hard error. For a playbook with `workspaceSlots`,
setting `workingDirectory` too, a declared-but-empty mapping, a non-simple slot
id or one containing `::`, a non-absolute slot path, duplicate slot ids or
paths, or a `capacity` above the slot count are all hard errors. The machine's
runnable set is exactly the `.md` files in `playbooks/<machine>/`; an empty or
missing folder is a hard error.

### Note on temp directories

Every launched task gets a **per-session state directory** under `workspaceRoot`
(default `os.tmpdir()/pan-workspaces`, named `pan-<number>-<sessionId>`) that
holds all Pan-owned control and signal files (its `.pan/`). For a playbook with a
fixed `workingDirectory` or `workspaceSlots`, the worker runs in that real
checkout while its Pan state stays under `workspaceRoot` — never inside the
repository. For a playbook with neither, that session directory is also where the
worker gets its clean checkout. The runner keeps **no** other scratch, log, or
state files of its own on disk.

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
   `machine` (this machine's name, or a composite `<machine>::<slot>` for a
   slot-pooled playbook), `lease-until` (near-future UTC), and
   `Status=in-progress`.
   Immediately after writing, the runner **re-reads once more to confirm** it
   still owns the claim (`claimed-by`, `lease-until`, and `machine` are exactly
   the values it wrote and `Status` is `in-progress`); if another runner won the
   race, it abandons the item **without overwriting** the winner's fields. This
   is best-effort optimistic concurrency (GitHub has no atomic
   compare-and-swap); the confirming re-read is the point. The lease is renewed
   periodically while the worker runs.
3. **Launch** — resolve the session state directory (always under
   `workspaceRoot`, holding `.pan/`) and the working directory (a fixed
   `workingDirectory`, the chosen `workspaceSlots` slot, else the session
   directory itself for an isolated task), refresh `.pan/task.json` from the
   current Issue body and complete comment history, and open a headed `copilot`
   session in a visible terminal window under an explicit session id
   (`--session-id`), recording that id in the Issue's `session-id` field. The
   launcher runs with its CWD set to the working
   directory but addresses every control/signal file by its absolute path in the
   state directory, and copilot is granted access to that directory with
   `--add-dir`, so a fixed/slot repository never gains a `.pan/`. A fresh UUID is
   minted for new work; a compatible recorded id is reused on later launches,
   including review follow-up returned to `ready`. If the resolved working
   directory is a fixed `workingDirectory` or slot already in use by
   another active worker, the runner does **not** launch: it returns the task to
   `ready`/`paused` (a benign capacity collision, not an operational strike).
4. **Supervise** — watch the `.pan/` signal files and relay them to the Issue.

While the runner is looping, **Enter** or **Space** queues an immediate ordinary
poll. The request remains pending even when the key is pressed during polling
or supervision rather than during the idle sleep.

### `.pan/` file contract

The `.pan/` directory lives inside the task's **session state directory** under
`workspaceRoot`, not inside the repository (except for an isolated task, whose
working directory *is* the session directory). The worker is given its absolute
path in the launch prompt and in the `PAN_STATE_DIR` environment variable
(`PAN_WORKING_DIRECTORY` names its working directory).

Written by the runner before launch:

- `.pan/task.json` —
  `{ itemId, number, title, body, comments, url, repo, playbook, workstream, answers }`.
  `comments` contains the complete chronological Issue history as
  `{ author, timestamp, url, body }` entries. The runner refreshes Issue content
  before every launch and retains existing structured answers.
  `itemId` keys runner state because Issue numbers are repository-local.
- `.pan/launch.json` — runner-owned launch metadata **and ownership marker**
  `{ panRunner, version, machine, identity, itemId, number, sessionId, isolated, workingDir, slot }`
  (not part of the worker contract). Rehydration reads it to re-adopt a worker
  and supervise it against the correct working directory when that directory is
  not the session state directory. It is worker-writable, so it is treated as
  ownership/corruption **evidence, not authentication**, and every check fails
  closed: absence (a genuinely missing `launch.json` — only an `ENOENT` read,
  never a directory-in-its-place or an access/I/O error, which are treated as
  present-and-invalid) is the legacy-isolated compatibility path, but a marker
  that is **present** must be a *complete, matching* runner marker — the
  `panRunner` tag and `version`, this `machine` **and** `identity`, the exact
  `itemId`, `number`, and `sessionId`, and a well-formed workspace kind/slot —
  before the runner will
  adopt, finalize, resume, or delete that root. A foreign-machine, wrong-version,
  malformed, or otherwise mismatched marker authorizes nothing (a matching
  `pan-<number>-<sessionId>` name plus a `.pan/task.json` alone is never proof).
- `.pan/playbook.md` — the chosen playbook's instructions (fetched from the Domain).
- `.pan/launch-prompt.txt` — the initial prompt handed to `copilot`.
- `.pan/launch.mjs` — a generated Node launcher (ESM). Run with its CWD set to
  the working directory, it addresses every control/signal file by its absolute
  path under the state directory (so a fixed/slot repository never gains a
  `.pan/`), passes the prompt to `copilot` as a single argv element (no shell
  ever re-parses the prompt on any platform), grants `copilot` access to the
  state directory with `--add-dir`, exports `PAN_STATE_DIR`/`PAN_WORKING_DIRECTORY`,
  maintains the liveness marker below, and runs a **title watchdog** that
  periodically re-asserts the worker's task title on the terminal. `copilot`
  rewrites the window title (`OSC 0`) repeatedly during a session with its own
  AI-generated summary — which overrides any terminal-side "custom title" — so
  the launcher keeps re-emitting the stable `#<number> <title>` so each worker
  window stays identifiable (a brief flicker to copilot's title can appear right
  after each of its infrequent updates). The launcher also watches for
  `.pan/worker.stop` (below) and, on that signal, stops `copilot` and closes its
  own terminal window (on macOS via Terminal.app matched by tty; on Windows by
  exiting 0 so Windows Terminal auto-closes the tab).

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

Before each launch the runner clears any stale `.pan/` signal files
(`result.json`, `needs-human.json`, `worker.running`, `worker.pid`,
`worker.stop`) in the session state directory. A new task always gets a fresh
state directory, so this mainly matters on resume (a reused state directory could
still carry a dead worker's liveness/pid markers). **A resume is the exception
for `result.json`:** if the state directory still holds an unprocessed
`result.json`, the worker finished but was never finalized, so the runner
**refuses the resume and preserves the result** (leaving the task `paused` for
the next rehydration to finalize) rather than clearing it and losing the outcome.
Stale liveness/attention markers are still cleared as appropriate.

Internal liveness marker: `.pan/worker.running` is created by the Node launcher
(`launch.mjs`) and removed when the worker process exits — including on
window-close signals (`SIGINT`/`SIGTERM`/`SIGHUP`) — on both platforms, so the
runner can detect a closed terminal or vanished worker.

## Failure handling

Closing or losing a worker releases its lease and moves the started task to
`paused`, preserving `machine`, `session-id`, and its session state directory
(and, for an isolated task, its workspace) for resume. An operational launch
failure restores the pre-launch state: a new task returns to `ready`, while a
failed resume remains `paused`. **Three consecutive** operational failures on the
same task instead raise human
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
  workers by scanning `workspaceRoot` for per-session state roots whose Project
  item is still `claimed-by` this runner. Because every task — isolated, fixed
  `workingDirectory`, or slot-pooled — now has a state root under `workspaceRoot`,
  all three are rediscovered here; each root's `.pan/launch.json` records the real
  working directory and mode, and a legacy root without it is treated as isolated.
  **Every adoption, finalization, or deletion requires exact agreement across
  four sources — the canonical root name `pan-<issue>-<minted session UUID>`, its
  `task.json`, its `launch.json`, and the live Project item — on issue number,
  item id, base machine, (critically) `session-id`, and — for a slot-pooled
  session — the composite slot **and the saved checkout path** (the current
  playbook must still be slot-pooled and map that exact slot id to the same
  directory the marker recorded), so an established session is never moved
  between slot checkouts even if a slot id is remapped.** So a *stale* session-A
  root can never act on the item now
  running session B: a mismatched or non-canonical root is left untouched (its
  result preserved, never finalized or deleted). The `launch.json` marker is
  worker-writable, so it counts only as corruption/ownership evidence and every
  check fails closed: an **absent** marker is the legacy-isolated compatibility
  path, but a **present** marker must be a complete, matching runner marker (tag,
  version, this machine and identity, the exact tuple, and workspace kind/slot) or
  it authorizes nothing — a foreign-machine or malformed marker is preserved but
  never adopted, finalized, or deleted. Each session root is also `lstat`-checked:
  a symlink or Windows junction is never followed for a read, write, or removal,
  and a root that does not resolve to a real direct child of `workspaceRoot` is
  ignored. A root that holds a `.pan/result.json` (produced while the runner was
  down) is processed **before** any paused handling and **finalized** only when it
  binds to the current session AND is this runner's finished worker: a passive
  lease sweep leaves our claim and expires the lease, so finalization requires our
  **surviving claim plus an expired/missing lease** (an *unclaimed* paused item is
  an ambiguous/manual pause and is never finalized). `finalize` re-reads the item
  immediately before any Issue or Project write and re-validates the exact
  session-id, machine/slot affinity, and (for a swept finalization) the still-
  paused, still-claimed, still-lapsed state, so a startup snapshot can never
  authorize a write onto drifted state. Any result that does not qualify is left
  untouched, never deleted, and if a launcher is still alive its directory is
  reserved. A
  root is treated as alive only when its liveness marker is present **and** its
  recorded PID (`.pan/worker.pid`) is a live process (`process.kill(pid, 0)`); a
  missing marker, or a marker whose PID is dead/missing/unparseable, is a stopped
  worker, and if its item is still `claimed-by` this runner and `in-progress` it
  is released to `paused` (clearing `claimed-by`/`lease-until`) while retaining
  the state root for resume — the runner never renews the lease of a dead PID
  forever. A **live** worker always keeps its fixed/slot working directory
  reserved so no duplicate worker launches into it. It is only (re-)adopted for
  supervision after an **immediate re-read** confirms it is still ours — already
  `in-progress`+ours, or the exact passive-sweep state (`paused`, our claim, an
  expired lease) which is restored with a fresh claim/lease/`in-progress` and a
  **confirming re-read** validating status/claim/machine/session/lease. On any
  read/write/confirmation failure or mismatch — including a concurrent transition
  or a foreign claim — the worker is reserved occupancy-only rather than adopted,
  so newer Project state is never overwritten. The exact child process is not
  re-attached — only file-signal supervision and lease renewal resume. A paused
  state root remains discoverable across runner restarts, as does a bound
  `in-review` or `ready` root that may be relaunched. A state root that is
  **inert** — no live worker and no longer this runner's to supervise (finalized,
  released, missing from the Project, or externally transitioned) — is **pruned**
  during rehydration, so finished roots do not accumulate under `workspaceRoot`
  and get re-scanned and re-logged on every restart. Pruning only ever removes the
  state root; a fixed/slot repository (its recorded working directory) is never
  touched. Deletion is **fail-closed on ownership**: the target is re-derived from
  `workspaceRoot` and the canonical name (never a worker-writable field) and
  removed only when the `.pan/launch.json` marker validates this `machine`, the
  exact name session id, and the task — so an unmarked or legacy root is preserved
  (and may still be adopted), never deleted by name and `task.json` alone.
  Rehydration also only treats a directory that parses to `pan-<issue>-<minted
  UUID>` as a session root, so a checkout a user placed under `workspaceRoot`
  (even one carrying a legacy `.pan/`) is never scanned or pruned. A task whose
  `.pan/` was written into a repository by a runner predating this state
  separation is not under `workspaceRoot` and is not rediscovered, but its expired
  Project lease is still swept to `paused` during
  polling and the owning machine can relaunch it. A resumed `session-id` (read
  back from the Project) must match the exact UUID shape the runner mints before
  it is used to build any path, so a tampered value can neither escape
  `workspaceRoot` nor alias another session's root.
- **A hard kill can leave the liveness marker.** Both platforms launch the
  worker through the generated `launch.mjs`, whose signal handlers remove
  `worker.running` (in the state directory) on window close
  (`SIGINT`/`SIGTERM`/`SIGHUP`) and on normal exit. A **hard** kill (`SIGKILL` /
  force terminate) cannot run those handlers, so the marker may linger; the
  runner's rehydration pause and liveness grace still recover a truly-gone worker.
- **`copilot` invocation.** The worker is started as
  `<copilotBin> [copilotArgs...] <prompt>` by the generated `launch.mjs`, passing
  the prompt as a single positional argv element (never re-parsed by any shell).
  Current `copilot` builds do **not** accept a bare positional prompt (they fail
  with `too many arguments`); they seed an interactive session with
  `-i/--interactive <prompt>`. So `copilotArgs` should end with `--interactive`
  (e.g. `["--allow-all", "--interactive"]`) — the runner appends the prompt as
  its value. Adjust `copilotBin`/`copilotArgs` if your build seeds a session
  differently.
- **Recorded answers.** A first launch starts with an empty `answers` array.
  Later launches retain any structured answers already in `.pan/task.json`.
