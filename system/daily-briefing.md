# Daily Briefing

The **Daily Briefing** is an interactive planning conversation that turns the
live Domain state into an agreed plan for the user's day. It uses
`next-action-date`, or the Domain-configured external task manager's mapped
equivalent, as the sole human planning signal and does not schedule agent
execution.

Read [project schema](project-schema.md), [triage](triage.md),
[recurrence](recurrence.md), and [workstreams](workstreams.md) alongside this
file.

## Establish the live picture

Begin every briefing from a complete live read:

1. Read the Domain's optional `pan.md`. Determine whether it configures the
   external human task manager described by
   [triage](triage.md#domain-designated-human-task-manager). If it does, the
   contract must satisfy the
   [Domain external-manager contract](domain.md#external-human-task-manager-contract),
   including live receipt lookup and GitHub-retained task types, and identify
   enough queue scope, field and terminal state mappings, access, and write
   verification to enumerate and safely update the entire human queue.
2. Read every configured Domain Issue and the complete Project item set,
   including canonical Project order. Rule out pagination or truncation before
   claiming completeness.
3. Read the entire human queue from its authoritative system. By default this
   is the Project's human-owned task set. In external-manager mode, read the
   complete queue live through the `pan.md` contract, including tasks that have
   no Project item, plus any human task types the contract requires to remain
   in GitHub. Recurring human tasks come from whichever system the contract
   makes authoritative for recurrence. Never treat Project human items as the
   whole queue in this mode; the Project remains the agent queue for dispatch.
4. Read every workstream README, not only those already attached to Project
   items. Follow any external backlog declarations they contain.
5. Apply triage's automatic reconciliations and passive expired-lease `paused`
   sweep, including the two objective repairs below. Re-read the affected state
   after those writes.
6. Apply the `## Daily Briefing` section of `pan.md`, if present, as additional
   read-only considerations.

If the external-manager configuration is incomplete, its queue cannot be read
completely, or any other required source cannot be read completely, identify
the gap and stop. Do not present a complete briefing or mutate any planning
date. Automatic reconciliation follows its narrow documented write boundaries;
it is not discretionary planning.

Before proposing any planning-date change to an open recurring Domain Issue,
require a valid `Pan: recurrence occurrence YYYY-MM-DD` marker. If it is
absent, follow
[recurrence backward compatibility](recurrence.md#backward-compatibility)
while the existing `next-action-date` and history are still intact. Persist
and verify an unambiguous marker before continuing. This objective marker
migration is recurrence reconciliation, not discretionary planning, and is
permitted before plan agreement; it does not change `next-action-date`. If the
nominal occurrence is ambiguous, or a marker exists but is unusable, ask one
focused question and leave the planning date unchanged. This permission applies
only to markerless tasks already declared recurring; explicitly adopting an
existing ordinary task follows the confirmation sequence in
[recurrence](recurrence.md#adopting-an-existing-task). Do not propose or apply a
date change for that task until the marker is valid.

Before recommending the plan, re-read every already-terminal Project item with
a stale `next-action-date`. Require a settled pair: `Status=done` with a
completed Issue closure, or `Status=rejected` with a not-planned closure. An
open Issue or any mismatch is a lifecycle conflict; surface it and make no
cleanup write. For a recurring Issue, also require a valid occurrence marker or
successfully infer and verify one under
[recurrence backward compatibility](recurrence.md#backward-compatibility)
while the date remains intact. If inference is ambiguous or an existing marker
is unusable, preserve the date, make no terminal cleanup write until resolved,
and surface the conflict. Once the closure and recurrence preconditions are
satisfied, clear only `next-action-date`, re-read, and verify it is empty. This
is automatic lifecycle hygiene, not a planning choice. Never change or reassert
terminal Status, alter Issue closure, or write another field as part of the
repair.

## Recommend before changing dates

The first planning pass is read-only with respect to discretionary task
planning. The objective repairs and other automatic reconciliations above are
the only pre-agreement writes. Recommend a ranked, realistically sized plan and
explain why each item belongs where it does.
Account for every human task in the authoritative human task system, with detail
proportional to its relevance today, and include:

- human tasks that could receive attention today;
- overdue, previously deferred, and currently scheduled human tasks;
- active, blocked, paused, or in-review agent work that may require monitoring,
  a decision, or side work from the user;
- workers explicitly waiting for the user;
- decisions, dates, dependencies, deadlines, opportunities, and workstream
  priorities that affect the day; and
- optional Domain-specific considerations, such as meetings or another
  read-only context source named in `pan.md`.

Show every proposed `next-action-date` change, or mapped external equivalent,
including how each past or already-today nonterminal task would be resolved,
but do not write those changes yet. Preserve Project order as precedence among
otherwise comparable Project tasks and use the external manager's configured
ordering for its queue.

The user may steer the plan using context that task state cannot express:
meetings, energy, a rare collaboration opportunity, a desired primary focus,
or any other constraint. Revise the recommendation until the user explicitly
agrees to one plan. A request to start a briefing is not approval of its first
recommendation.

## Apply the agreed plan

After explicit agreement, first confirm that every authoritative task system
and its complete queue remain readable. If not, make no planning-date writes.
Then re-read every affected task in its authoritative system and update only
human-owned tasks' `next-action-date` values or mapped external equivalents:

- exactly the agreed nonterminal human tasks receive today's date;
- every other nonterminal human task that was dated today or in the past
  receives an agreed future date or is explicitly cleared;
- unrelated future and empty dates on nonterminal tasks remain unchanged.

The briefing never assigns `next-action-date` to agent-owned tasks. They run
when their lifecycle and playbook dispatch permit, even when the briefing
includes them as monitoring, decision, or side work. Surface any existing agent
date as a schema conflict for triage rather than treating it as a plan.
If an item becomes or is discovered terminal with a stale date after the
initial repair pass, apply the same automatic date-only repair after a live
re-read; do not treat it as an agreed planning write.

Use the external contract's mapped write when a human task lives outside
GitHub. Apply the same approval, immediate re-read, and verification discipline
as for Project writes. If a write or verification fails, stop further writes,
report the confirmed partial state, and do not claim the briefing is complete.

Verify every write and finish only when every nonterminal human planning date
is empty, today, or in the future, and every terminal human planning date is
empty. If a stale terminal date remains, report the lifecycle conflict and do
not claim the briefing invariant is satisfied. Never silently clear an overdue
or previously selected date: its disposition is part of the agreement. Report
the confirmed plan and date changes concisely.

## Meaning of `next-action-date`

For nonterminal human-owned tasks:

- a past date means the task is overdue or was punted and must be explicitly
  resolved in the next briefing;
- today means the task is selected in the agreed plan;
- a future date records a prior deferral and is planning evidence, not an
  absolute reason to exclude the task; and
- an empty value means unscheduled.

Terminal human tasks always leave the planning field empty. Their completion
or rejection history belongs in the authoritative task system, and a recurring
Issue retains its nominal occurrence in the Issue marker.

“Today” is the user's current local calendar date. If that date is not known
reliably, ask rather than guessing.

The field schedules attention, not a deadline or a recurring cadence. Moving a
recurring task earlier or later does not change its nominal occurrence; see
[recurrence](recurrence.md).

## Domain-specific considerations

A Domain may add a clearly named `## Daily Briefing` section to `pan.md`. It may
name extra information to inspect and how to read it, or add considerations for
ranking the day. These instructions are subordinate to the generic Pan
contracts and the configured Domain boundary.

The section is read-only guidance for planning. It cannot authorize
discretionary task mutations, date writes before agreement, or changes outside
the Domain. A separate existing standing policy may authorize its own actions;
the Daily Briefing section does not create such authority.

The external human task manager declaration is a separate operational contract,
not a read-only planning consideration. It maps the generic human-task
operations to the authoritative external system but grants no broader mutation
authority: Daily Briefing may change its mapped planning field only after the
same explicit agreement required for `next-action-date`. Its terminal mapping
must likewise clear and verify the mapped planning value before the external
terminal state is written last. Recurring tasks use the lifecycle of whichever
system the Domain contract makes authoritative; an external manager must define
that lifecycle completely before Pan may manage recurrence there.
