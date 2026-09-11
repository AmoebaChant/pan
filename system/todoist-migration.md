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
and never silently accepts a duplicate. A command snapshots and indexes all
source markers and Project items once. Per-task reconciliation then uses
targeted repository-wide marker searches and live Issue and Project-item reads,
updates the in-memory index only after verified writes, and never repeats a full
repository-wide or Project-wide scan. Creation performs another targeted marker
search immediately before the write and another after it. Final import and
verification also require the marker to be globally unique. A changed
source-marker set, Issue body with the same repository Issue count, exact Issue
projection, Project membership, or Project-item projection fails closed instead
of trusting stale cached success. Because GitHub does not provide an atomic
"create unless body marker is unique" operation, a duplicate discovered after
creation is left intact and the checkpoint report identifies the newly created
Issue and the non-destructive recovery action.

Issue source markers and imported comment markers must occur exactly once in
their canonical positions. Imported source-comment and lifecycle-transition
receipts must match their complete canonical bodies, not merely their marker
lines. For an imported task, apply and verify inspect every
`Pan: task transition <revision>` occurrence across all Issue comments. Each
must be a complete canonical transition receipt, each revision may occur at
most once, no receipt may be revision zero or newer than the current task, and
the original Todoist import receipt plus the current transition receipt must be
present. Unrelated comments are ignored. A missing current receipt with
reconstructable historical metadata can be repaired idempotently; corrupted,
duplicate, non-canonical, or ambiguous historical receipts are a conflict and
are never deleted.

Todoist due dates map to `next-action-date` only as imported human attention
evidence. A Todoist deadline maps to Pan `deadline`. Recurrence text and the
nominal occurrence are stored separately in the Issue body. Import does not
invent completed history and does not create recurring successors. A
successor becomes available only through Pan's explicit recurrence lifecycle.
Imported human tasks always write and verify an empty `resource-semantics`
value; they never inherit `historical-provenance` or `held-affinity`.

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
  task and verifying every Issue/comment/Project write. When `--report` is
  supplied, it atomically replaces the private report after every completed
  task, so termination leaves a durable partial checkpoint.
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
   Version 1 is backwards-compatible and also permits either of these explicit
   non-execution classifications:

   ```json
   {
     "itemId": "PVTI_sanitized",
     "classification": "verifiedHumanCheckpoint",
     "projection": "sha256-from-plan",
     "status": "paused",
     "owner": "agent",
     "issueState": "OPEN",
     "workerState": "",
     "machine": "machine-a",
     "sessionId": "sanitized-session",
     "claimGeneration": "",
     "claimedBy": "old-runner",
     "leaseUntil": "2026-09-10T01:00:00.000Z",
     "needsHumanSince": "2026-09-10T01:30:00.000Z",
     "action": "approve",
     "detail": "Approve publishing the verified build, or discuss the build number.",
     "targetWorkerState": "checkpointed",
     "executionAuthorized": false,
     "verifiedDeadProcess": true,
     "verifiedWritersStopped": true
   }
   ```

   ```json
   {
     "itemId": "PVTI_sanitized",
     "classification": "verifiedDeliberateHold",
     "projection": "sha256-from-plan",
     "status": "blocked",
     "owner": "agent",
     "issueState": "OPEN",
     "workerState": "",
     "machine": "machine-a",
     "sessionId": "sanitized-session",
     "claimGeneration": "",
     "claimedBy": "",
     "leaseUntil": "",
     "needsHumanSince": "2026-09-10T01:30:00.000Z",
     "action": "hold",
     "detail": "Keep paused until the user explicitly marks the outcome ready again.",
     "targetWorkerState": "paused",
     "executionAuthorized": false,
     "verifiedDeadProcess": true,
     "verifiedWritersStopped": true
   }
   ```

   Every shown key is required. `claimedBy` and `leaseUntil` must both be empty
   or both exactly match the stale live values. A human checkpoint action is
   one of `clarify`, `discuss`, `approve`, or `review`; a deliberate hold uses
   `hold`. Detail must be one exact non-empty canonical line of at most 2,000
   characters, with no control characters, multiline content, surrounding or
   collapsible whitespace, or value that would be normalized or truncated.
   The operator must verify the process is dead and all possible
   writers are stopped; timestamps and an expired lease are not proof.
4. Run `pan-lifecycle-migrate apply` with that file and
   `--confirm-writers-stopped`. Active or uncertain workers, claims, leases,
   partial tuples, live leases, generated operational tuples, and ambiguous
   retained sessions remain held for operator reconciliation rather than being
   guessed safe. A matching verified non-execution entry may clear only its
   exact stale claim/lease and preserves the human checkpoint, machine, and
   session as held affinity. Before apply, inspect every terminal tuple's owning
   machine state and confirm there is no live/uncertain launcher, unconsumed
   result, checkpoint receipt, or terminal-release journal. A closed terminal
   machine/session pair with empty claim generation and none of that evidence
   is historical provenance and is preserved. A complete
   machine/session/generation tuple is operational evidence and remains an
   invalid terminal state. A passive blocked session migrates as
   `deliberate-hold/hold` only
   when the revision-aligned Issue current-action block already records that
   deliberate hold or an exact `verifiedDeliberateHold` entry authorizes it;
   otherwise it remains held.
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
it takes a fresh run snapshot, reuses verified markers and Project membership,
repairs incomplete units (including an Issue at revision 1 whose newly added
Project item still has unset lifecycle fields), and fails closed on duplicates,
concurrent create races, stale revisions, or conflicting source markers.

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
that an active/uncertain worker is safe. A pre-generation machine/session pair
or complete tuple on a terminal `worker-state=stopped` item remains historical
provenance through rollback; it does not authorize workspace release or result
replay and is identified by the preserved
`resource-semantics=historical-provenance` marker. Passive affinity
on a durable `deliberate-hold/hold` remains held and non-runnable only when no
open human checkpoint exists; its `resource-semantics=held-affinity` marker is
preserved. Plan and apply use
the same fail-closed worker/resource predicate, so an unsafe item is never
presented as an approved rollback or idempotent no-op. A fresh post-apply plan reports
`already-rolled-back` only for a genuinely safe exact projection, making the
operation idempotent.
