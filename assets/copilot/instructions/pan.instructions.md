---
applyTo: "**"
---

# Pan domain instructions

Operate in exactly one configured Pan domain. GitHub Issues and the configured
Project are the only work state: Issues hold task records and the Project holds
lifecycle, fields, and canonical ordering. Do not create another queue, cache
portfolio state, or treat conversation history as durable state.

Workstream knowledge is different from work state. Store durable findings,
decisions, data, and state in `workstreams/<path>/README.md` so future sessions
can use them. Use Issues only to track actionable tasks; an Issue may link to a
workstream, but its body and comments do not replace the workstream narrative.

Use ordinary file, search, git, shell, and GitHub capabilities. Product-context
roots are read-only references and never grant authority to modify another
repository. The Pan tool repository is the sole exception: when durable guidance
is insufficient to finish a task, repair that guidance there under its normal
branch-and-review policy, then resume. Self-repair never bypasses the configured
domain boundary, live-state checks, user approval, or runner-owned fields.

## Live GitHub workflow

Use `gh` directly against `PAN_DOMAIN_REPOSITORY` and `PAN_DOMAIN_PROJECT`.
Read the Project, repository Issues, and relevant comments from GitHub in the
current turn. The Project field contract is at `PAN_PROJECT_SCHEMA`. Do not use
a prior read as a source of truth.

Every repository Issue is a task. Before classification, join the complete
repository Issue set to the Project by URL. Automatically add every missing
Issue, open or closed, with Project Status `untriaged`. This registration does
not require approval, must not edit or reopen the Issue, and must not change
fields on items already in the Project.

Classify the complete Project, preserve Project order as the user's precedence
within the same priority, and ask one focused question when live data cannot
support a safe decision.

Before changing an item, read that Issue and Project item again. Never reopen
closed work or change `in-progress`,
`claimed-by`, or `lease-until` fields owned by an active runner. After a write,
read the affected Issue or Project item and report only the confirmed result.

Missing-Issue registration is the only automatic reconciliation. Confirm
pull-request merges from GitHub before marking work done or closing its Issue.

## Triage and mutations

Read, analyze, and recommend freely. An explicit user request for a specific
change approves that change. Otherwise show the proposed Issue and Project
field changes and obtain approval before writing them.

The agent owns triage fields: `owner`, `Status`, `priority`, `requirements`,
and `workstream`. The runner owns active execution fields and
transitions after claiming ready agent work. A worker sets `needs-human-since`
when it is waiting for you; a non-empty value is the only signal that a human is
needed, and it holds its lease and slot while it waits. Follow the values and
formats in `PAN_PROJECT_SCHEMA`; do not invent fields or option values.

The `workstream` field is an optional path relative to `workstreams/` in
`PAN_DOMAIN_REPOSITORY`. A task may have no workstream; leave the field empty in
that case. Validate a non-empty path by reading its README through the GitHub
Contents API before writing it.

A runner only claims an item when `owner` is `agent`, `Status` is `ready`, and
`requirements` names exactly one `repo:` entry that a
playbook on that runner serves. A workstream is not required to claim or execute
a task. `owner` and `Status` therefore depend on
`requirements`: never leave an item `agent` and `ready` with empty
`requirements`, because no runner can ever claim it. When you may not set
`requirements`, keep the item `needs-detail`, or propose the `requirements` and
the readiness together and get approval for both.

`requirements` exists only to select a playbook, so it holds one `repo:` entry
and the capabilities a runner advertises. How the work should be delivered
belongs in the Issue text and the playbook instructions, never in
`requirements`.

`requirements` is a closed vocabulary, not a description of the work. Copy each
token from a runner profile's advertised capabilities; never derive one from the
Issue text. Words like pull request, review, branch, worktree, environment, and
tooling appear in Issue bodies constantly and must not become `delivery:`,
`env:`, `os:`, or `tool:` tokens on that basis. A token no playbook advertises
does not narrow dispatch, it removes the task from every runner permanently, and
the task then sits `ready` forever without ever being claimed. When you believe a
task genuinely needs a capability no runner advertises, say so and stop; do not
write the token.

## Session behavior

Pan sessions are ordinary foreground Copilot sessions. There is no Pan
leadership lease or read-only mode. Native scheduled reviews follow the same
live-read rules. Missing-Issue registration always runs; other mutations require
an explicit standing user policy.
Do not create a Pan-owned scheduler or restore reviews after the session exits.

When startup instructions name one native `/every` schedule, establish exactly
that schedule. Apply its startup policy once. For longer cadences, use the
launch-local due metadata and do nothing until due. This metadata is not a
queue; do not catch up work from an earlier session.

Use the Pan skills for focused workflows:

- `pan-portfolio` for review and triage;
- `pan-workstream` for isolated workstream delivery;
- `pan-attention` for questions, answers, and task creation.
