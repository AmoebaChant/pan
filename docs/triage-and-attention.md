# Pan triage and attention

Pan works directly with the configured GitHub repository and Project through
`gh`. The environment provides:

- `PAN_DOMAIN_REPOSITORY`: Issue repository
- `PAN_DOMAIN_PROJECT`: `<owner>/<number>`
- `PAN_PROJECT_SCHEMA`: shared Project field contract

## Triage

Read the Project in canonical order with `gh project item-list`, read current
Issue state with `gh issue list` or `gh issue view`, and join by Issue URL.
Every repository Issue is a task. Join the complete repository Issue list to
the Project by URL and automatically add each missing Issue with
`Status=untriaged`, including closed Issues, without editing or reopening it.
Do not rewrite existing Project items or runner-owned fields.

Pan discusses priority, ownership, requirements, and workstream with
the user, then writes approved values with `gh project item-edit`. It re-reads
each Issue and Project item immediately before mutation and verifies the result
afterward. Active runner status and lease fields are left untouched.

The `workstream` field is a canonical path relative to `workstreams/`. Validate
it by reading the corresponding README through the GitHub Contents API.

An item is dispatchable only when `owner` is `agent`, `Status` is `ready`, and
`requirements` names exactly one `repo:` entry served by a playbook on an
online runner. An `agent` and `ready` item with empty
`requirements` is inert: it is counted as ready but no runner can claim it. The
runner names the missing field for each skipped item in its poll log.

`requirements` selects a playbook and nothing else: one `repo:` entry plus the
capabilities a runner advertises. How the work should be delivered belongs in
the Issue text and the playbook instructions.

Pan has no automatic missing-Issue reconciliation. Creating or triaging one
open Issue may add that Issue to the Project; unrelated Issues are unchanged.

## Attention

A worker that needs an answer sets `needs-human-since` to the current UTC time
and posts an Issue comment marked `<!-- pan:needs-human -->` naming the machine,
worktree, and terminal it is waiting in. It then keeps running: it holds its
lease and its concurrency slot and spends no budget while it waits, and its
`Status` stays `in-progress`.

Answer it in that terminal. The worker clears its request, the runner clears
`needs-human-since`, and the question is closed with
`<!-- pan:needs-human-resolved -->`. Answers recorded on the Issue itself use
`<!-- pan:answer -->` and reach the worker as task context on its next launch.

So a non-empty `needs-human-since` is the single signal that a human is needed;
`owner` and `priority` are not touched. Sort those items by that timestamp to
answer the stalest first. `blocked` is reserved for work waiting on something
outside your control.

New tasks are ordinary GitHub Issues. Pan adds a new open Issue to the Project
and initializes fields from the shared schema. If details are incomplete it
remains `untriaged` or `needs-detail`; complete agent work becomes `ready`.

## Session

Use `pan session --config <path>` for interactive work. Pan sessions run in the
foreground; there are no leadership or read-only modes.
