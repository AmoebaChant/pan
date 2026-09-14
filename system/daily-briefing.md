# Daily Briefing

The Daily Briefing turns complete live Domain state into one explicitly agreed
human attention plan **and** one useful agent-throughput plan. It answers both
"What should I work on today?" and "What should agents start or continue
working on?" Human attention dates schedule only human work; agent engagement
uses the selected lifecycle's explicit request transition. Read [task lifecycle](task-lifecycle.md), [project
schema](project-schema.md), [triage](triage.md), [recurrence](recurrence.md),
[workstreams](workstreams.md), and [agent momentum](agent-momentum.md).

## Establish the live picture

1. Read optional Domain `pan.md`.
2. Run the configured [source intake](source-intake.md) preview and deliberate
   apply. Stop before planning if source pagination, scope, receipts, or apply
   results are incomplete; report any confirmed partial registration honestly.
3. Fully paginate every task in the selected backend and preserve its
   canonical ordering. For the GitHub compatibility backend, this means every
   configured Domain Issue and Project item.
4. Read every workstream README and every declared external backlog Issue set.
5. Reconcile the narrow objective facts permitted by triage, then re-read.
6. Validate recurrence occurrence markers before proposing a date change.
7. Treat missing pages, inaccessible sources, lifecycle/action mismatches,
   stale revisions, and terminal/backend-state conflicts as incomplete. Stop
   before discretionary writes.
8. Before classifying tasks, read the complete live machine playbook inventory
   and definitions, worker reports, session associations, and runner capacity
   required by the [agent-opportunity pass](agent-momentum.md#agent-opportunity-pass).

The Domain's selected backend is the canonical task store. Source links are
provenance, not another queue to merge at briefing time.

## Explicit agent-opportunity pass

Perform the shared [agent-opportunity pass](agent-momentum.md#agent-opportunity-pass)
across every eligible nonterminal task before finalizing the human plan.
Reading the backlog without matching its tasks to live playbooks and useful
conversation/investigation modes is insufficient. Neither an unlabeled task
in a named project nor a newly imported/untriaged task is inherently human-only.

Account for each task with the shared internal agent disposition and concrete
reason. This is separate from its visible briefing section or human date.
Before omitting a plausible playbook-matched candidate, explain internally why
no useful agent step is being requested or proposed. Dates, priority, legacy
AI-ready markers, session absence, and full runner capacity are not discovery
filters. Never report "no agent opportunities" without completing this pass.

Surface all useful candidates, distinguishing permission needed, authorized
work eligible to start now, queued requests, and observed running work.
Required missing facts block the implementation that needs them; consider a
separate bounded discovery step if useful, otherwise surface the blocker and
proposed durable guidance without presenting implementation as ready.

## Recommend before changing dates

The first planning pass is read-only except objective reconciliation and
engagement already covered by standing authority under the shared pass.
Discretionary date, guidance, and agent-request writes still require approval.
Its primary value is portfolio-wide selection: identify work that should be
pulled forward into Today and useful work agents can advance, not merely review
tasks already dated today or overdue.
Evaluate every nonterminal task as a possible Today candidate, including every
future-dated and unscheduled task.

Do not use the current attention date, overdue state, priority, project, or a
short metadata query as a filter that excludes tasks from consideration.
Sorting and batching may make the review efficient, but Pan must inspect enough
of every task's title, project, priority, dates and deadline, lifecycle or
attention state, description, durable planning guidance, and relevant reports
to make an informed bubble-up decision. Specifically consider:

- exact human checkpoints (`clarify`, `discuss`, `approve`, `review`, `act`);
- overdue, today, future, and unscheduled attention commitments;
- AI work in motion, paused, uncertain, or waiting on the user;
- external waits, deliberate holds, dependencies, and deadlines;
- workstream priorities and durable `Pan planning guidance:`; and
- optional read-only Daily Briefing context from `pan.md`.

Before publishing, assess every eligible nonterminal task's **current next
actor** as human, agent, external, or deliberate hold. This is a planning
assessment, not a permanent owner field. Native person assignment remains
outcome responsibility and backend scope/assignee policy still excludes other
people's work. A task may move agent → human checkpoint → agent repeatedly.
Respect current waits, holds, checkpoints, recurrence restrictions, and
session affinity while still considering whether later agent work is useful.

In addition to its internal agent disposition, every nonterminal task must
have one presentation decision:

- recommend it for Today;
- include it in Not today because an overdue or current-today commitment should
  move;
- surface an existing worker checkpoint in Needs your attention, prioritized
  for Today or later;
- propose a new or resumed agent engagement;
- continue or request standing-authorized agent engagement transparently; or
- deliberately omit it after deciding its human date should remain unchanged
  and no visible agent/checkpoint action is warranted.

The focused proposal does not display every omitted task, but omission must be
the result of portfolio review rather than a date- or priority-based shortcut.
When no future-dated or unscheduled task is promoted, Pan should be able to
explain which plausible bubble-up candidates it considered and why none
displaced the proposed Today work. Explain agent omissions from the separate
agent assessment, not from whether they displaced human Today work.

For an attached worker checkpoint, surface the task once, exact requested action,
machine/session context, and worker terminal location. Direct the user to that
terminal rather than asking the worker's question again in the chief
conversation. A `ready-for-human/review` completion gate is Needs me; a
verified `done/none` outcome is recent informational activity, not attention.
The checkpoint's Today/later recommendation is explicit and its human-date
effect is shown separately. Never render a duplicate copy of the same task in
Today or Not today.

Recommend a realistically sized Today set. The focused proposal contains four
sections. Choose one primary section per task from its current next actor and
recommendation: an existing checkpoint takes **Needs your attention**,
agent-led work takes **Proposed agent starts**, and other human-led work takes
**Your Today plan** or **Not today**. Show all independent effects on that one
row.

- **Your Today plan** — human-led, non-checkpoint work Pan recommends receiving
  human attention today, regardless of its current attention date;
- **Proposed agent starts** — agent-led approval-ready new or resumed engagement,
  plus standing-authorized requests clearly marked as already authorized;
- **Needs your attention** — existing worker checkpoints, each explicitly
  prioritized for Today or later; and
- **Not today** — every overdue or currently-today task Pan recommends moving
  to a future agreed date or returning to unscheduled.

Future or unscheduled tasks not selected for Today are considered but omitted
from the human-date sections. Their dates stay unchanged. This focused-human
rule never hides an agent opportunity or existing checkpoint: an undated,
unlabeled, sessionless task can still appear in Proposed agent starts.

Every row declares `humanDateAction=keep|set|clear`; `keep` is a no-op and is
not interchangeable with clearing. Agent rows also declare
`agentAction=none|request-new|request-resume`, authorization status, proposed
playbook or conversation/work mode, expected outcome, and whether a later
human checkpoint is expected, not expected, or uncertain. Confirmed running
work uses `none` with already-requested status rather than fabricating a new or
resume request. Absence of an agent date action never sets or clears a human
date. Preserve backend order among otherwise comparable tasks and explain why
each item belongs in its group.

## Date semantics

For every nonterminal task:

- today means the user explicitly committed human attention today;
- future means bring human attention back on that date;
- empty means unscheduled; and
- past remains an unresolved prior commitment until the user explicitly
  reconsiders it.

A new `ready-for-human` checkpoint enters Needs me but not Today. Handoffs
preserve explicit scheduling. Completion or rejection clears a non-recurring
date; completing a recurring occurrence advances it under native cadence.

`deadline` is separate and never a not-before gate. For Todoist, the native due
date is the human attention date. Moving a recurring task for an agreed plan
must use the backend's recurrence-preserving occurrence-date operation; it must
not replace the recurrence expression or cadence.

No date gates or sorts AI execution. The briefing may show AI work because it
affects the user's day, but does not date it merely because AI has the next
move. Mixed tasks may retain a human attention date while AI works.

## Agent engagement semantics

Evaluate the complete live eligible backlog for agent opportunities without a
date, priority, label, session, legacy-status, or import-state prefilter. When
the task is sufficiently clear and an existing Domain policy or playbook
authorizes the bounded engagement, request
it and show the standing-authorized effect rather than asking for retroactive
approval. Otherwise propose it for explicit approval and do not queue it.

A request authorizes engagement on the defined task under the selected policy
or playbook. It does not grant destructive, publishing, spending, production,
or scope-expanding authority unless that authority is explicit. A
conversation/clarification engagement may be proposed without an implementation
playbook; say that implementation is not yet authorized.

Compatibility mode requests only checked `ready-for-ai/execute` work with
execution authorization. `attention-labels-v1` requests the configured native
attention transition. These are conditional backend mappings, not universal
labels. A queued request is not a launched agent.

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

Task-level Agree/Disagree applies equally to date changes, agent proposals, and
checkpoint prioritization. Sending feedback is not approval, and any unsent or
submitted negative feedback requires a revised complete proposal before
approval. A side question does not end the review:
answer it, then resume the same wait unless the user pauses, cancels, or
redirects the briefing.

A revised proposal describes Pan's response, not the user's action. Never call
a disagreed recommendation "accepted."

## Durable planning guidance

Preserve durable situational guidance in the authoritative task description:

```text
Pan planning guidance: <faithful concise wording>
```

Replace the one marker when superseded and remove it only when explicitly
withdrawn. Preserve unrelated content. Vague language remains vague; do not
turn "next week" or "on a quiet day" into an invented date.

The browser, service, and conversation hold only drafts. If guidance cannot be
preserved and verified in the selected backend, do not claim the approved plan
was fully applied.

## Apply the agreed plan

After explicit agreement:

1. Re-read the complete task set and every affected task.
2. Require each expected backend revision and re-check scope, authorization,
   session association, and current gate/hold state.
3. Write and verify agreed planning guidance first.
4. Through the common task tool, set today's native attention date on exactly
   the agreed Today tasks.
5. Move or clear every agreed overdue/currently-today non-recurring Not today
   task; move recurring occurrences without clearing their recurrence.
6. Apply exactly the selected, approval-required agent attention transitions;
   do not repeat standing-authorized or already-requested transitions.
7. Leave omitted/unselected tasks and every `humanDateAction=keep` date
   unchanged.
8. Verify every guidance/date write and every attention request.

If any read, write, or verification fails, stop further writes and report the
confirmed partial state. Never return a success-shaped fallback.

Finish only when every affected write verifies and every nonterminal attention
date is either empty, today, a future agreed date, or an explicitly unresolved
past date the approved plan left visible for follow-up. Report the confirmed
human plan, agents actually launched if independently observed, agents queued,
waiting workers, and partial failures. Never describe a queued request as a
launch.

## Domain-specific considerations

A `## Daily Briefing` section in `pan.md` may name additional read-only context
and ranking considerations. It cannot authorize discretionary task mutations,
date writes before agreement, AI execution, scope expansion, or work outside
the configured Domain.
