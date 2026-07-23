---
applyTo: "**"
---

# PAN domain instructions

Operate in exactly one configured PAN domain. GitHub Issues and the configured
Project are the only work state: Issues hold task records and the Project holds
lifecycle, fields, and canonical ordering. Do not create another queue, cache
portfolio state, or treat conversation history as durable state.

Use ordinary file, search, git, shell, and GitHub capabilities. Product-context
roots are read-only references and never grant authority to modify another
repository.

## Live GitHub workflow

Use `gh` directly against `PAN_DOMAIN_REPOSITORY` and `PAN_DOMAIN_PROJECT`.
Read the Project, repository Issues, and relevant comments from GitHub in the
current turn. The Project field contract is at `PAN_PROJECT_SCHEMA`. Do not use
a prior read as a source of truth.

Classify the complete Project, including done, blocked, leased, in-progress,
in-review, ready, needs-detail, and untriaged items. Preserve Project order as
the user's precedence within the same priority. If the live data cannot support
a safe decision, ask one focused question.

Before changing an item, read that Issue and Project item again. Never add a
closed Issue to the Project, reopen closed work, or change `in-progress`,
`claimed-by`, or `lease-until` fields owned by an active runner. After a write,
read the affected Issue or Project item and report only the confirmed result.

Do not run automatic reconciliation. Add an Issue to the Project only when the
user asks to create or triage that open Issue. Confirm pull-request merges from
GitHub before marking work done or closing its Issue.

## Triage and mutations

Read, analyze, and recommend freely. An explicit user request for a specific
change approves that change. Otherwise show the proposed Issue and Project
field changes and obtain approval before writing them.

The agent owns triage fields: `owner`, `Status`, `priority`, `requirements`,
`autonomy`, and `workstream`. The runner owns active execution fields and
transitions after claiming ready agent work. Follow the values and formats in
`PAN_PROJECT_SCHEMA`; do not invent fields or option values.

## Session behavior

PAN sessions are ordinary foreground Copilot sessions. There is no PAN
leadership lease or read-only mode. Native scheduled reviews follow the same
live-read rules and do not mutate without an explicit standing user policy.
Do not create a PAN-owned scheduler or restore reviews after the session exits.

When startup instructions name one native `/every` schedule, establish exactly
that schedule. Apply its startup policy once. For longer cadences, use the
launch-local due metadata and do nothing until due. This metadata is not a
queue; do not catch up work from an earlier session.

Use the PAN skills for focused workflows:

- `pan-portfolio` for review and triage;
- `pan-workstream` for isolated workstream delivery;
- `pan-attention` for questions, answers, and task creation.
