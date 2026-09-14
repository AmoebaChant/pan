# Agent momentum

Agent momentum is a first-class portfolio scan owned by the one persistent Pan
chief. It keeps useful authorized work moving between Daily Briefings without
turning the runner into a planner. Read [triage](triage.md), [attention
lifecycle](attention-lifecycle.md), [runner](runner.md), and [Daily
Briefing](daily-briefing.md).

## Agent-opportunity pass

Every Daily Briefing, triage/portfolio pass, and agent-momentum scan must
perform this explicit pass before finalizing its recommendations. The chief
actively finds useful bounded contributions for agents and requests them when
authorized; merely enumerating tasks or reporting existing labels is not a
completed pass.

### 1. Establish tasks and capabilities live

Perform the complete source intake, authoritative-backend pagination,
declared backlog/workstream read, native report read, and objective
reconciliation required for the pass. Include every eligible nonterminal task
under the backend's scope and assignee policy.

Before classifying tasks, read the live [playbook](playbooks.md) inventory and
definitions for the configured machine. Build an internal catalogue of scope,
required inputs, authority, human gates, workspace constraints, and enabled
capacity from their contents, not just their names. Read each definition once
per pass rather than rereading it for every task. For a task associated with
another machine, respect that association and its machine-specific definitions;
never assume the local playbook authorizes a cross-machine resume.

Also read live worker reports, session associations, and runner
liveness/capacity. Report inaccessible or incomplete evidence; do not claim a
complete pass or infer that no playbook fits because its definitions were not
read.

### 2. Assess every task for a useful agent step

For each task, use its actual scope, description, clarity, required identifiers,
dependencies, durable guidance, reports, and playbook fit. Determine whether an
available playbook can advance it, and also consider bounded investigation,
conversation, or clarification when an implementation playbook is unnecessary.
A playbook match establishes a possible capability, not authorization.

Dates, priority, current labels, session presence, legacy status, and
source-import state must never exclude a task from this assessment. Unlabeled
tasks in named projects and newly imported or untriaged tasks are candidates
too. `Ready For AI`, `ready-for-ai`, and similar legacy markers are not the
discovery mechanism or sufficient evidence that prerequisites are met.
Importing a task does not authorize it, but it also does not assign its next
step permanently to a human.

Assess the current next actor as human, agent, external, or deliberate hold.
This is a current planning judgment, not a permanent owner field. Native person
assignment remains outcome responsibility. A human-led outcome can still have
a useful bounded agent contribution without transferring responsibility.

### 3. Account for every task

Assign each eligible task one internal agent disposition, with its task ID,
matching playbook or work mode if any, concrete reason, authorization basis or
missing approval, and next step:

| Disposition | Required conclusion |
| --- | --- |
| Engage under standing authority | A useful bounded step has its prerequisites and explicit standing permission; request new or resumed engagement after live safety checks. |
| Propose engagement for approval | A useful bounded step has its prerequisites but needs consent; include an approval-ready proposal without requesting it yet. |
| Already engaged | A live request, worker, or existing worker checkpoint accounts for the task; describe queued/running/waiting accurately and do not duplicate it. |
| Blocked by missing information | A specific required fact, dependency, or reliable state evidence is missing and no useful permitted discovery step can proceed; name what would unblock it. |
| Waiting externally | A concrete external dependency currently prevents progress; identify the event being awaited. |
| Held | An explicit user hold prevents engagement; preserve it. |
| Recurring/unsupported | A concrete lifecycle, machine, disabled-playbook, or tool limitation prevents this engagement; identify the limitation. |
| Deliberately unsuitable for AI | No useful bounded agent contribution fits the task, including investigation or conversation; explain why human work remains appropriate. |

A saved session ID alone does not mean "already engaged." Released sessions
with useful authorized work should be assessed for resumption. An unresolved
worker question or review gate remains a human checkpoint, not an automatic
resume. Conflicting or orphaned state blocks engagement until reliable evidence
is available; never choose a convenient interpretation.

Before omitting any plausible candidate, especially one with a matching
playbook, record a task-specific reason. "Undated," "low priority,"
"untriaged," "no label/session," and "the runner is full" are not sufficient
omission reasons. Account for all unique eligible task IDs before publishing;
an unread task is not a deliberately unsuitable one. If coverage is incomplete,
say so rather than claiming there are no further agent opportunities.

This is internal working evidence for the pass, not a new task field, label,
shadow queue, or list the user must manage. Keep enough evidence to explain an
omission on request. Do not post a repetitive disposition comment to every task.

### 4. Handle missing information without losing the opportunity

A required identifier or other prerequisite blocks the implementation that
depends on it, even when the task appears AI-ready or has a matching playbook.
Do not present that implementation as ready for approval; consent is not a
substitute for the missing fact, and the chief must not invent it.

If an agent can safely discover the fact or do another useful bounded step,
assess that explicit investigation instead and state its limits. Requested
conversation/clarification can also be useful without implementation readiness.
Otherwise surface the specific blocker and the input needed, rather than
hiding the task or launching a worker merely to repeat an already-known question.

Record the factual dependency as durable task guidance through the common task
tool only when the user's request or standing policy authorizes that write;
otherwise include the proposed guidance in the review for approval. Preserve
existing content, reread revisions, and verify writes. Existing worker
questions stay with their worker terminal; do not relay them through the chief.

### 5. Request useful work and present the whole opportunity set

After the complete assessment, request every eligible bounded engagement that
standing policy/playbook authority permits, subject to its actual limits.
Show approval-required candidates as proposals instead. Do not repeatedly ask
for consent already granted, and do not turn a mere recommendation into a
request when consent is absent.

Surface all useful candidates, not just the one that fits the next free slot.
Distinguish approval-needed proposals, authorized work eligible to start now,
authorized requests queued behind capacity, and independently observed running
workers. A currently full slot delays launch, not discovery or a valid queued
request. A disabled playbook or unsafe resource is a real constraint, not a
claim that a launch will happen when a slot frees.

An independently confirmed running worker is already engaged. Represent it
with no new agent action and already-requested/running status; never describe
it as `request-new` or `request-resume`. New/resume semantics apply only when
the chief is actually requesting or proposing engagement.

Use task priority, impact, deadlines, dependencies, and workstream goals to rank
opportunities; human attention dates never rank, gate, or authorize AI work.
Communicate the intended ordering through supported backend operations only
when authorized. Do not claim the mechanical runner implements an ordering it
does not support. Respect explicit queue/admission limits and disclose useful
deferred candidates instead of silently dropping them.

Use the briefing's existing sections and independent effects. Keep unrelated
future/undated human backlog out of the focused display, but include useful
agent candidates regardless of their dates. Surface blocked opportunities in
the summary or as an appropriate human next step, not as a runnable agent
proposal or a fabricated worker checkpoint. Report required worker
clarification, approval, review, merge, release, or deployment gates using the
selected lifecycle's durable human-attention state and terminal context;
prioritize those gates for Today or later without automatically dating them.

An engagement request covers only the defined task under its policy/playbook.
Conversation or clarification can be proposed without an implementation
playbook. Destructive, publishing, spending, production, scope-expanding, and
other consequential authority remains explicit. Re-read affected tasks,
reports, association, authorization, and safety state before each request and
verify the result. A partial failure is reported as such, not as a completed
agent-opportunity pass with all work started.

## Resume and gate safety

Resume never overrides an unanswered human checkpoint, external wait,
deliberate hold, unknown process, different-machine association, missing
session history, recurrence restriction, or a live session that cannot accept
a message. Do not replace a conversation, duplicate dispatch, invent approval,
or terminate a process automatically. Use the mechanical boundaries in
[attention lifecycle](attention-lifecycle.md) and [runner](runner.md).

Compatibility mode dispatches only checked authorized
`ready-for-ai/execute`. `attention-labels-v1` uses its configured native
attention request. These are conditional mappings, not a universal label
model. A queued request is not proof that a worker launched.

## Optional cadence

Momentum has no implicit cadence. A Domain may declare reusable chief
configuration in `pan.md`, for example:

```yaml
agentMomentum:
  enabled: true
  cadence: "every 3 hours"
```

Both `enabled: true` and an explicit cadence are required. Disabled or absent
configuration means no autonomous schedule. On chief startup and after config
changes, the canonical chief uses the session's supported schedule tools to
list its owned schedules, create at most one momentum schedule, reconcile a
changed cadence, and remove its schedule when disabled. Repeated startup must
not duplicate it. If scheduling is unavailable, report the limitation and
continue interactive operation.

The scheduled prompt wakes the same canonical chief and names this contract; it
does not launch a worker or second chief. Workers and runners never create or
own recurring momentum scans. Pan defines no scheduler service or framework of
its own.
