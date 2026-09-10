# Todoist migration and recovery

Pan's canonical personal task store is GitHub Issues plus the connected Project.
`bin/pan-todoist-migrate.js` provides an additive, idempotent import and
recovery path. It never deletes or completes a Todoist task, Issue, Project
item, or comment.

## Import scope

The tool reads the authenticated Todoist user first, then fully paginates active
tasks, projects, sections, labels, and every imported task's comments. A task with a non-empty Todoist API v1 `responsible_uid` different from the
authenticated user's id is excluded. A non-empty `responsible_uid` is
authoritative, and stale legacy assignment aliases are ignored. When it is
absent or empty, the stable `responsibleUid`, `assignee_id`, and `assigneeId`
aliases are checked in that order; conflicting non-empty fallbacks fail closed.
IDs are compared as normalized opaque strings; unassigned tasks and tasks
assigned to the authenticated user are eligible. Snapshot, plan, apply, and
verify each enforce this rule from the task records, so a snapshot produced by
an older buggy client cannot authorize importing another person's task.
Exclusion output contains only the source task id and reason.

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
- `recovery-apply --confirm-writers-stopped` re-reads and checks that plan,
  then applies only the compatible legacy `owner`/Status projection with
  revision last. It preserves the current Issue, comments, dates, playbook,
  dependencies, recurrence, and session/resource evidence.

Lifecycle schema migration is a separate, writer-exclusive cutover:

1. Stop every runner, task UI, briefing session, and other Project writer.
2. Save a fresh read-only baseline with
   `pan-lifecycle-migrate plan --config ... --checkout ... --report ...`.
3. Review an authorization file with format
   `pan-lifecycle-migration-authorization`, version `1`, and one entry per
   approved legacy agent item. Each entry must contain the exact `itemId`,
   non-empty `playbook`, exact `dependencies` text, and
   `executionAuthorized: true`. Legacy `owner=agent` is never authorization.
4. Run `pan-lifecycle-migrate apply` with that file and
   `--confirm-writers-stopped`. Active or uncertain workers, claims, leases,
   partial tuples, and ambiguous retained sessions remain held for operator
   reconciliation rather than being guessed safe. Before apply, inspect every
   terminal tuple's owning machine state and confirm there is no live/uncertain
   launcher, unconsumed result, checkpoint receipt, or terminal-release
   journal. A complete terminal tuple with none of that evidence is historical
   provenance and is preserved. A passive blocked session migrates as
   `deliberate-hold/hold` only when the revision-aligned Issue current-action
   block already records that deliberate hold; otherwise it remains held.
5. Run another plan against current live state. Do not restart writers until it
   reports no authorization, cutover-hold, or repair actions.

For rollback, keep writers stopped, generate
`pan-todoist-migrate recovery-plan` (or `pan-lifecycle-migrate rollback-plan`)
from current live state, review it, then run `recovery-apply` (or
`rollback-apply`) with `--confirm-writers-stopped`. Apply verifies the complete
live projection before each item, preserves trial progress, and refuses active,
uncertain, stale, or externally inconsistent items. Never replay the baseline
over newer Issues, comments, dates, session evidence, or results.

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

The plan and checked apply preserve current dates, Issue text, comments,
sessions, results, playbook/dependency text, and recurrence markers. Apply does
not reopen or re-close Issues, reverse Todoist state, clear affinity, or infer
that an active/uncertain worker is safe. A complete tuple on a terminal
`worker-state=stopped` item remains historical provenance through rollback; it
does not authorize workspace release or result replay and is identified by the
preserved `resource-semantics=historical-provenance` marker. Passive affinity
on a durable `deliberate-hold/hold` remains held and non-runnable only when no
open human checkpoint exists; its `resource-semantics=held-affinity` marker is
preserved. Plan and apply use
the same fail-closed worker/resource predicate, so an unsafe item is never
presented as an approved rollback or idempotent no-op. A fresh post-apply plan reports
`already-rolled-back` only for a genuinely safe exact projection, making the
operation idempotent.
