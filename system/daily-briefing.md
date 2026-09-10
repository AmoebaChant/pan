# Daily Briefing

The Daily Briefing turns complete live Domain state into one explicitly agreed
human attention plan. It uses `next-action-date`; it never schedules AI
execution. Read [task lifecycle](task-lifecycle.md), [project
schema](project-schema.md), [triage](triage.md), [recurrence](recurrence.md),
and [workstreams](workstreams.md).

## Establish the live picture

1. Read optional Domain `pan.md`.
2. Fully paginate every configured Domain Issue and Project item, preserving
   canonical Project order.
3. Read every workstream README and every declared external backlog Issue set.
4. Reconcile the narrow objective facts permitted by triage, then re-read.
5. Validate recurrence occurrence markers before proposing a date change.
6. Treat missing pages, inaccessible sources, lifecycle/action mismatches,
   stale revisions, and terminal/Issue-state conflicts as incomplete. Stop
   before discretionary writes.

GitHub is the canonical task store. Imported-source ids are provenance, not
another queue to merge at briefing time.

## Recommend before changing dates

The first planning pass is read-only except objective reconciliation. Consider
every nonterminal task, not only tasks already dated today:

- exact human checkpoints (`clarify`, `discuss`, `approve`, `review`, `act`);
- overdue, today, future, and unscheduled attention commitments;
- AI work in motion, paused, uncertain, or waiting on the user;
- external waits, deliberate holds, dependencies, and deadlines;
- workstream priorities and durable `Pan planning guidance:`; and
- optional read-only Daily Briefing context from `pan.md`.

Recommend a realistically sized Today set. The focused proposal contains:

- **Today** — every task Pan recommends receiving human attention today,
  regardless of its current attention date; and
- **Not today** — every overdue or currently-today task Pan recommends moving
  to a future agreed date or returning to unscheduled.

Future or unscheduled tasks not selected for Today are considered but omitted
from the focused review. Their dates stay unchanged.

Show every proposed date change. Preserve Project order among otherwise
comparable tasks. Explain why each item belongs in its group. The user reviews
Pan's recommendation; do not present an undecided accept/postpone queue.

## Date semantics

For every nonterminal task:

- today means the user explicitly committed human attention today;
- future means bring human attention back on that date;
- empty means unscheduled; and
- past remains an unresolved prior commitment until the user explicitly
  reconsiders it.

A new `ready-for-human` checkpoint enters Needs me but not Today. Handoffs
preserve explicit scheduling. Completion or rejection clears the date.

`deadline` is separate and never a not-before gate. A recurrence's nominal
occurrence and cadence live in the Issue, never in the attention field.
Changing planning does not change cadence.

No date gates or sorts AI execution. The briefing may show AI work because it
affects the user's day, but does not date it merely because AI has the next
move. Mixed tasks may retain a human attention date while AI works.

## Review and agreement

Iterate as the user supplies meetings, energy, opportunities, focus, or other
constraints. A request to start a briefing is not approval of the first plan.

When the local review UI is available:

1. publish the complete focused proposal;
2. immediately show the clickable URL;
3. wait for the matching revision;
4. incorporate the complete marked-up review and publish another complete
   revision when needed; and
5. treat only **Approve proposal** as explicit agreement.

Sending feedback is not approval. A side question does not end the review:
answer it, then resume the same wait unless the user pauses, cancels, or
redirects the briefing.

A revised proposal describes Pan's response, not the user's action. Never call
a disagreed recommendation "accepted."

## Durable planning guidance

Preserve durable situational guidance in the authoritative Issue body:

```text
Pan planning guidance: <faithful concise wording>
```

Replace the one marker when superseded and remove it only when explicitly
withdrawn. Preserve unrelated content. Vague language remains vague; do not
turn "next week" or "on a quiet day" into an invented date.

The browser, service, and conversation hold only drafts. If guidance cannot be
preserved and verified in the Issue, do not claim the approved plan was fully
applied.

## Apply the agreed plan

After explicit agreement:

1. Re-read the complete task set and every affected Issue.
2. Require each expected `task-revision`.
3. Write and verify agreed planning guidance first.
4. Set today's date on exactly the agreed Today tasks.
5. Move or clear every agreed overdue/currently-today Not today task.
6. Leave omitted future and empty dates unchanged.
7. Increment each affected task revision last and verify the resulting Issue
   block/Project projection.

If any read, write, or verification fails, stop further writes and report the
confirmed partial state. Never return a success-shaped fallback.

Finish only when every affected write verifies, every terminal task has an
empty attention date, and every nonterminal date is either empty, today, a
future agreed date, or an explicitly unresolved past date the approved plan
left visible for follow-up. Report the confirmed Today set and changes.

## Domain-specific considerations

A `## Daily Briefing` section in `pan.md` may name additional read-only context
and ranking considerations. It cannot authorize discretionary task mutations,
date writes before agreement, AI execution, scope expansion, or work outside
the configured Domain.
