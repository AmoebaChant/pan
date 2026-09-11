# Pan overview

Pan is a personal chief of staff. It keeps track of everything you and your
agents owe, decides what should happen next, keeps always-on machines supplied
with work, and gets blocked agents back in front of you fast.

Pan is defined almost entirely in Markdown. The behavior, conventions, and
contracts in [`system/`](.) *are* the system: an agent that reads and follows
them is Pan. The code is a small [runner](runner.md) that polls for work and
launches Pan worker sessions plus an optional local
[Daily Briefing review service](briefing-ui.md), with focused automated
coverage for critical behavior. If something is ambiguous, the fix is to make
these documents clearer.

## The pieces

- **The Pan tool repository** (`AmoebaChant/pan`, this repo) — public, reusable,
  user-agnostic. It holds the system contracts, agents, skills, and the runner.
  It contains no user data.
- **The Pan Domain** — a private GitHub repository for knowledge, playbooks,
  configuration, and domain-specific instructions, plus one selected task
  backend. GitHub Issues and a Project remain the default backend; a Domain may
  instead select Todoist. See [domain](domain.md) and
  [task backends](task-backends.md).
- **The runner** — one mechanical process per machine. It polls the selected
  backend for Pan-authorized `ready-for-ai` work within local capacity and
  launches a Pan worker session. It does not prioritize or reinterpret holds.
  See
  [runner](runner.md).
- **Pan worker sessions** — headed `copilot` sessions the runner launches to
  perform a claimed task, following that task's playbook. See
  [worker base instructions](worker-base-instructions.md).
- **Daily Briefing** — an interactive review that turns complete live Domain
  state into an agreed, realistically sized plan for the user's day. See
  [Daily Briefing](daily-briefing.md).
- **Daily Briefing review UI** — an optional local, responsive review surface
  for marking up a complete proposal before sending one batch of feedback back
  to the Pan session. See [Daily Briefing review UI](briefing-ui.md).
- **Everyday task UI** — an optional local GitHub-backed surface for Today,
  Needs me, In motion, Recent activity, and All tasks. Browser code holds no
  credentials; the loopback service enforces the configured Domain boundary.
  See [Daily Briefing review UI](briefing-ui.md).

Pan works with exactly **one** Domain at a time. The Domain selects exactly one
canonical task backend. A task is a stable outcome and has no owner in the
canonical lifecycle; person assignment remains native backend data, while
human and AI turns are expressed by its exact next-action state.
See [Outcome task lifecycle](task-lifecycle.md).

## The loop

1. Issues arrive in the backlog (created by the user, by Pan, or added to the
   Project from a declared external backlog repository — the external Issue stays
   in its own repository and is only referenced by a Project item).
2. **Triage** prepares the next action, dependencies, authorization, priority,
   and playbook. Scheduled triage may apply only standing permissions and
   objective reconciliations; scope expansion and consequential decisions
   remain human. See [triage](triage.md).
3. **Daily Briefing** reviews the live portfolio and workstream context,
   recommends a plan, and, after agreement, dates exactly the selected human
   tasks for today. See [Daily Briefing](daily-briefing.md).
4. **Runners** poll the selected backend. When a task is `ready-for-ai/execute`,
   authorized, dependency-clear, non-recurring, and has a matching playbook and
   safe capacity/resources, a runner claims and launches it. Dates never gate
   or order AI work. See [runner](runner.md).
5. The **worker** does the task using the playbook's instructions, the full Pan
   system context, and the Issue contents. If it needs the user, it signals the
   runner, which records that on the Issue. See
   [worker base instructions](worker-base-instructions.md).
6. Findings and decisions are written back to **workstreams**; task lifecycle
   and recurring occurrence history stay in GitHub. See
   [workstreams](workstreams.md).

## Reading these documents

Load only what the current job needs; skip the rest until you need it.

| When you are… | Read |
| --- | --- |
| Learning the system | this file |
| Working with the user's Domain | [domain](domain.md) |
| Reading or writing Project fields | [project schema](project-schema.md) |
| Changing task state or next action | [outcome task lifecycle](task-lifecycle.md) |
| Triaging the backlog | [triage](triage.md) + [playbooks](playbooks.md) |
| Planning the user's day | [Daily Briefing](daily-briefing.md) |
| Reviewing a briefing in the local web UI | [Daily Briefing review UI](briefing-ui.md) |
| Creating or completing recurring tasks | [recurrence](recurrence.md) |
| Recording knowledge / routing info | [workstreams](workstreams.md) |
| Defining or choosing a playbook | [playbooks](playbooks.md) |
| Building or debugging the runner | [runner](runner.md) |
| Executing a claimed task | [worker base instructions](worker-base-instructions.md) |
| Improving Pan itself | [self-improvement](self-improvement.md) |

## State rules

The selected backend is the only durable task state. Local runner
state proves process/session/workspace ownership only. Workstream Markdown is
the only durable narrative. Conversation history and browser memory are not
records. Never build an undeclared second queue, cache the backlog, or treat a
prior read as current: read live in the turn you act, require the expected task
revision and worker generation where applicable, and verify writes afterward.

Approval-free task-state writes are limited to the objective reconciliations
and standing permissions defined by [triage](triage.md). Runner writes are
limited to mechanical claim, liveness, checkpoint, and result relay under a
matching revision and claim generation. A process exit changes liveness, not
the outcome state; a deliberate hold is never treated as a crash pause.
