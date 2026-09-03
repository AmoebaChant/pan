# Triage

Triage is an interactive Pan session with the user that turns raw Issues into a
prioritized, dispatchable backlog. Read [project schema](project-schema.md) and
[playbooks](playbooks.md) alongside this file. When an Issue has a
`## Recurrence` section or the user asks for recurring work, also read
[recurrence](recurrence.md).

Read live from GitHub in the turn you act. Re-read a target immediately before
mutating it and verify the result afterward. Never treat a prior read as still
current.

## 1. Register every required Issue (automatic)

Read the complete Issue set and the complete Project item set and join them by
Issue URL. By default, add every missing Issue to the Project with
`Status=untriaged` — including closed Issues, without editing or reopening
them. In external-human-manager mode, classify each missing Issue from live
durable evidence before consulting any migration receipt, then apply the
[Domain contract](domain.md#external-human-task-manager-contract):

- always add an Issue that is conclusively agent-owned or belongs to a
  mandatory GitHub-retained class. Retained classes include every recurring
  human task and every audit or lifecycle task type named by the Domain. A
  receipt cannot override this requirement;
- add an Issue with no migration receipt;
- only for an Issue that could legitimately be migrated human work, exclude it
  when exactly one well-formed receipt resolves to one live external task, the
  reciprocal source Issue URL and complete migrated data verify, and its task
  type is not GitHub-retained; and
- only for that potentially migratable human work, when an existing receipt is
  malformed, conflicting, or unreadable; the external record it references is
  missing or unreadable; its backlink or migrated data does not match; or
  ownership or task type is indeterminate, make no Project write and surface
  the ambiguity. Do not guess by either re-adding or excluding it, and do not
  claim registration is complete.

Read the Issue, `pan.md`, and external record live for this decision; a prior
queue read or the receipt alone is not evidence. Successfully migrated eligible
human tasks remain outside the Project, so ordinary reconciliation does not
undo the migration. Recurring and other retained tasks are not eligible for
that exclusion; an authorized external record is only a mirror or link.
Registration needs no approval because it acts on durable facts. Do not rewrite
existing items or runner-owned fields.

Read completely. `gh issue list --limit <n>` and `gh project item-list -L <n>`
are hard caps with no truncation signal: if the returned count equals the limit,
treat the set as possibly truncated and either page fully (GraphQL cursor
pagination, or `gh api --paginate`) or stop and report the incompleteness.
Because registration must account for *every* missing Issue, never claim
completeness until truncation is ruled out and every Issue has reached one of
the outcomes above.

## 2. Include declared external backlogs (automatic)

A workstream README may declare external backlog repositories (see
[workstreams](workstreams.md)). During registration, read the Domain's
workstreams, collect those declarations, fetch each declared repository's Issue
set, join by URL, and add the missing ones to the Project as `untriaged`. Adding
an Issue means creating a Project item that references it — the Issue is never
copied. External Issues stay in their owning repository: comments, closures, and
edits target that repository, and Pan never creates proxy Issues in the Domain
repository.

In external-human-manager mode, apply the same live migration-receipt and
GitHub-retained-type sequence from step 1 before adding a missing external
Issue. Classify mandatory GitHub tasks before consulting receipts, exclude only
a verified migrated human task that is eligible for migration, and make no
write on ambiguous migration evidence only when the task could legitimately be
migrated human work.

Record the declaring workstream in the added item's `workstream` field when
exactly one workstream declares the repository. A repository may be declared by
more than one workstream; when that happens the association is ambiguous, so
leave `workstream` unset rather than guessing. If workstream discovery is
incomplete (a README cannot be read), report it and proceed with the
repositories you could read.

## 3. Complete merged review PRs (automatic)

Workers record every pull request on the task Issue because GitHub's closing
keywords do not own Pan task completion. Reconcile finished review work here so
it does not remain `in-review` after merge.

For each Project item in `in-review`, including one whose Issue is already
closed after a partial prior attempt, read the task Issue at the Project item's
content URL for the PR link the worker recorded — a comment whose first line is
`Pan: pull request <PR URL>`. Use that content URL or its
`repository.nameWithOwner` for every Issue read, closure, and confirmation;
never substitute the configured Domain repository, because external-backlog
Issue numbers are repository-local. For a recorded GitHub PR
(`https://github.com/.../pull/<n>`), read its live state
(`gh pr view <url> --json state,mergedAt`). A canonical PR URL for another
provider is owned by that provider's Domain guidance: follow those live-state
and completion instructions instead of passing the URL to `gh pr view`. If no
provider guidance exists, leave the item `in-review` and surface the missing
completion contract.

For each recorded GitHub PR:

- **Merged** — first clear any `next-action-date` and re-read the Project item
  to verify it is empty. If that clear fails, do not close the Issue and leave
  `Status=in-review`. Then close an open Issue as completed (`gh issue close
  --reason completed`) and verify the closure; if it was already closed, require
  a completed closure before continuing. Re-read the item, require its date to
  remain empty and its status to remain `in-review`, then set `Status=done` as
  the final Project write and verify it. If closure or final status fails, the
  nonterminal `in-review` item remains eligible for this scan to retry; never
  convert a not-planned closure to `done`.
- **Still open** — leave the item in `in-review`; the work is not done yet.
- **Closed without merging** — the work is not done. Leave the item and surface
  it for the user rather than completing it.

Only `in-review` declares that merge is the remaining completion condition.
Never infer completion from a merged PR for `in-progress`, `paused`, `blocked`,
`ready`, or `needs-detail` work; its worker or playbook may still have
post-merge gates.

Like registration, this reconciliation acts on an objective fact (a merge) and
needs no approval. It only advances items that carry a recorded, merged PR, and
it never edits runner-owned fields.

## 4. Reconcile closed recurring tasks (automatic)

Issue closure is the durable completion signal for a recurring task, regardless
of whether Pan, the GitHub UI, or another client performed it. Inspect every
closed Domain Issue with an exact `## Recurrence` section, including items
already in a terminal Project status, until its closure has been reconciled.
This is lifecycle reconciliation only: do not otherwise classify or edit closed
Issues.

Re-read each candidate's body, comments, `stateReason`, `closedAt`, and Project
item immediately before acting:

- **Occurrence evidence** — before either closure path, require a valid
  `Pan: recurrence occurrence YYYY-MM-DD` marker. If it is absent, follow
  [recurrence backward compatibility](recurrence.md#backward-compatibility).
  An unusable marker is conflicting evidence and requires confirmation. If
  inference is ambiguous, ask the user and leave the date and terminal Project
  state unchanged; do not claim reconciliation is complete.
- **Completed closure** — follow [recurrence](recurrence.md#creating-or-reconciling-the-successor)
  to create or repair exactly one successor. Use `closedAt` as the completion
  day. After the successor and occurrence links are confirmed, re-read the
  current item. If it already has `Status=done`, clear only
  `next-action-date`, verify it is empty, and do not rewrite Status. If it has a
  different terminal Status, surface the conflict without changing it. Only
  when its live Status is nonterminal, clear and verify `next-action-date`,
  then set `Status=done` as the final Project write of the transition and verify
  it; the occurrence marker preserves its nominal date. If the clear fails, do
  not advance the status, so this scan can retry.
- **Not-planned closure** — this cancels the series. If no successor marker
  exists, create no successor and re-read the current item. If it already has
  `Status=rejected`, clear only `next-action-date`, verify it is empty, and do
  not rewrite Status. If it has a different terminal Status, surface the
  conflict without changing it. Only when its live Status is nonterminal, clear
  and verify `next-action-date`, then set `Status=rejected` as the final Project
  write of the transition and verify it. If the clear fails, do not advance the
  status, so this scan can retry. A not-planned closure that already has a
  successor is contradictory; surface it instead of deleting history or
  guessing whether the series should continue.
- **Missing or ambiguous recurrence data** — do not create an Issue or change
  terminal state. Surface the exact missing rule, nominal occurrence, or
  conflicting marker for the user.

The completed closure plus the Issue's recurrence declaration is standing
approval for the successor and lifecycle writes. The durable previous/next
markers make partial rollovers resumable and prevent duplicate Issues.

## Objective hygiene repairs (automatic)

Triage also performs two narrow approval-free repairs after complete live
reads:

- **Terminal stale date.** When a Project item already has terminal
  `Status=done` or `Status=rejected` and `next-action-date` is non-empty, re-read
  the Issue and item. Require a settled pair: `done` with a completed Issue
  closure, or `rejected` with a not-planned closure. An open Issue or any
  mismatch is a lifecycle conflict; surface it and make no cleanup write. For a
  recurring Issue, also require a valid occurrence marker or successfully infer
  and verify one under
  [recurrence backward compatibility](recurrence.md#backward-compatibility)
  while preserving the date. If inference is ambiguous or an existing marker
  is unusable, preserve `next-action-date` until the recurrence conflict is
  resolved. Once the closure and recurrence preconditions are satisfied, clear
  only `next-action-date`, re-read, and verify it is empty. Never change or
  reassert Status, reopen or close the Issue, or edit any other field as part of
  this repair.
- **Open recurrence marker.** When an open Domain Issue already has an exact
  `## Recurrence` section but lacks its first-line occurrence marker, apply
  [recurrence backward compatibility](recurrence.md#backward-compatibility).
  If live durable evidence identifies exactly one nominal occurrence, write
  only `Pan: recurrence occurrence YYYY-MM-DD` as the first-line marker,
  preserve `next-action-date` and the rest of the body, then re-read and verify.
  If inference is ambiguous or an existing marker is unusable, make no write
  and ask the user to confirm the nominal occurrence.

These are objective reconciliation, not classification or discretionary
planning authority.

## 5. Classify and fill fields (with approval)

For each open task, decide and set:

- `owner` — `human` or `agent` (or leave `unassigned` if genuinely unknown).
- `priority` — weigh urgency, dates, dependencies, blockers, recent activity,
  comments, and workstream narrative.
- `next-action-date` — for a human task, recommend the next day the user should
  act after reading both the Issue and its related workstream. This schedules
  attention rather than setting a deadline. Leave it empty when no defensible
  day is available, and clear it when the task is not human-owned. Daily
  selection and cleanup of past or already-today dates follow
  [Daily Briefing](daily-briefing.md). For a recurring task, the field may move
  independently of the nominal occurrence recorded in the Issue body, but only
  after that marker is valid. Terminal human tasks always leave it empty.
- `playbook` — for `agent` tasks, the name of the playbook that fits (see
  [playbooks](playbooks.md)). Read `playbooks/*/*.md` (per-machine definitions)
  to choose.
- `workstream` — the area this task belongs to, if any. Validate a non-empty
  path by reading `workstreams/<path>/README.md` first.
- `Status`:
  - `needs-detail` if the Issue lacks enough information to act;
  - `ready` when fully triaged. An `agent` + `ready` task **must** have a
    non-empty `playbook` that a machine runs, or no runner can ever claim it;
  - recommend `rejected` when the Issue and workstream context indicate the work
    should not be pursued. With approval, clear `next-action-date` and verify it,
    close and verify the Issue as not planned (`gh issue close --reason "not
    planned"`), then re-read and set `Status=rejected` as the final Project
    write of the transition. If the clear fails, leave the Issue open and the
    status nonterminal; if closure or final status fails, report the confirmed
    partial state.
    Rejection is terminal, not a substitute for work that is merely blocked or
    deferred;
  - leave `untriaged` only if you have not yet reviewed it.

Preserve Project order as the user's precedence within the same priority.

### Domain-designated human task manager

The default is for every task to remain a GitHub Issue represented in the
Project. A Domain may override that default in its `pan.md` by naming one
external human task manager and defining the complete
[Domain contract](domain.md#external-human-task-manager-contract). When that
mode is enabled:

- `owner=agent` tasks continue to use GitHub Issues and the Project and remain
  the only tasks eligible for runner dispatch.
- Eligible `owner=human` tasks are managed in the named external system and are
  removed from the Project only after their reciprocal migration receipt
  verifies.
- Recurring human tasks always remain Domain Issues and Project items. The
  external manager may mirror or link them only when its contract defines that
  behavior; GitHub remains canonical for recurrence lifecycle and history.
- A migration must preserve the source Issue URL, repository, Issue number,
  title, description, deadline, comments, and any other data the Domain policy
  requires before removing the GitHub task.
- Triage reads the external human queue live and verifies every external write
  just as it does GitHub writes. The Domain policy defines field mappings,
  duplicate detection, assignee exclusions, and any task types that must remain
  in GitHub for lifecycle or audit reasons.
- Registration re-verifies the receipt and external task live on every pass.
  It first registers conclusively agent-owned and mandatory GitHub-retained
  tasks without consulting receipts. For work that could legitimately be
  migrated human work, it excludes only a live-verified migration and stops on
  incomplete or ambiguous migration evidence rather than rebuilding a second
  queue from Issue comments.
- A Domain policy may require a dry run and explicit approval before bulk
  migration or deletion. It must never delete an external-backlog Issue that
  the Domain does not own unless the owning repository's policy explicitly
  permits it.

### Completing a recurring occurrence

When the user explicitly completes a human task whose body contains
`## Recurrence`, follow [the recurrence rollover](recurrence.md#creating-or-reconciling-the-successor)
before marking the current task `done`. Create and confirm one ready successor,
link the occurrence history, then clear and verify the current
`next-action-date`. Close and confirm the current Issue, re-read the item, and
set its `Status=done` as the final Project write of the transition. If the date
clear fails, leave the Issue open and status nonterminal. A client may instead
close the Issue as completed; step 4 performs the same rollover automatically
during the next triage.

## 6. Recover started tasks (passive sweep and stale `paused`)

A **started** task is either `in-progress` (running now: valid lease) or
`paused` (started but not running: expired lease), per the [project
schema](project-schema.md#status-meanings). Triage helps keep this honest:

- **Passive `paused` sweep.** When you notice an **agent-owned** item that is
  `in-progress` with an **expired lease**, flip it to `paused`. This is the
  documented visibility-only non-owner write (see [the paused
  sweep](project-schema.md#the-paused-sweep-documented-non-owner-write)); it
  changes only `Status` and needs no separate approval. Never sweep a
  human-owned `in-progress` item: it has no runner lease by design. Never touch
  a valid agent lease — that task is running.
- **Flag stale `paused` tasks.** A `paused` task is machine-pinned: it resumes
  only when its owning `machine`'s runner next polls. If one has been `paused`
  well beyond a normal restart window, surface it and offer two paths: (a) start
  the owning `machine`'s runner so it resumes there, or (b) **manual
  cross-machine handoff** — with approval, clear `machine` and `session-id` (and
  any `needs-human-since`) and set `Status=ready`, dropping the pin so another
  capable machine starts the task fresh. Handoff loses the paused session's
  transcript, so prefer resuming on the owning machine when it is available.

## 7. Approval and mutation

Read, analyze, and recommend freely. An explicit user request for a specific
change is approval for that change. Otherwise, present the proposed field
changes — show current vs. proposed values clearly, per Issue, with a link and a
short summary of the relevant context — and get approval before writing.

Apply the smallest `gh project item-edit` / `gh issue edit` / `gh issue comment`
operation. Re-read the target and report only confirmed effects.

## 8. What triage leaves alone

- Closed Issues correctly paired as `done` with a completed closure or
  `rejected` with a not-planned closure are historical records. Routine triage
  does not reclassify, reopen, or edit them unless the user explicitly asks
  about a specific closed Issue. The only exception is step 4: a closed
  recurring Issue is not settled until its required successor or cancellation
  is confirmed. Step 3 also resumes a merged-PR transition left with a completed
  closure and `Status=in-review`. The objective hygiene repair above may clear
  only a stale `next-action-date` from an already-terminal item. Surface any
  other Status/closure pairing as a recoverable conflict rather than treating
  it as settled work or guessing the intended terminal state.
- Runner-owned lease fields (`claimed-by`, `lease-until`) are never written by
  triage. The worker's `needs-human-since` is likewise left alone in routine
  triage — the two deliberate exceptions are the passive `paused` sweep (a
  `Status`-only write, §6) and an approved manual cross-machine handoff, which
  clears `machine`, `session-id`, and any `needs-human-since` to un-pin a stale
  `paused` task back to `ready` (§6).
- Never leave an `agent` + `ready` task with an empty `playbook`.

## Scheduled triage

A recurring review runs the same live reads and the same automatic
registration, merged-PR completion, recurring-task reconciliation, terminal
stale-date clearing, and unambiguous open occurrence-marker migration. Beyond
those automatic reconciliations and the passive expired-lease `paused` sweep, a
scheduled pass stays read-only unless the user has given a standing policy to
act. Do not create a separate scheduler or catch up work from an earlier
session.

## Daily planning

Triage prepares the portfolio; it does not silently turn recommendations into a
daily commitment. When the user asks to plan the day, follow
[Daily Briefing](daily-briefing.md), including its complete live review,
explicit agreement, and end-of-briefing date invariant.
