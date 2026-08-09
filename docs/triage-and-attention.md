# Pan triage and attention

Pan works directly with the configured GitHub repository and Project through
`gh`. The environment provides:

- `PAN_DOMAIN_REPOSITORY`: Issue repository
- `PAN_DOMAIN_PROJECT`: `<owner>/<number>`
- `PAN_PROJECT_SCHEMA`: shared Project field contract

## Triage

Read the Project in canonical order, obtaining the complete item set because
`gh project item-list` returns only 30 by default. Because `item-list` has no
cursor, either pass a large `-L`/`--limit` with truncation detection — fail
closed if the returned count equals `-L` — or use the GraphQL
`items(first:100 after:$cursor)` query until `pageInfo.hasNextPage` is false. Read current Issue state with
`gh issue list` or `gh issue view`, and join by Issue URL. Every repository
Issue is a task. Join the complete repository Issue list to the Project by URL
and automatically add each missing Issue with `Status=untriaged`, including
closed Issues, without editing or reopening it. Because reconciliation must add
every missing Issue, read the Issue set completely: `gh issue list --limit <n>`
is a hard cap with no truncation signal, so page fully (for example with
`gh api --paginate`) or, if the returned count equals the requested limit, treat
the set as possibly truncated and fail closed rather than assuming completeness.
Do not rewrite existing Project items or runner-owned fields.

A workstream README may extend the domain backlog to external repositories. A
`## Backlog repositories` section lists one `owner/repository` per entry.
Reconciliation reads the domain's workstreams, fetches each declared
repository's Issues, and adds the missing ones to the Project as `untriaged`
with the declaring workstream recorded in the `workstream` field. Workstream
discovery must be complete: if the workstream listing is incomplete or any
declared README cannot be read, fail closed and reconcile no external
repositories, since an undiscovered duplicate declaration could hide a conflict.
Declarations are domain-local and a repository maps to one workstream: ambiguous
duplicates are reported without writes, and an existing conflicting `workstream`
is surfaced rather than overwritten. The Issues stay in their owning repository,
so comments, closures, and edits target that repository; Pan creates no proxy
Issues. Backlog ownership does not route execution — agent-ready work still
needs a runner-advertised `repo:<owner>/<repository>` selector in
`requirements`.

A workstream README may also carry a `## Triage instructions` section of
free-form prose. It is workstream-level: the single section applies to every
backlog repository that workstream declares. Pan reads and applies these
instructions when classifying that workstream's backlog Issues, and they may
direct Pan to recommend accept or reject and defer the decision to the user
rather than acting.

Pan discusses priority, ownership, requirements, and workstream with
the user, then writes approved values with `gh project item-edit`. It re-reads
each Issue and Project item immediately before mutation and verifies the result
afterward. Active runner status and lease fields are left untouched. Routine
triage ignores closed Issues, including external backlog Issues; once registered
they are historical records that Pan does not reclassify, reopen, or edit unless
the user explicitly asks to reconcile or modify a specific closed Issue.

The `workstream` field is an optional canonical path relative to `workstreams/`.
A task may have no workstream. When one is set, validate it by reading the
corresponding README through the GitHub Contents API.

An item is dispatchable only when `owner` is `agent`, `Status` is `ready`, and
`requirements` names exactly one `repo:` entry served by a playbook on an
online runner. An `agent` and `ready` item with empty
`requirements` is inert: it is counted as ready but no runner can claim it. The
runner names the missing field for each skipped item in its poll log.

`requirements` selects a playbook and nothing else: one `repo:` entry plus the
capabilities a runner advertises. How the work should be delivered belongs in
the Issue text and the playbook instructions.

Missing-Issue registration is Pan's only automatic reconciliation: it adds
every missing Issue, open or closed, from `PAN_DOMAIN_REPOSITORY` and each
declared backlog repository to the Project with `Status=untriaged`, without
editing or reopening it. Pan performs no other automatic reconciliation. It does
not reclassify, reopen, or edit existing items or runner-owned fields on its
own.

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
