# Pan overview

Pan is a Markdown-defined chief of staff for one configured Domain. The Domain
contains workstream knowledge, playbooks, instructions, and one authoritative
task backend. The public Pan repository contains reusable contracts, agents,
the backend adapters, and one small runner.

## Components

- **Tasks** record work in GitHub Issues + Project or Todoist. See
  [Task and session model](task-lifecycle.md).
- **Task Manager** performs backend-neutral CRUD, comments, and explicit
  session requests. It does not make business decisions.
- **Chief** reads the complete live portfolio, recommends or applies authorized
  task edits, and records business judgment in Markdown and comments.
- **Runner** opens or resumes only explicitly requested task sessions and
  supervises only its own local processes. See [Runner](runner.md).
- **Workers** execute one task according to its playbook and interact directly
  with the user when needed. See
  [Worker base instructions](worker-base-instructions.md).
- **Hub** is the local web interface and ACP headless session host. It presents
  the main assistant as Pan and task workers through a shared chat panel.
  See [Pan Hub](hub.md) for the initial restricted rollout.
- **Workstreams** hold durable narrative context in the Domain or additional
  configured stores while tasks keep one globally unique unqualified path.
- **Daily Briefing** considers the complete eligible portfolio, regardless of
  dates, before proposing human focus and agent requests.

## Core separation

Work Status is `open`, `done`, or `rejected`. Agent status is empty,
`requested`, or `running`. The saved session ID is independent and persists
after closure.

There is no permanent Pan owner and no next-action/state pair engine.
Authorization, dependencies, holds, review gates, delivery decisions, and
completion evidence remain in task text, comments, workstreams, Domain
instructions, and playbooks. The runner never infers them.

## State rules

The selected backend is the only task state. Local runner files describe only
processes it launched. Conversation history, browser memory, and local runner
files are not a second queue.

Read live state before acting, edit only intended fields, surface errors, and
verify writes. Use the Project's order as user precedence within equal
priority. Never infer task completion or session release from a comment.

## Reading guide

| Need | Contract |
| --- | --- |
| Backend record and commands | [Task backends](task-backends.md) |
| GitHub fields | [Project schema](project-schema.md) |
| Work/session meanings | [Task and session model](task-lifecycle.md) |
| Portfolio classification | [Triage](triage.md) |
| Daily planning | [Daily Briefing](daily-briefing.md) |
| Worker routing | [Playbooks](playbooks.md) |
| Process supervision | [Runner](runner.md) |
| Web UI and headless sessions | [Pan Hub](hub.md) |
| Task execution | [Worker base instructions](worker-base-instructions.md) |
