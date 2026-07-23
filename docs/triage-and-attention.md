# PAN triage and attention

Pan works directly with the configured GitHub repository and Project through
`gh`. The environment provides:

- `PAN_DOMAIN_REPOSITORY`: Issue repository
- `PAN_DOMAIN_PROJECT`: `<owner>/<number>`
- `PAN_PROJECT_SCHEMA`: shared Project field contract

## Triage

Read the Project in canonical order with `gh project item-list`, read current
Issue state with `gh issue list` or `gh issue view`, and join by Issue URL.
Closed Issues are not triage candidates and are never automatically added back
to the Project.

Pan discusses priority, ownership, autonomy, requirements, and workstream with
the user, then writes approved values with `gh project item-edit`. It re-reads
each Issue and Project item immediately before mutation and verifies the result
afterward. Active runner status and lease fields are left untouched.

PAN has no automatic missing-Issue reconciliation. Creating or triaging one
open Issue may add that Issue to the Project; unrelated Issues are unchanged.

## Attention

Runner questions are stored in Issue comments using
`<!-- pan:needs-human -->`. Pan reads blocked, needs-detail, and in-review items
directly from GitHub. A user answer is recorded with
`<!-- pan:answer -->`, then the task's prior fields are restored and the
question is marked `<!-- pan:needs-human-resolved -->`.

New tasks are ordinary GitHub Issues. Pan adds a new open Issue to the Project
and initializes fields from the shared schema. If details are incomplete it
remains `untriaged` or `needs-detail`; complete agent work becomes `ready`.

## Session

Use `pan session --config <path>` for interactive work. PAN sessions run in the
foreground and have no leadership/read-only modes. The old evidence, action,
leadership, reconciliation, attention, and workstream helper command families
have been removed.
