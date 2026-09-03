# Project schema

The connected GitHub Project is the task queue. Each Project item wraps one
Domain Issue and carries the fields below. This is the complete, canonical field
contract — there are no other fields Pan relies on, and Pan never invents new
ones.

`Status` is the built-in Projects status field, so its display name is
capitalized and cannot be renamed. Every other field is a custom field created
with exactly the name shown. Any select field left empty on a hand-created Issue
reads as its documented default rather than as an error.

## Fields

| Field | Type | Owned by | Meaning |
| --- | --- | --- | --- |
| `owner` | single select | triage | `unassigned` \| `human` \| `agent`. Empty reads as `unassigned`. Separates the human queue from the agent queue; nothing else does. |
| `Status` | single select | triage, then the runner | `untriaged` \| `needs-detail` \| `ready` \| `in-progress` \| `paused` \| `in-review` \| `done` \| `rejected` \| `blocked`. Empty reads as `untriaged`. |
| `priority` | single select | triage | `urgent` \| `high` \| `normal` \| `low`. Empty reads as `normal`. |
| `next-action-date` | date | triage, Daily Briefing, reconciliation | The sole nonterminal human planning signal: past means overdue or punted, today means selected in the agreed daily plan, future records a prior deferral, and empty means unscheduled. It schedules attention rather than a deadline. Agent-owned and terminal human tasks leave it empty. Recurring tasks keep cadence and their nominal occurrence in the Issue body; moving this field does not move the recurrence and requires a valid occurrence marker. See [Daily Briefing](daily-briefing.md) and [recurrence](recurrence.md). |
| `playbook` | text | triage | The name of the playbook that should run this task (see [playbooks](playbooks.md)). Empty means no playbook has been chosen yet. |
| `workstream` | text | triage | Optional path relative to `workstreams/`. Empty means the task has no workstream. |
| `needs-human-since` | text | the worker | RFC 3339 UTC timestamp. Non-empty means a live worker is waiting for the user right now. |
| `lease-until` | text | the runner | RFC 3339 UTC timestamp. When a claim expires. |
| `claimed-by` | text | the runner | Stable identity of the runner holding the task. |
| `machine` | text | the runner | Name of the machine whose runner ran the task (matches a `playbooks/<machine>/` folder). Durable provenance for machine-pinned resume: unlike the lease it survives pause. For a slot-pooled playbook it is a composite `<machine>::<slot>` value that also pins the exact workspace slot to resume in; the base before `::` is still the machine. A physical machine name may never contain `::`. Empty means no runner has launched a worker for it yet. |
| `session-id` | text | the runner | UUID of the copilot worker session the runner launched, so the work can be resumed or revisited later (`copilot --resume=<id>` / `--session-id=<id>`) on `machine`. Survives pause. Empty means no worker has been launched yet. |

## Reconciling the Project schema

The fields table above is the single source of truth for what a Project must
provide, including each single-select's option set. Over time a Project can
drift from it — most often when a new Pan version adds a field or a canonical
option to an existing select. **Reconciling the Project schema** is the one
documented, idempotent action that brings a Project back into line with this
table. Setup runs it to provision a new Project, interactive Pan chat runs it to
repair drift, and it is the action the runner points a user at when it refuses
to poll a drifted Project. Because it is defined once here, no other document
re-lists the fields or options; they all invoke this action.

The action is **agent-only**: it mutates schema, so the unattended runner never
performs it (see [runner](runner.md)). It is safe to rerun — a Project already
in line is a no-op.

Steps:

1. **Read live.** Read the configured Project's current fields, their types, and
   every existing single-select option from GitHub. The fields table above is
   the canonical target.
2. **Diff.** Compute only what is missing: canonical fields absent from the
   Project, and canonical options absent from a single-select that already
   exists. Ignore extra fields and extra options the Project already has — they
   are never removed.
3. **Detect unsafe conflicts.** If a field with a canonical name already exists
   with an incompatible type (for example `playbook` as a number, or a canonical
   single-select present as text), **stop and surface it** rather than mutating.
   Renaming the built-in `Status` field is never allowed. Ask the user how to
   proceed; do not guess.
4. **Propose before mutating.** Present the exact mutations — each field to
   create with its type and options, and each option to add to which select —
   and obtain the usual confirmation before writing, exactly as any other
   Project change. An explicit user request to reconcile still previews the
   diff, but a clean diff is simply reported as "already up to date."
5. **Create missing fields** with their exact canonical types and, for
   single-selects, their full canonical option set. Use
   `gh project field-create` (`--data-type SINGLE_SELECT|TEXT|DATE`, and
   `--single-select-options` for a select's options).
6. **Add missing options** to an existing single-select **without deleting,
   reordering, or renaming** any existing option and **without changing any
   assigned values**. `gh project field-create` cannot add options to an
   existing field, so use the GitHub GraphQL `updateProjectV2Field` mutation.
   Its option input **replaces** the field's option list, so build the complete
   list from the field's current options — carrying each existing option's `id`,
   `name`, `color`, and `description` through unchanged — and append only the
   missing canonical options. Omitting an existing option's id would recreate it
   and drop its assignments, so every retained option must carry its existing id.
   Each `ProjectV2SingleSelectFieldOptionInput` requires a non-null `name`,
   `color`, and `description`, but the canonical contract names options only.
   Give every newly appended option a deterministic default so agents never
   guess: `color` `GRAY` and an empty `description` (`""`). A human can restyle
   an option in the Projects UI afterward; because reconciliation preserves
   existing options untouched, that styling survives later runs.
7. **Verify.** Re-read the Project and confirm every canonical field is present
   with the correct type and that every canonical option now exists. Report the
   confirmed result.

## Status meanings

- `untriaged` — added to the Project but not yet reviewed. Registration of
  missing Issues sets this automatically.
- `needs-detail` — reviewed, but lacks enough information to act. Waiting on the
  user to add detail.
- `ready` — fully triaged and dispatchable, and **never started** (or
  deliberately un-pinned for a fresh start). Any capable machine may claim it.
  For an `agent`-owned task this requires a non-empty `playbook`. For a
  `human`-owned task it just means the user can pick it up.
- `in-progress` — started and actively being worked. For an `agent`-owned task,
  this means a runner holds a valid lease and its worker is being supervised.
  For a `human`-owned task, it means the user has started work; no runner lease
  is expected. A valid lease remains the single liveness signal for agent work:
  a live runner renews an active worker's lease every ~1/3 of `leaseMinutes`, so
  `lease valid` ⟺ the owning runner is alive and supervising. This includes a
  worker that is **alive but waiting on the user** (`needs-human-since` set):
  the worker still holds its lease and slot, so it is running.
- `paused` — started but **not running right now**: the lease has expired, so no
  runner is supervising it. The task is **machine-pinned** — it awaits resume on
  its owning `machine` (recorded in `machine` and `session-id`), which alone can
  reuse the local workspace and copilot session. Distinct from `blocked`:
  `paused` means "was running, will resume on its machine," while `blocked`
  means "waiting on the outside world."
- `in-review` — the worker finished but a human should look before it is done
  (for example, a pull request awaiting merge).
- `done` — complete and confirmed. Pull-request work reaches this only when an
  `in-review` PR is confirmed merged, or when a live worker finishes every
  playbook step including any post-merge gates. A merge alone never completes
  active or paused work. Setting `Status=done` and closing the Issue go
  together: whoever marks a task `done` also closes its Issue as completed
  (`gh issue close --reason completed`). The terminal-write protocol below
  clears and verifies `next-action-date` before closure and makes
  `Status=done` the final Project write of the transition. Recurring history
  remains in its Issue occurrence marker. A recurring task still completes this
  way, but it is not settled until its separate successor is confirmed. Triage
  reconciles the successor when another client closes the Issue first.
- `rejected` — terminal work the user deliberately chose not to pursue. It is
  never dispatchable or completed work. Setting `Status=rejected` and closing
  the Issue as not planned (`gh issue close --reason "not planned"`) go
  together under the terminal-write protocol.
- `blocked` — waiting on something outside the user's control, with no worker
  holding it. This is the *only* meaning of `blocked`.

`done` with a completed closure and `rejected` with a not-planned closure are
the only settled Status/Issue-state pairs for closed work. A completed recurring
Issue without a confirmed successor is pending automatic recurrence
reconciliation, even if its Project item already says `done`. A completed
merged-PR Issue still in `in-review`, or a closed recurring Issue still in a
nonterminal status, is a recoverable partial transition handled by triage's
automatic scans. Any other closed-Status pairing, or an open Issue in `done` or
`rejected`, is a state conflict: clients surface it for repair instead of
filtering the task out or guessing which side is correct.

At a reconciled resting state, every terminal human task has an empty
`next-action-date`. Today and future planning dates belong only to nonterminal
human work. A recurring task's terminal item keeps its nominal occurrence in
the Issue marker, never in the planning field.

### Human terminal-write protocol

Every transition of a human task to `done` or `rejected`, and every merged-PR
completion, uses this order. An already-empty `next-action-date` satisfies the
date step without a write:

1. Re-read the Issue and Project item and confirm that the requested or
   automatically reconciled terminal outcome still applies.
2. Complete and verify any prerequisite durable work that does not make the
   current item terminal, such as creating and linking a recurring successor.
3. Clear `next-action-date` if it is non-empty, then re-read and verify it is
   empty. If the clear or verification fails, do not close an Issue that Pan
   still controls and leave the Project status nonterminal.
4. Close an open Issue with the matching reason and verify the closure. If
   another client already closed it, require the matching closure reason
   instead of reopening or rewriting it.
5. Re-read the Project item, require the date to remain empty and the expected
   nonterminal status to remain current, then set the terminal `Status`. That
   status is the final Project write of the terminal transition; re-read it
   only to verify. Independent runner-owned cleanup described below is not part
   of that transition.

If Issue closure succeeds but the final Status write fails, preserve the
closed Issue and nonterminal Project status. Automatic merged-PR and recurrence
scans include those partial states and retry from live evidence. Other partial
terminal pairs are surfaced for an explicitly approved repair; they are never
treated as settled or guessed from conversation history.

An already-terminal item with a stale date predates or violated this ordering.
It is objective field hygiene rather than daily planning. Re-read the Issue and
Project item. Require a settled pair: `Status=done` with a completed Issue
closure, or `Status=rejected` with a not-planned closure. An open Issue or any
mismatch is a lifecycle conflict; surface it and make no cleanup write. A
recurring item also requires a valid occurrence marker or successful inference
and verification under
[recurrence backward compatibility](recurrence.md#backward-compatibility)
while `next-action-date` remains intact. If inference is ambiguous or an
existing marker is unusable, Pan preserves the date, makes no terminal cleanup
write until resolved, and surfaces the conflict. Once the closure and recurrence
preconditions are satisfied, Pan clears only `next-action-date`, re-reads, and
verifies it is empty. This repair never changes or reasserts Status, changes
Issue closure, or writes another field.

### Status transitions

```
ready --claim (agent) / start (human)--> in-progress
agent in-progress --lease expires (runner crash / force-close / graceful stop)--> paused
paused --owning machine resumes--> in-progress
in-progress / paused --> in-review / done   (normal completion)
paused --triage clears resume info--> ready  (manual cross-machine handoff)
untriaged / needs-detail / ready / paused / in-review / blocked --user declines--> rejected
recurring human --completed closure / rollover--> successor ready + current done
recurring human --not-planned closure--> current rejected (series ends)
```

Machine-pinning applies only to **resumes**: `ready` work is never pinned, so
any capable machine may claim it; once a task has started, only the machine that
ran it resumes it (from `paused`) until triage deliberately un-pins it back to
`ready`.

## Ownership rules

- **Triage owns** `owner`, `Status`, `priority`, `playbook`, and `workstream`,
  and initializes or recommends `next-action-date`. **Daily Briefing** owns
  agreed daily planning changes to `next-action-date`; see
  [Daily Briefing](daily-briefing.md).
  As a deliberate exception, triage (or any runner's poll) may perform the
  passive visibility sweep below.
- **The runner owns** `Status` transitions after it claims, plus `lease-until`
  and `claimed-by`, while it holds the lease, and `machine` and `session-id`,
  which it records at claim and launch as durable provenance. Unlike the lease,
  `machine` and `session-id` are not cleared on pause — they let a started task
  be resumed or revisited on the machine that ran it.
- **The worker owns** `needs-human-since`, written on its behalf by the runner
  (see [worker base instructions](worker-base-instructions.md)). It is an
  independent human-attention signal and is **never** a recovery input; on
  resume the runner clears it and lets the worker re-raise it if the question
  still stands.
- Nothing writes a field it does not own, with one **documented exception**: the
  passive `in-progress` + expired-lease → `paused` sweep (below) is a
  visibility-only `Status` write that a non-owner (any runner's poll, or triage)
  may perform. Answering a worker's question never touches `needs-human-since`,
  `claimed-by`, or `lease-until`.

### The `paused` sweep (documented non-owner write)

For an `agent`-owned task, `in-progress` + an expired lease is the one
inconsistent state — it claims to be running while no runner supervises it. It
must be flipped to `paused` so the backlog reflects the truth even after a
crash. A human-owned `in-progress` task has no lease by design and is never part
of this sweep:

- **The owning runner** sets its active tasks to `paused` on graceful
  shutdown/drain, and should **proactively release the lease** the moment it
  detects the worker PID is dead rather than waiting for expiry, collapsing the
  inconsistent state into `paused` immediately.
- **Any runner's poll** (and **triage**, if it notices) performs a passive
  sweep for agent-owned items: `owner=agent` + `in-progress` + expired-lease →
  `paused`. It re-reads the item before writing, changes only `Status`, and
  leaves active leases and malformed lease timestamps untouched. This is safe,
  non-destructive, and visibility-only, which is why a non-owner is permitted
  to write it.

### Field hygiene across pause and resume

- On an **owner-initiated pause**, keep durable provenance (`machine`,
  `session-id` — needed to resume on the owning machine) and clear the
  lease-scoped fields (`lease-until`, `claimed-by`). `needs-human-since` is left
  as it was; it is not a recovery input.
- A **passive sweep** changes only `Status`. The expired `lease-until` and
  historical `claimed-by` remain until the owning machine resumes and replaces
  them with a fresh claim.
- On **resume**, the owning runner (`machine == me AND Status == paused`) sets
  `Status=in-progress` with a fresh lease, reuses the recorded `session-id`, and
  clears `needs-human-since` so the worker re-raises the question if it still
  stands.
- On **manual handoff** (triage), clearing `machine` and `session-id` (and any
  `needs-human-since`) and setting `Status=ready` drops the pin so another
  machine starts the task fresh.
- On **terminal status cleanup**, any runner may clear stale `claimed-by` and
  `lease-until` from `in-review`, `done`, or `blocked` after re-reading the
  item. These statuses cannot have a live worker, so retaining a claim would be
  false provenance rather than ownership.

## Dispatch rule

A task is dispatchable to a runner only when **all** of these hold:

1. `owner` is `agent`;
2. `Status` is `ready`;
3. `playbook` is non-empty and names a playbook the machine runs.

An `agent` + `ready` task with an empty `playbook` can never be claimed by any
runner — never leave a task in that state. If you cannot choose a playbook yet,
keep the task `needs-detail`, or propose the playbook and readiness together and
get approval for both.

## Waiting-for-human states

`needs-human-since` is the single signal that a human is needed, and it is
**independent of** the lease: it never decides recovery. A worker that needs an
answer stays alive, keeps its lease and its concurrency slot, and stops spending
budget while it waits; `Status` stays `in-progress` because the worker is still
running.

Because the lease is the single liveness signal, the waiting-for-human matrix
collapses to the lease: a valid lease means running (`in-progress`, whether or
not `needs-human-since` is set), and an expired lease means not running.

| lease | `needs-human-since` | `Status` | Meaning |
| --- | --- | --- | --- |
| valid | empty | `in-progress` | running |
| valid | set | `in-progress` | alive, waiting for the user at its terminal |
| expired | any | `paused` | not running; awaits resume on its owning `machine` |
| none | any | `blocked` | waiting on the world |

A paused task is only ever resumed on the machine that ran it, and on resume its
`needs-human-since` is cleared; if the question still stands the worker re-raises
it, and because the question is surfaced on the **Issue** (a comment plus
`needs-human-since`), the user sees it wherever it resumes.
