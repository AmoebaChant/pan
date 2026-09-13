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
pan-task --config /absolute/path/backend.json reports <id>
pan-task --config /absolute/path/backend.json complete <id> --input @request.json
```

The interface validates input and configured scope, paginates native
collections, preserves unmapped description text, and returns explicit errors.
It does not decide whether a business transition is appropriate. Pan makes
that decision from the live task and these Markdown contracts.

For [source intake](source-intake.md), an adapter must advertise and honor
idempotent create requests. `create` accepts an optional UUID
`idempotencyKey`; the Todoist adapter sends it as `X-Request-Id`. Intake refuses
apply through an adapter that cannot guarantee retrying the same key will not
create a second task.

## Canonical concepts

The Todoist adapter also supports `pan-task move <id> --input ...` with
`projectId` and `expectedRevision`. It validates destination scope, moves the
native task, and re-reads the result without rewriting lifecycle metadata or
dates. Source intake uses this operation to apply declared project mappings
to previously imported tasks.

The compatibility common record exposes `id`, `url`, `title`, `description`, `status`,
`nextAction`, `nextActionDetail`, `priority`, `nextActionDate`, `deadline`,
`playbook`, `workstream`, `executionAuthorized`, `dependencies`, worker
observation, responsible person, recurrence, and a backend revision.

An update may provide `expectedRevision`. The Todoist adapter detects a stale
read before writing, but Todoist does not provide an atomic conditional update;
a concurrent edit after that check remains possible and must be reconciled from
another live read.

## Todoist mapping

Todoist is the first non-GitHub adapter:

| Compatibility lifecycle concept | Todoist representation |
| --- | --- |
| title, description | native content and human-readable description |
| priority | native priorities 1–4 map to low, normal, high, urgent |
| next-action-date | native due date; recurring occurrence dates move through a recurrence-preserving native update |
| deadline | native deadline when supported |
| recurrence | native recurring due semantics; never rewritten by an attention-date update |
| person responsibility | native `responsible_uid`; only the authenticated user and configured unassigned tasks are in scope |
| lifecycle, next action, authorization, dependencies, playbook, workstream, worker observation | one visible, versioned `pan-task:v1` JSON block at the end of the description |
| durable worker report | native task comment |

The low/normal/high/urgent names are transport-neutral values. A Domain may
define native P1–P4 as daily commitments; planning must honor that Domain
meaning instead of treating the generic names as automatic urgency.

For a recurring task, changing `nextActionDate` changes only the current native
occurrence date while preserving the recurrence expression, language, timezone,
and recurring marker. Clearing that date is unsupported because it would also
remove the native recurrence. Pan must report a partial write if another
metadata change succeeds but the native occurrence-date update fails.

`reports <id>` fully paginates native comments after verifying that the task is
inside configured scope. Reports therefore remain recoverable without using
Todoist-specific commands.

Worker observation is operational metadata, not business lifecycle. A report,
question, status change, or task completion does not imply that a worker
process or workspace may be released. The thin backend runner records
`starting`, `running`, `released`, or `unexpected-stop` observations without
changing lifecycle fields. Pan may update lifecycle independently.

Automatic recurring-task dispatch is intentionally unsupported by the small
pilot runner. Recurring tasks remain visible and editable through the common
API, but the runner excludes them so a persistent readiness marker cannot
launch each newly advanced occurrence. This is a temporary capability limit,
not a task-policy rule or permission to create a GitHub fallback.

The adapter never manages tasks assigned to another user. A Domain can further
restrict project ids. Credentials are read from a local file and are never
printed or stored in the Domain.

The Todoist adapter is built into the pinned Pan checkout. A future
Domain-supplied executable adapter must be installed explicitly from a trusted,
pinned revision; polling must never download and execute changing code.

GitHub Issues and Projects remain the built-in compatibility backend. The
existing GitHub runner and Project contracts continue to apply to Domains that
select it; they are not a shadow queue for a Todoist-backed Domain.

Todoist may explicitly opt into
[`attention-labels-v1`](attention-lifecycle.md). In that mode native labels and
completion replace the lifecycle JSON mapping. Normal reads ignore legacy
lifecycle metadata; only the explicit preview/apply migration interprets and
removes it. The task association is limited to `sessionId` plus `machineId`.
Session reports require matching `expectedSessionId` and `expectedMachineId`.
Non-worker notes require an explicit `actor` of `chief` or `migration`.

Live Domain `task-backend.json` may enable GitHub Issue source intake and name
its repository scope and receipt path. The machine-local backend config still
holds operational scope such as Todoist `createProjectId` and the credential
file. The two backend names must match.
