# Recurring tasks

A recurring human commitment is a series of ordinary Pan tasks. Each
occurrence has its own Domain Issue and Project item. Closing an occurrence as
completed requires one successor; Pan may create it as part of an interactive
completion or reconcile it during the next triage after another client closes
the Issue. Pan never keeps one Issue open forever by overwriting its date:
separate Issues preserve the instructions, discussion, completion record, and
Project history for every occurrence.

Recurrence is supported for `human`-owned Issues in the configured Domain
repository. Every occurrence remains a Domain Issue and Project item even when
the Domain configures an external human task manager, because recurrence
lifecycle and history are Issue- and Project-based. The external manager may
mirror or link a recurring occurrence only when its contract defines that
behavior; GitHub remains canonical, and no migration receipt permits Project
removal. Agent-owned and external-backlog Issues use the ordinary non-recurring
lifecycle.

## Declaring recurrence

A recurring Issue has an exact `## Recurrence` heading in its body. The text
under that heading is the durable schedule rule and must identify exactly one
next calendar date from the nominal occurrence. Keep the rule concise and
unambiguous, for example:

```markdown
## Recurrence

Every Friday.
```

```markdown
## Recurrence

Every two weeks on Monday.
```

```markdown
## Recurrence

The first Monday of every month.
```

The rule describes the cadence, not an occurrence date. The Project's
`next-action-date` schedules when the user intends to act and may be moved
earlier or later during a [Daily Briefing](daily-briefing.md). It does not
change the recurrence's nominal slot.

Every recurring Issue body records that slot on its first line:

```text
Pan: recurrence occurrence YYYY-MM-DD
```

The date must be a real calendar date and must satisfy the recurrence rule.
This marker is the durable per-occurrence recurrence state. Do not put it in
conversation history, a local scheduler, or a new Project field.

Before proposing or applying any `next-action-date` change to an open recurring
Issue, re-read and require a valid occurrence marker. If it is absent, complete
the backward-compatible marker migration below while the current planning date
and history are still intact. The marker write is objective recurrence-state
repair rather than discretionary planning: after a live re-read, Pan may
automatically write only the first-line marker and verify it while preserving
the planning date and all other content. It may precede Daily Briefing
agreement. If the nominal occurrence is ambiguous, or a marker exists but is
unusable, leave the date unchanged and ask the user.

Compute a successor from the stored nominal occurrence, choosing the first
cadence date strictly after both that occurrence and the completion day. The
completion day is the Issue's `closedAt` day when another client closed it, or
the day of the user's explicit completion request when Pan performs rollover
first. Thus an every-Friday occurrence nominally `2026-09-04` that is moved to
Thursday `2026-09-03` still produces Friday `2026-09-11`, not the next day.
When completion passes one or more nominal cadence dates, note the skipped
dates in the rollover comment.

Pan re-reads the Issue rule, occurrence marker, and Project date before
rollover. A direct rule edit changes future cadence interpretation; a Project
date edit changes only planned attention.

## Completion signal

The Issue state is the client-independent completion signal:

- Closing the Issue as **completed** means this occurrence was performed and
  requires a successor. Pan reconciles it automatically during triage even if
  the GitHub UI or another client performed the closure.
- Closing the Issue as **not planned** ends the series. Pan creates no
  successor and reconciles the Project item to `Status=rejected`.
- Setting only the Project `Status=done` while leaving the Issue open is not a
  completion signal; it is a state conflict to surface.

An explicit request for Pan to complete an open recurring task approves the
same rollover immediately. Pan creates and verifies the successor before it
closes the current Issue. Direct closure reverses that order, but the next
triage reaches the same durable state.

An explicit request to cancel an open series creates no successor. After
confirming that no successor marker already exists, clear and verify the
current `next-action-date`, close and verify the Issue as not planned, then set
`Status=rejected` as the final Project write of the transition. If the date
clear fails, leave the Issue open and status nonterminal.

For an occurrence already closed as not planned, re-read its Project item and
require a valid occurrence marker. If the marker is absent, successfully infer
and verify it under [backward compatibility](#backward-compatibility) while the
current date remains intact. If inference is ambiguous or an existing marker
is unusable, preserve `next-action-date` and terminal Status until the conflict
is resolved. Otherwise, if Status is already `rejected`, clear only a stale
`next-action-date`, verify it is empty, and do not rewrite Status. If its live
Status is nonterminal, clear and verify the date before setting
`Status=rejected` as the final write. Surface a different terminal Status as a
conflict without changing it.

## Creating or reconciling the successor

Re-read the Issue (including `stateReason` and `closedAt`), its comments, and
its Project item immediately before acting. Run this procedure for an open
Issue only after an explicit completion request, or automatically for a closed
Issue whose reason is completed.

1. Confirm that the Issue is `human`-owned, in the configured Domain
   repository, has a usable `## Recurrence` rule, and has a
   valid nominal occurrence marker. If the marker is absent, follow
   [backward compatibility](#backward-compatibility) before continuing. If a
   marker exists but is unusable, stop for confirmation rather than replacing
   it. If the Issue is already closed, confirm that its reason is completed; a
   not-planned closure follows the cancellation rule above.
2. Look for a current-Issue comment whose first line is
   `Pan: next occurrence <Issue URL>`. If one exists, re-read that successor
   and resume or repair its setup instead of creating another Issue. If there
   is no marker, also search open and closed Domain Issues for an exact
   `Pan: previous occurrence <current URL>` line before creating anything. If
   the evidence is conflicting or a target cannot be identified safely, stop
   and ask the user rather than risking a duplicate.
3. Compute the next nominal date from the rule, stored nominal occurrence, and
   completion day.
4. Create the successor in the Domain repository. Carry forward the title,
   reusable task instructions, and the exact `## Recurrence` section; do not
   copy occurrence-specific discussion or one-time migration notes. Put
   `Pan: recurrence occurrence <next nominal date>` on the first line and
   include `Pan: previous occurrence <current URL>` in the body so a successful
   creation remains discoverable even if a later write fails.
5. Immediately add a current-Issue comment whose first line is
   `Pan: next occurrence <successor URL>`.
6. Add the successor to the same Project and set `owner=human`,
   `Status=ready`, `next-action-date` to the next nominal date, and the current
   occurrence's `priority` and `workstream`. Leave all playbook, session,
   human-attention, and lease fields empty.
7. Re-read the successor Issue and Project item. Only after GitHub confirms the
   links and all required fields, re-read the current Project item. If it
   already has `Status=done`, first require the Issue to be closed as completed,
   then clear only its `next-action-date`, verify the field is empty, and do not
   rewrite Status; otherwise surface the closure conflict without changing
   anything. If it has a different terminal Status, surface the conflict
   without changing it. Only when its live Status is nonterminal, clear and
   verify `next-action-date`, close the current Issue as completed if it is
   still open and verify its completed closure, then re-read the item, require
   the date to remain empty, and set `Status=done` as the final Project write
   of the transition. If the clear fails, leave the current Issue open when Pan
   controls closure and leave its status nonterminal. The nominal date remains
   durable in the Issue marker.

If successor creation, linking, field setup, or confirmation fails, leave the
current Project item not `done`, surface the incomplete rollover, and retry
from the existing marker when possible. Never reopen an occurrence that another
client already closed.

## Adopting an existing task

An explicit request to adopt an existing human task as recurring authorizes the
adoption, but not an inferred nominal occurrence the user has not seen:

1. Determine the recurrence rule and nominal occurrence. If the user's request
   states the nominal date explicitly, use it. Otherwise derive only a proposed
   date from the task's durable date and history, show that date to the user,
   and obtain confirmation. Do not write an occurrence marker while that date
   is inferred but unconfirmed.
2. Re-read the Issue and Project item after the date is explicit or confirmed.
   Add the unambiguous `## Recurrence` section and put
   `Pan: recurrence occurrence YYYY-MM-DD` on the Issue body's first line.
3. Re-read the Issue and verify the exact marker and rule before changing
   `next-action-date`.
4. If the Issue is open, initially set `next-action-date` to the nominal date
   unless the user explicitly schedules attention for another date. Preserve
   all other Issue history and Project fields, and do not create a successor
   during adoption.
5. If the Issue is already closed, do not assign or retain a planning date for
   later triage. Preserve the nominal occurrence in the marker and immediately
   reconcile its completed or not-planned closure under the normal rules. That
   reconciliation clears and verifies the date, and writes terminal Status last
   only when the live Status is nonterminal.

This makes the existing Issue the current occurrence without rewriting history
or creating a duplicate reminder.

## Backward compatibility

Older recurring Issues may have a `## Recurrence` section but no nominal
occurrence marker. This is migration of an already-recurring task, not adoption
of an ordinary task. Before rollover, or before proposing any planning-date
change to an open occurrence, infer the nominal occurrence only when the rule,
current `next-action-date`, and durable Issue or Project history identify
exactly one cadence date. A current action date that satisfies the rule is
sufficient only when history gives no evidence that it was rescheduled.

When inference is genuinely unambiguous, add the marker as the Issue body's
first line, re-read and verify it, and continue from that nominal date. Perform
this while the existing planning date remains intact. This objective migration
is approval-free recurrence reconciliation. It writes only the first-line
marker and does not change `next-action-date`; Daily Briefing and scheduled
triage perform it before any discretionary planning.

When more than one nominal date is plausible, surface one focused question and
do not create a successor, change the planning date, or change terminal Project
state. A Daily Briefing cannot satisfy its terminal-date invariant until this
evidence conflict is resolved. A malformed, conflicting, or otherwise unusable
existing marker is not markerless migration: require the user to confirm its
correction. Never guess from conversation history or completion date.
