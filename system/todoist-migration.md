# Todoist migration and recovery

Pan's canonical personal task store is GitHub Issues plus the connected Project.
`bin/pan-todoist-migrate.js` provides an additive, idempotent import and
recovery path. It never deletes or completes a Todoist task, Issue, Project
item, or comment.

## Import scope

The tool reads the authenticated Todoist user first, then fully paginates active
tasks, projects, sections, labels, and every imported task's comments. A task
with a non-empty assignee id different from the authenticated user's id is
excluded. Unassigned tasks and tasks assigned to the authenticated user are
eligible.

Every created Issue preserves:

- source task id and URL;
- title and active description;
- project and section identity/name;
- labels and priority;
- Todoist due date/datetime, duration, and recurrence text;
- deadline, when present;
- parent/context identifiers;
- every active source comment, with source comment id and timestamp; and
- the fact that the import covers active state only.

The exact line `Pan: Todoist source task <id>` is the idempotency key. On a
recurring Issue it follows the required first-line occurrence marker; otherwise
it is the first line. Source comments use
`Pan: Todoist source comment <id>`. Re-running discovers those markers through
a fully paginated Issue read, repairs missing comments or Project membership,
and never creates a duplicate.

Todoist due dates map to `next-action-date` only as imported human attention
evidence. A Todoist deadline maps to Pan `deadline`. Recurrence text and the
nominal occurrence are stored separately in the Issue body. Import does not
invent completed history and does not create recurring successors. A
successor becomes available only through Pan's explicit recurrence lifecycle.

## Commands and safety

The CLI requires an explicit Pan checkout and config for live GitHub writes.
Todoist credentials are supplied through an environment variable named by
`--todoist-token-env`; they are never written to the repository or browser.

- `snapshot` reads Todoist and writes a public-format JSON snapshot to a
  caller-chosen path. That file can contain private data and must stay outside
  the public repository.
- `plan` reads a snapshot or Todoist live plus live GitHub state and prints the
  exact create/repair/exclude actions. It writes nothing.
- `apply --confirm-import` performs only that plan, re-reading before every
  task and verifying every Issue/comment/Project write.
- `verify` performs the same complete reads and reports missing, duplicated, or
  mismatched records without writing.
- `recovery-plan` translates the **current live pilot state** back to the
  retained legacy `owner`/Status vocabulary. It does not replay a stale
  baseline over newer work.

The optional `--report` path receives a machine-readable report. Reports
distinguish `created`, `repaired`, `verified`, `excluded-assignee`, `conflict`,
and `failed`.

## Partial imports

Tasks are independent import units. A failure for one task does not roll back a
previously verified task and does not authorize continuing writes for that
failed task. The tool continues with other independent tasks, exits nonzero,
and reports the exact partial result. Re-running is the recovery operation:
verified markers are reused, incomplete units are repaired, and duplicates or
conflicting source markers fail closed.

An Issue creation that succeeds before Project or comment setup remains
discoverable by its source marker. Verification never claims a complete import
until every eligible active task has exactly one Issue, complete preserved
metadata/comments, one Project item, and a valid translated lifecycle pair.

## Pilot rollback translation

The additive schema retains legacy owner/options only for pilot recovery.
`recovery-plan` reads each current item and maps its current outcome, action,
liveness, and claim fields:

| Current state | Legacy recovery target |
| --- | --- |
| `ready-for-human` | `owner=human`; `needs-detail` for `clarify`, otherwise `ready` |
| `ready-for-ai` | `owner=agent`; `ready` |
| `ai-executing` + live worker | `owner=agent`; `in-progress` |
| `ai-executing` + paused/checkpointed worker | `owner=agent`; `paused` |
| `external-waiting` | `owner=human`; `blocked` |
| `deliberate-hold` | `owner=human`; `blocked`, with a recovery comment preserving that it was deliberate |
| `done` | `done` |
| `rejected` | `rejected` |

The plan preserves current dates, Issue text, comments, sessions, results, and
recurrence markers. Applying a rollback is intentionally not part of the
overnight implementation command: an operator reviews the live plan and uses
the documented schema tools during an authorized cutover.
