# Pan overview

Pan is a personal chief of staff. It keeps track of everything you and your
agents owe, decides what should happen next, keeps always-on machines supplied
with work, and gets blocked agents back in front of you fast.

Pan is defined almost entirely in Markdown. The behavior, conventions, and
contracts in [`system/`](.) *are* the system: an agent that reads and follows
them is Pan. The only program is a small [runner](runner.md) that polls for work
and launches Pan worker sessions, with focused automated coverage for critical
runner behavior. If something is ambiguous, the fix is to make these documents
clearer.

## The pieces

- **The Pan tool repository** (`AmoebaChant/pan`, this repo) — public, reusable,
  user-agnostic. It holds the system contracts, agents, skills, and the runner.
  It contains no user data.
- **The Pan Domain** — a private GitHub repository plus one GitHub Project that
  the user creates or connects during onboarding. It holds the user's data:
  task Issues, workstream narrative, playbook definitions, the per-machine
  playbook lists, and any domain-specific agent instructions. See
  [domain](domain.md).
- **The runner** — one small Node script per machine. It polls the Domain
  Project for ready agent work matching the playbooks that machine runs, claims
  it, and launches a Pan worker session to do it. See [runner](runner.md).
- **Pan worker sessions** — headed `copilot` sessions the runner launches to
  perform a claimed task, following that task's playbook. See
  [worker base instructions](worker-base-instructions.md).

Pan works with exactly **one** Domain at a time. The default task system is
GitHub Issues plus the connected Project. A Domain may explicitly opt into an
external human task manager in its `pan.md`; in that mode, human-owned tasks
live in that system while the GitHub Project remains the agent queue.

## The loop

1. Issues arrive in the backlog (created by the user, by Pan, or added to the
   Project from a declared external backlog repository — the external Issue stays
   in its own repository and is only referenced by a Project item).
2. **Triage** (an interactive Pan session with the user) decides whether each
   Issue has enough detail, fills in its Project fields, and picks the
   **playbook** that should run it. See [triage](triage.md).
3. **Runners** on the user's machines poll the Project. When a machine has the
   named playbook and spare capacity, it claims a ready agent task and launches
   a worker. See [runner](runner.md).
4. The **worker** does the task using the playbook's instructions, the full Pan
   system context, and the Issue contents. If it needs the user, it signals the
   runner, which records that on the Issue. See
   [worker base instructions](worker-base-instructions.md).
5. Findings and decisions are written back to **workstreams**; task lifecycle
   lives on the Project or, for a Domain-designated human task manager, in that
   external system. See [workstreams](workstreams.md).

## Reading these documents

Load only what the current job needs; skip the rest until you need it.

| When you are… | Read |
| --- | --- |
| Learning the system | this file |
| Working with the user's Domain | [domain](domain.md) |
| Reading or writing Project fields | [project schema](project-schema.md) |
| Triaging the backlog | [triage](triage.md) + [playbooks](playbooks.md) |
| Creating or completing recurring tasks | [recurrence](recurrence.md) |
| Recording knowledge / routing info | [workstreams](workstreams.md) |
| Defining or choosing a playbook | [playbooks](playbooks.md) |
| Building or debugging the runner | [runner](runner.md) |
| Executing a claimed task | [worker base instructions](worker-base-instructions.md) |
| Improving Pan itself | [self-improvement](self-improvement.md) |

## State rules

By default, GitHub Issues and the Project are the only task state. A Domain that
explicitly enables an external human task manager may keep human-owned task
state there; workstream Markdown remains the only durable narrative.
Conversation history is not a record of anything. Never build an undeclared
second queue, cache the backlog, or treat a prior read as current: read live
from each declared task system in the turn you act, and verify writes afterward.
