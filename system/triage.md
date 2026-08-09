# Triage

Triage is an interactive Pan session with the user that turns raw Issues into a
prioritized, dispatchable backlog. Read [project schema](project-schema.md) and
[playbooks](playbooks.md) alongside this file.

Read live from GitHub in the turn you act. Re-read a target immediately before
mutating it and verify the result afterward. Never treat a prior read as still
current.

## 1. Register every Issue (automatic)

Every Domain Issue is a task and belongs to the Project. Read the complete Issue
set and the complete Project item set, join them by Issue URL, and add every
missing Issue to the Project with `Status=untriaged` — including closed Issues,
without editing or reopening them. This registration is the only reconciliation
that needs no approval. Do not rewrite existing items or runner-owned fields.

Read completely. `gh issue list --limit <n>` and `gh project item-list -L <n>`
are hard caps with no truncation signal: if the returned count equals the limit,
treat the set as possibly truncated and either page fully (GraphQL cursor
pagination, or `gh api --paginate`) or stop and report the incompleteness.
Because registration must add *every* missing Issue, never claim completeness
until truncation is ruled out.

## 2. Include declared external backlogs (automatic)

A workstream README may declare external backlog repositories (see
[workstreams](workstreams.md)). During registration, read the Domain's
workstreams, collect those declarations, fetch each declared repository's Issue
set, join by URL, and add the missing ones to the Project as `untriaged`. Adding
an Issue means creating a Project item that references it — the Issue is never
copied. External Issues stay in their owning repository: comments, closures, and
edits target that repository, and Pan never creates proxy Issues in the Domain
repository.

Record the declaring workstream in the added item's `workstream` field when
exactly one workstream declares the repository. A repository may be declared by
more than one workstream; when that happens the association is ambiguous, so
leave `workstream` unset rather than guessing. If workstream discovery is
incomplete (a README cannot be read), report it and proceed with the
repositories you could read.

## 3. Classify and fill fields (with approval)

For each open task, decide and set:

- `owner` — `human` or `agent` (or leave `unassigned` if genuinely unknown).
- `priority` — weigh urgency, dates, dependencies, blockers, recent activity,
  comments, and workstream narrative.
- `playbook` — for `agent` tasks, the name of the playbook that fits (see
  [playbooks](playbooks.md)). Read `playbooks/*.md` to choose.
- `workstream` — the area this task belongs to, if any. Validate a non-empty
  path by reading `workstreams/<path>/README.md` first.
- `Status`:
  - `needs-detail` if the Issue lacks enough information to act;
  - `ready` when fully triaged. An `agent` + `ready` task **must** have a
    non-empty `playbook` that a machine runs, or no runner can ever claim it;
  - leave `untriaged` only if you have not yet reviewed it.

Preserve Project order as the user's precedence within the same priority.

## 4. Approval and mutation

Read, analyze, and recommend freely. An explicit user request for a specific
change is approval for that change. Otherwise, present the proposed field
changes — show current vs. proposed values clearly, per Issue, with a link and a
short summary of the relevant context — and get approval before writing.

Apply the smallest `gh project item-edit` / `gh issue edit` / `gh issue comment`
operation. Re-read the target and report only confirmed effects.

## 5. What triage leaves alone

- Closed Issues, once registered, are historical records. Routine triage does
  not reclassify, reopen, or edit them unless the user explicitly asks about a
  specific closed Issue.
- Runner-owned fields (`claimed-by`, `lease-until`) and the worker's
  `needs-human-since` are never touched by triage.
- Never leave an `agent` + `ready` task with an empty `playbook`.

## Scheduled triage

A recurring review runs the same live reads and the same automatic registration
(steps 1–2). Beyond registration, a scheduled pass stays read-only unless the
user has given a standing policy to act. Do not create a separate scheduler or
catch up work from an earlier session.
