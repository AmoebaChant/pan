# Task backends

Each Domain selects one authoritative task backend. Pan defines task meanings;
the backend stores them. Changing the next actor never moves the task.

Agents use `pan-task`, not backend-specific commands:

```sh
pan-task --config /absolute/path/backend.json list
pan-task --config /absolute/path/backend.json get <id>
pan-task --config /absolute/path/backend.json create --input @request.json
pan-task --config /absolute/path/backend.json update <id> --input @request.json
pan-task --config /absolute/path/backend.json report <id> --input @request.json
pan-task --config /absolute/path/backend.json complete <id> --input @request.json
```

The interface validates input and configured scope, paginates native
collections, preserves unmapped description text, and returns explicit errors.
It does not decide whether a business transition is appropriate. Pan makes
that decision from the live task and these Markdown contracts.

## Canonical concepts

The common record exposes `id`, `url`, `title`, `description`, `status`,
`nextAction`, `nextActionDetail`, `priority`, `nextActionDate`, `deadline`,
`playbook`, `workstream`, `executionAuthorized`, `dependencies`, worker
observation, responsible person, recurrence, and a backend revision.

An update may provide `expectedRevision`. The Todoist adapter detects a stale
read before writing, but Todoist does not provide an atomic conditional update;
a concurrent edit after that check remains possible and must be reconciled from
another live read.

## Todoist mapping

Todoist is the first non-GitHub adapter:

| Canonical concept | Todoist representation |
| --- | --- |
| title, description | native content and human-readable description |
| priority | native priorities 1–4 map to low, normal, high, urgent |
| next-action-date | native due date; this schedules human attention and never gates AI |
| deadline | native deadline when supported |
| recurrence | native recurring due semantics, unchanged by Pan metadata |
| person responsibility | native `responsible_uid`; only the authenticated user and configured unassigned tasks are in scope |
| lifecycle, next action, authorization, dependencies, playbook, workstream, worker observation | one visible, versioned `pan-task:v1` JSON block at the end of the description |
| durable worker report | native task comment |

The adapter never manages tasks assigned to another user. A Domain can further
restrict project ids. Credentials are read from a local file and are never
printed or stored in the Domain.

The Todoist adapter is built into the pinned Pan checkout. A future
Domain-supplied executable adapter must be installed explicitly from a trusted,
pinned revision; polling must never download and execute changing code.

GitHub Issues and Projects remain the built-in compatibility backend. The
existing GitHub runner and Project contracts continue to apply to Domains that
select it; they are not a shadow queue for a Todoist-backed Domain.
