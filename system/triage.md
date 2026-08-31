# Triage

Triage is an interactive Pan session with the user that turns raw Issues into a
prioritized, dispatchable backlog. Read [project schema](project-schema.md) and
[playbooks](playbooks.md) alongside this file. When an Issue has a
`## Recurrence` section or the user asks for recurring work, also read
[recurrence](recurrence.md).

Read live from GitHub in the turn you act. Re-read a target immediately before
mutating it and verify the result afterward. Never treat a prior read as still
current.

## 1. Register every Issue (automatic)

Every Domain Issue is a task and belongs to the Project. Read the complete Issue
set and the complete Project item set, join them by Issue URL, and add every
missing Issue to the Project with `Status=untriaged` — including closed Issues,
without editing or reopening them. This registration is one of three
reconciliations that need no approval (the others are merged-PR completion and
recurring-task rollover in steps 3 and 4), because each acts on durable facts.
Do not rewrite existing items or runner-owned fields.

Read completely. `gh issue list --limit <n>` and `gh project item-list -L <n>`
are hard caps with no truncation signal: if the returned count equals the limit,
treat the set as possibly truncated and either page fully (GraphQL cursor
pagination, or `gh api --paginate`) or stop and report the incompleteness.
Because registration must add *every* missing Issue, never claim completeness
until truncation is ruled out.

## 2. Include declared external backlogs (automatic)

A workstream README may declare external backlog repositories (see
[workstreams](workstreams.md)). During registration, read the Domain's
workstreams, collect those declarations, fetch each declared repository's Issue
set, join by URL, and add the missing ones to the Project as `untriaged`. Adding
an Issue means creating a Project item that references it — the Issue is never
copied. External Issues stay in their owning repository: comments, closures, and
edits target that repository, and Pan never creates proxy Issues in the Domain
repository.

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

For each Project item in `in-review`, read the task Issue at the Project item's
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

- **Merged** — close the Issue as completed (`gh issue close --reason
  completed`), re-read it, and only after GitHub confirms it closed set
  `Status=done`. If closure or confirmation fails, leave the item `in-review`
  so a later reconciliation can retry.
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

- **Completed closure** — follow [recurrence](recurrence.md#creating-or-reconciling-the-successor)
  to create or repair exactly one successor. Use `closedAt` as the completion
  day. After the successor and occurrence links are confirmed, preserve the
  current `next-action-date` and set the closed item to `Status=done`.
- **Not-planned closure** — this cancels the series. If no successor marker
  exists, create no successor and set the item to `Status=rejected`. A
  not-planned closure that already has a successor is contradictory; surface it
  instead of deleting history or guessing whether the series should continue.
- **Missing or ambiguous recurrence data** — do not create an Issue or change
  terminal state. Surface the exact missing rule, current date, or conflicting
  marker for the user.

The completed closure plus the Issue's recurrence declaration is standing
approval for the successor and lifecycle writes. The first-line previous/next
markers make partial rollovers resumable and prevent duplicate Issues.

## 5. Classify and fill fields (with approval)

For each open task, decide and set:

- `owner` — `human` or `agent` (or leave `unassigned` if genuinely unknown).
- `priority` — weigh urgency, dates, dependencies, blockers, recent activity,
  comments, and workstream narrative.
- `next-action-date` — for a human task, recommend the next day the user should
  act after reading both the Issue and its related workstream. This schedules
  attention rather than setting a deadline. For a recurring task it is the
  current occurrence date, not the cadence, and must be non-empty. Leave it
  empty when no defensible day is available, and clear it when the task is not
  human-owned.
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
    should not be pursued. With approval, set `Status=rejected` and close the
    Issue as not planned (`gh issue close --reason "not planned"`). Rejection is
    terminal, not a substitute for work that is merely blocked or deferred;
  - leave `untriaged` only if you have not yet reviewed it.

Preserve Project order as the user's precedence within the same priority.

### Domain-designated human task manager

The default is for every task to remain a GitHub Issue represented in the
Project. A Domain may override that default in its `pan.md` by naming one
external human task manager and defining its contract. When that mode is
enabled:

- `owner=agent` tasks continue to use GitHub Issues and the Project and remain
  the only tasks eligible for runner dispatch.
- `owner=human` tasks are managed in the named external system and need not
  remain Project items after migration.
- A migration must preserve the source Issue URL, repository, Issue number,
  title, description, deadline, recurrence, comments, and any other data the
  Domain policy requires before removing the GitHub task.
- Triage reads the external human queue live and verifies every external write
  just as it does GitHub writes. The Domain policy defines field mappings,
  duplicate detection, assignee exclusions, and any task types that must remain
  in GitHub for lifecycle or audit reasons.
- A Domain policy may require a dry run and explicit approval before bulk
  migration or deletion. It must never delete an external-backlog Issue that
  the Domain does not own unless the owning repository's policy explicitly
  permits it.

### Completing a recurring occurrence

When the user explicitly completes a human task whose body contains
`## Recurrence`, follow [the recurrence rollover](recurrence.md#creating-or-reconciling-the-successor)
before marking the current task `done`. Create and confirm one ready successor,
link the occurrence history, then close and confirm the current Issue before
setting its `Status=done`. A client may instead close the Issue as completed;
step 4 performs the same rollover automatically during the next triage.

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
  is confirmed. Surface any other Status/closure pairing as a conflict rather
  than treating it as settled work.
- Runner-owned lease fields (`claimed-by`, `lease-until`) are never written by
  triage. The worker's `needs-human-since` is likewise left alone in routine
  triage — the two deliberate exceptions are the passive `paused` sweep (a
  `Status`-only write, §6) and an approved manual cross-machine handoff, which
  clears `machine`, `session-id`, and any `needs-human-since` to un-pin a stale
  `paused` task back to `ready` (§6).
- Never leave an `agent` + `ready` task with an empty `playbook`.

## Scheduled triage

A recurring review runs the same live reads and the same automatic
registration, merged-PR completion, and recurring-task reconciliation (steps
1–4). Beyond those automatic reconciliations, a scheduled pass stays read-only
unless the user has given a standing policy to act. Do not create a separate
scheduler or catch up work from an earlier session.
