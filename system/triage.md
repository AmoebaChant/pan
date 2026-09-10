# Triage

Triage turns live Domain Issues into clear next actions. It prepares work and
applies narrow standing permissions; it is not a coordinator and does not own
execution. Read [project schema](project-schema.md),
[outcome task lifecycle](task-lifecycle.md), [playbooks](playbooks.md), and,
when applicable, [recurrence](recurrence.md).

Always read the complete live Issue and Project sets. Use cursor pagination or
`gh api --paginate`; a command limit that returns exactly its cap is not proof
of completeness. Re-read a target immediately before mutation, require its
expected `task-revision`, and verify afterward.

## 1. Register every task

Join the complete configured Domain Issue set and declared external backlog
Issue sets to the complete Project item set by Issue URL. Add each missing
Issue as a Project item. Registration is objective and approval-free; it never
edits or reopens the Issue.

New items start non-runnable until their exact pair is prepared. Prefer
`ready-for-human/clarify` when information is missing. Do not use the retained
legacy `owner` field to classify the task. When exactly one workstream declares
an external backlog repository, initialize that workstream; leave it empty when
ambiguous.

## 2. Reconcile objective lifecycle facts

After complete reads, scheduled or interactive triage may apply these
approval-free repairs:

- verify and finish a partial terminal transition whose matching Issue closure
  and revision/generation evidence already prove the intended state;
- reconcile a closed recurring occurrence under the recurrence contract,
  creating at most one linked successor;
- add an unambiguous missing recurrence occurrence marker while preserving the
  attention date;
- clear a stale `next-action-date` only from a settled terminal item;
- finish runner lease/resource cleanup only when terminal state and generation
  match; and
- surface expired or uncertain worker liveness without turning it into a
  deliberate hold or an automatically runnable task.

A runner crash changes `worker-state` to `paused` while preserving the outcome
state, session, machine/slot, result, and current next action. Triage never
converts a `ready-for-human` checkpoint or `deliberate-hold` into
`ready-for-ai`.

For recorded pull requests, read live provider state. A merge completes a task
only when the playbook says merge is the final gate and the task's current
state/revision still expects that gate. Never infer completion merely because
AI acted or a PR merged; rollout, restart, live validation, discussion, and
other real playbook gates remain open.

## 3. Prepare the next action

For each nonterminal task, recommend one valid checked pair:

- `ready-for-human/clarify` — one focused missing fact;
- `ready-for-human/discuss` — an interactive choice or tradeoff;
- `ready-for-human/approve` — a consequential prepared action awaits consent;
- `ready-for-human/review` — a real artifact or result requires review;
- `ready-for-human/act` — the next physical/manual action is clear;
- `ready-for-ai/execute` — a bounded AI step is clear and authorized;
- `external-waiting/wait` — progress depends on an external event; or
- `deliberate-hold/hold` — the user explicitly chose not to advance it.

Also prepare:

- `priority`, considering impact, urgency, deadlines, dependencies, and
  workstream context;
- `playbook` for AI execution, read from live `playbooks/*/*.md`;
- `execution-authorized=yes` only when the user request, task, playbook, or
  standing Domain permission authorizes that bounded next step;
- `dependencies`, empty only when the next step can start;
- `workstream`, after verifying its README;
- optional `deadline`, preserving its meaning as a deadline; and
- a concise durable Current next action detail in the Issue body.

Do not set or move `next-action-date` merely because the next actor changes.
Existing schedules survive handoffs. A newly prepared human checkpoint appears
in Needs me but is not automatically committed to Today.

Recurring occurrence availability is managed only by the recurrence lifecycle.
Never prepare a recurring Issue as autonomously runnable AI work, and never
create repeated successors in a scheduled catch-up loop.

Preserve canonical Project order as precedence within equal priority.

## 4. Approval and writes

Read and recommend freely. An explicit request authorizes that specific change.
Otherwise preview current and proposed values, Issue link, exact next-action
detail, authorization/dependencies, and any date/deadline effect, then obtain
approval.

Use the revision protocol. Update the Issue block and idempotent transition
comment, increment `task-revision` last, re-read, and report only confirmed
effects. A stale revision, worker generation mismatch, incomplete read, or
failed verification stops the operation; never return a success-shaped
fallback.

Scope expansion, destructive actions, spending, publication, production
changes, and other consequential decisions remain human unless a standing
Domain policy explicitly covers the exact action.

## 5. Holds, handoffs, and recovery

- **Hold:** only an explicit human decision creates
  `deliberate-hold/hold`. It does not mean a runner crashed.
- **Worker interruption:** keep the outcome state and set
  `worker-state=paused`; preserve the session/workspace affinity.
- **Resume:** only an explicit `ready-for-ai/execute` state is runnable. A
  reusable session resumes on its owning machine/generation after live checks.
- **Human checkpoint:** keep `ready-for-human/<exact action>`. A live worker may
  continue waiting with its lease; a verified safe checkpoint may release
  execution capacity but not workspace ownership.
- **Cross-machine handoff:** preserve all results/checkpoints, prove no possible
  launcher can still write, then explicitly clear machine/session/generation.
  Never use a handoff to discard an inconvenient result.
- **Finish discussion/review:** the checkpoint remains open until the user
  explicitly finishes, rejects, or authorizes the next AI step.

## Scheduled triage

A scheduled TRIAGE pass performs the same complete live reads. It may:

- register missing Issues;
- prepare research, summaries, dependencies, proposed next actions, and
  playbook recommendations;
- apply the objective reconciliations above; and
- perform an authorized transition covered by an explicit standing permission.

It does not manufacture approval, expand scope, make consequential decisions,
date human work, resume holds/human checkpoints, or run task logic. The runner
remains mechanical.

## Daily planning

Triage prepares the portfolio. Daily commitment follows
[Daily Briefing](daily-briefing.md): recommend from complete live state, obtain
explicit agreement, and then change only the agreed human attention dates.
