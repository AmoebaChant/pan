# Recurring tasks

A recurring human commitment is a series of ordinary Pan tasks. Each
occurrence has its own Domain Issue and Project item. Completing an occurrence
creates its successor, then completes and closes the current Issue through the
normal lifecycle. Pan never keeps one Issue open forever by overwriting its
date: separate Issues preserve the instructions, discussion, completion record,
and Project history for every occurrence.

Recurrence is supported for `human`-owned Issues in the configured Domain
repository. Agent-owned and external-backlog Issues use the ordinary
non-recurring lifecycle.

## Declaring recurrence

A recurring Issue has an exact `## Recurrence` heading in its body. The text
under that heading is the durable schedule rule and must identify exactly one
next calendar date from the current occurrence date. Keep the rule concise and
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
`next-action-date` is the date of the current occurrence and is required on
every open recurring task. Derive future dates from that scheduled date rather
than from when the user happens to complete the work, so late completion does
not shift the series. When an occurrence is completed after one or more later
scheduled dates have passed, advance the same rule to the first date after the
completion day and note the skipped dates in the rollover comment.

The current date must satisfy the rule. If the rule or current date does not
determine one next date, ask the user before creating or migrating the
recurrence. Do not put recurrence state in conversation history, a local
scheduler, or a new Project field.

## Completing an occurrence

An explicit request to complete a recurring task approves the rollover and
completion writes below. Re-read the Issue, its comments, and its Project item
immediately before acting.

1. Confirm that the Issue is open, `human`-owned, in the configured Domain
   repository, has a usable `## Recurrence` rule, and has a
   `next-action-date`.
2. Look for a current-Issue comment whose first line is
   `Pan: next occurrence <Issue URL>`. If one exists, re-read that successor
   and resume or repair its setup instead of creating another Issue. If there
   is no marker, also search open and closed Domain Issues for an exact
   `Pan: previous occurrence <current URL>` line before creating anything. If
   the evidence is conflicting or a target cannot be identified safely, stop
   and ask the user rather than risking a duplicate.
3. Compute the next date according to the rule and the current
   `next-action-date`.
4. Create the successor in the Domain repository. Carry forward the title,
   reusable task instructions, and the exact `## Recurrence` section; do not
   copy occurrence-specific discussion or one-time migration notes. Include
   `Pan: previous occurrence <current URL>` in the new Issue body so a
   successful creation remains discoverable even if a later write fails.
5. Immediately add a current-Issue comment whose first line is
   `Pan: next occurrence <successor URL>`.
6. Add the successor to the same Project and set `owner=human`,
   `Status=ready`, the computed `next-action-date`, and the current
   occurrence's `priority` and `workstream`. Leave all playbook, session,
   human-attention, and lease fields empty.
7. Re-read the successor Issue and Project item. Only after GitHub confirms the
   links and all required fields, close the current Issue as completed,
   re-read it, and set its Project `Status=done`. Preserve the current
   occurrence's `next-action-date`; never advance or clear it on the historical
   item.

If successor creation, linking, field setup, or confirmation fails, leave the
current Issue open and not `done`, surface the incomplete rollover, and retry
from the existing marker when possible.

## Adopting an existing task

Migrate an existing human task in place:

1. Add an unambiguous `## Recurrence` section to its Issue body.
2. Keep its existing `next-action-date` as the current occurrence date and
   preserve its existing Issue history and Project fields.
3. Do not create a successor during migration. The first explicit completion
   performs the normal rollover above.

This makes the existing Issue the current occurrence without rewriting history
or creating a duplicate reminder.
