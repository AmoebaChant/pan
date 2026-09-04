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
| `stateRoot` | no | Durable authoritative session/runtime state. Defaults to `%LOCALAPPDATA%\Pan\<runner>` (Windows), `~/Library/Application Support/Pan/<runner>` (macOS), or `$XDG_STATE_HOME/pan/<runner>` / `~/.local/state/pan/<runner>` (Linux). |
| `workspaceRoot` | no | Disposable isolated code workspaces. Default `os.tmpdir()/pan-workspaces`. It must not overlap `stateRoot`; `stateRoot` must also remain outside fixed/slot repositories. |
| `legacyLauncherPids` | no | Temporary upgrade aid: unique launcher PIDs for pre-generation workers whose old temporary state directory has already vanished. The runner adopts only an exact live legacy `launch.mjs` command whose task/session matches the Project, records its start identity durably, and never signals or restarts it. Remove the entries after those launchers exit. |

Per-playbook concurrency (`capacity`) and any `workingDirectory` come from each
`playbooks/<machine>/<name>.md` front matter in the Domain, **not** this file.
Changing playbooks in the Domain takes effect without editing local config;
changing local config requires restarting the runner.

A **fixed `workingDirectory`** should use **capacity 1**. It is a real in-place
checkout shared by every task of that playbook (Pan's own state lives elsewhere,
under `stateRoot`, never inside it). Two concurrent workers in the same
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

### Durable state and disposable workspaces

Every task gets a durable **per-session state directory** under `stateRoot`,
named `pan-<number>-<sessionId>`. Every process launch gets a UUID generation at
`.pan/runs/<launchId>/`. For an isolated playbook, code lives separately in the
matching directory under `workspaceRoot`; fixed and slot playbooks use their
configured checkout. Removing temporary workspaces therefore cannot remove the
ownership records used to prevent duplicate launches.

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
2. **Claim or resume** — re-read the item to avoid races. For new work, first
   provision the durable session root, then persist `machine` (this machine's
   name, or a composite `<machine>::<slot>` for a slot-pooled playbook) and
   `session-id`. Set `claimed-by`, `lease-until` (near-future UTC), and finally
   `Status=in-progress`. A crash therefore cannot leave an in-progress item
   without a durable session to resume.
   Immediately after writing, the runner **re-reads once more to confirm** it
   still owns the claim (`claimed-by`, `lease-until`, `machine`, and
   `session-id` are exactly the values it wrote and `Status` is
   `in-progress`); if another runner won the race, it abandons the item
   **without overwriting** the winner's fields. This
   is best-effort optimistic concurrency (GitHub has no atomic
   compare-and-swap); the confirming re-read is the point. The lease is renewed
   periodically while the worker runs.
3. **Launch** — resolve the durable session state directory (under
   `stateRoot`) and the separate working directory (a fixed
   `workingDirectory`, the chosen `workspaceSlots` slot, else a matching
   disposable directory under `workspaceRoot`), refresh `.pan/task.json` from the
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
4. **Supervise** — verify the launch generation's PID plus process-start
   identity, then watch only that generation's signal files.

While the runner is looping, **Enter** or **Space** queues an immediate ordinary
poll. The request remains pending even when the key is pressed during polling
or supervision rather than during the idle sleep.

### `.pan/` file contract

The session `.pan/` directory lives under durable `stateRoot`. Every launch has
an isolated `.pan/runs/<launch-id>/`; that attempt directory is passed in
`PAN_STATE_DIR`, while `PAN_WORKING_DIRECTORY` names the separate checkout.

Durable session files:

- `.pan/task.json` —
  `{ itemId, number, title, body, comments, url, repo, playbook, workstream, answers }`.
  `comments` contains the complete chronological Issue history as
  `{ author, timestamp, url, body }` entries. The runner refreshes Issue content
  before every launch and retains existing structured answers.
  `itemId` keys runner state because Issue numbers are repository-local.
- `.pan/launch.json` — runner-owned session metadata and ownership marker
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
- `.pan/attempts.json` — durable append-only index of every launch UUID for the
  bound task/session plus the current owned launch id. Missing or malformed
  index data, a missing `runs/` directory, a missing indexed child, or an
  unexpected/renamed child is uncertain ownership and fails closed. Restart
  recovery consumes signals only from the indexed current launch.
- `.pan/playbook.md` and optional `.pan/pan.md` — latest instructions, copied
  into each attempt before launch.

Attempt-local files:

- `attempt.json` — immutable generation metadata binding UUID launch id,
  task/session, machine/runner identity, workspace kind/path, and slot.
- `owner.json` — atomically written before Copilot starts. It records launcher
  PID and process-start identity. The runner calls an attempt live only when
  both still match; a reused PID is dead and an unreadable identity is
  uncertain.
- `exit.json` — atomically written by the launcher during cleanup. A still-live
  matching owner remains live until the process actually exits.
- `task.json`, `playbook.md`, optional `pan.md`, `launch-prompt.txt`, and
  `launch.mjs` — that generation's launch snapshot and launcher. Run with its CWD set to
  the working directory, it addresses every control/signal file by its absolute
  attempt path (so a fixed/slot repository never gains a
  `.pan/`), passes the prompt to `copilot` as a single argv element (no shell
  ever re-parses the prompt on any platform), grants `copilot` access to the
  attempt directory with `--add-dir`, exports
  `PAN_STATE_DIR`/`PAN_WORKING_DIRECTORY`, and runs a **title watchdog** that
  periodically re-asserts the worker's task title on the terminal. `copilot`
  rewrites the window title (`OSC 0`) repeatedly during a session with its own
  AI-generated summary — which overrides any terminal-side "custom title" — so
  the launcher keeps re-emitting the stable `#<number> <title>` so each worker
  window stays identifiable (a brief flicker to copilot's title can appear right
  after each of its infrequent updates). The launcher also watches for
  `worker.stop` (below) and, on that signal, stops `copilot` and closes its
  own terminal window (on macOS via Terminal.app matched by tty; on Windows by
  exiting 0 so Windows Terminal auto-closes the tab).

Written by the worker in its own attempt:

- `needs-human.json` — presence means the worker needs the user
  (`{ question, since }`). While present, the runner sets the Issue's
  `needs-human-since` and posts a comment with the question; when the worker
  deletes it, the runner clears `needs-human-since`. If the file is present but
  cannot be parsed yet or has no usable `question` (a partial write in progress),
  the runner does **nothing** — it neither sets `needs-human-since` nor posts a
  comment — and retries parsing on the next supervise tick, so a half-written
  signal never posts a placeholder question.
- `result.json` — `{ outcome: "done" | "needs-review", summary, details }`,
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

- `worker.stop` — written once the runner has recorded that attempt's
  `result.json` on the Issue and updated the Project (for `done` or
  `needs-review`). Its presence tells the launcher the task is finished, so the
  worker session shuts down and closes its terminal window instead of lingering.
  It is not written while a worker is merely paused on `needs-human.json`.

The runner never clears another generation's files. Its per-task launch lock is
an append-only set of uniquely named contender/holder records: stale records
are ignored only after PID/start-identity verification and are never removed
through a shared compare-then-unlink pathname. Before launching it validates
the attempt index and scans all attempts under the session. It adopts exactly
one confirmed live attempt, launches only after every prior attempt is
confirmed dead, and refuses on multiple live or uncertain ownership. It also
refuses while a dead attempt holds an unprocessed result. During supervision,
signals are consumed only from the launch id the runner already owns; a stale
result from another generation is preserved but never adopted. `worker.running`
and `worker.pid` remain diagnostic/legacy files only; deleting
`worker.running` cannot make a matching live owner disappear.

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
- **Rehydration is conservative.** On restart the runner scans durable
  `stateRoot`, validates the session binding, then classifies every UUID launch
  generation by its owner PID and process-start identity. Exactly one confirmed
  live attempt is adopted. Multiple live attempts, malformed ownership, or an
  identity that cannot be queried leave the task fail-closed; diagnostics list
  launch ids and known PIDs and no additional worker is started. Results are
  accepted only from the selected owned attempt. Inert owned state is pruned
  from `stateRoot`; a matching disposable isolated workspace may also be
  removed, but fixed/slot repositories are never deleted.
- **Legacy migration.** Before durable rehydration, the runner scans the former
  `workspaceRoot` state layout. Matching session context is copied to
  `stateRoot`. Stopped results become dead attempt generations. A live legacy
  launcher is left untouched and is adopted through a durable migration record
  only after its exact PID command is corroborated and its current start identity
  is captured. An uncorroborated legacy owner remains uncertain and blocks
  relaunch. If the old directory is already gone but its launcher is known,
  temporarily list that launcher PID in `legacyLauncherPids`; the same
  corroboration and durable adoption run without recreating or touching the
  vanished path. Migration takes the same per-task launch lock as ordinary
  launching and is idempotent on the legacy PID plus process-start identity; an
  interrupted owner-record write is repaired without creating a second attempt.
- **`copilot` invocation.** The worker is started as
  `<copilotBin> [permission args] --add-dir <attempt-dir> [copilotArgs...]
  --session-id <id> --interactive <prompt>` by the generated `launch.mjs`.
  The prompt is one argv value and is never re-parsed by a shell; any bare
  `-i`/`--interactive` supplied in `copilotArgs` is stripped.
- **Recorded answers.** A first launch starts with an empty `answers` array.
  Later launches retain any structured answers already in `.pan/task.json`.
