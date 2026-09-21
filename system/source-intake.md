# Source intake

Source intake registers eligible work from an explicitly configured external
source in the Domain's one authoritative task backend. It is provenance-aware
inbox capture, not triage, acceptance, authorization, scheduling, or dispatch.
The source remains reference-only after registration.

The persistent Pan chief owns intake. The mechanical runner never discovers or
imports work. Initially, "regular intake" means the chief performs it at the
start of every Daily Briefing and every portfolio or triage pass. Pan does not
install another schedule, dispatcher, watcher, or queue.

## Configuration and scope

A Domain whose authoritative backend is not GitHub may opt in through its live
`task-backend.json`:

```json
{
  "backend": "todoist",
  "sourceIntake": {
    "githubIssues": {
      "enabled": true,
      "workstreamBacklogs": true,
      "repositories": [
        "owner/explicit-repository"
      ],
      "projectMappings": {
        "owner/explicit-repository": "todoist-project-id"
      },
      "closeMigratedIssues": true,
      "receiptPath": ".pan/source-intake-receipts.json"
    }
  }
}
```

- `enabled` must be exactly `true`. Absence or any other value disables intake.
- `workstreamBacklogs: true` opts in to repositories named in exact
  `## Backlog repositories` sections of workstream READMEs.
- `repositories` is an optional additional allowlist of exact
  `owner/repository` values.
- `receiptPath` is an optional safe Domain-relative path and defaults to
  `.pan/source-intake-receipts.json`.
- `projectMappings` optionally maps declared repositories to Todoist project
  IDs. Validate every destination before applying anything. Create new tasks
  there and move previously imported tasks there without changing lifecycle,
  dates, or authorization. Unmapped repositories keep the backend default.
- `closeMigratedIssues` defaults to false. For Todoist, true authorizes source
  retirement after verifying the target task and durable receipt. Label the
  Issue `migrated-to-todoist`, add a destination comment, then close it with
  reason `not_planned`. This means migrated, not fixed, shipped, or rejected.
  Domain triage, reporter emails, and completion reconciliation must exclude
  migrated Issues from interpreting closure as an outcome.

Retirement applies to previously imported open Issues as well as new imports.
Re-read the target and source before closure; missing targets, changed source
revisions/assignments, or conflicting receipts block it. On partial failure
keep the created receipt, report the failure, and retry the remaining routing
or retirement on the next pass without creating another task. Existing target
tasks need not be untriaged: preserve any human edits since import. Closed
source Issues remain reference history and are not reopened by intake.

At least one repository must result from those declarations. Ordinary Markdown
links, repositories mentioned in prose, local UI `taskBacklogRepos`, linked
pull requests, and repositories merely related to the Domain grant no intake
scope.

If exactly one workstream declares a repository, imported tasks may inherit
that workstream. If several declare it, intake leaves the workstream empty
rather than guessing. Explicit repositories have no workstream association
unless a single workstream declaration also supplies one.

GitHub Issue intake includes only open Issues that are unassigned or include
the authenticated GitHub user among their assignees. It excludes pull requests
and Issues assigned exclusively to other people. Source labels, milestones,
projects, dates, and assignment do not authorize or schedule the new task.

## Complete reads and safe registration

Before any apply, Pan must:

1. read live `task-backend.json`;
2. read every workstream README when workstream backlog scope is enabled;
3. identify the authenticated GitHub user;
4. fully cursor-paginate every declared repository's open and closed Issues in
   stable creation order until two consecutive complete snapshots have the
   same count, identity order, state, assignment, content, and revision; and
5. read and validate the complete receipt ledger.

Each cursor page must include `totalCount`, `hasNextPage`, and `endCursor`.
Counts must remain constant within a pass, every node must be unique, and the
number read must equal `totalCount`. Overlap, reorder, omission, missing cursor
metadata, an inaccessible repository, a failed page, a truncated workstream
tree, malformed declaration, invalid receipt, or uncertain authenticated
identity makes the intake read incomplete. Fail closed before creating or
reserving any task. Intake does not silently continue with the repositories or
pages it happened to read. A mutation after the accepted snapshot is handled
by the per-Issue apply recheck or the next regular intake pass.

Each new authoritative task preserves the source URL, repository, Issue number,
and stable GitHub node id in its visible description. It is created with
`status=open`, normal priority, no planned date or deadline, blank playbook and
session fields, blank Agent status, and only an unambiguous declared
workstream.

Importing does not request a session or decide readiness. Normal triage reads
the new task in the same complete pass and decides its business state and
whether agent help should be requested.

## Durable receipts

Current open-task scans are not durable duplicate prevention: a completed or
deleted authoritative task may no longer be returned. The Domain therefore
holds one small auditable receipt ledger at `receiptPath`. It is provenance,
not task state, a shadow inbox, or a recovery queue.

```json
{
  "format": "pan-source-intake-receipts",
  "version": 1,
  "receipts": [
    {
      "state": "created",
      "source": {
        "kind": "github-issue",
        "repository": "owner/repository",
        "number": 42,
        "nodeId": "I_kwDOExample",
        "url": "https://github.com/owner/repository/issues/42"
      },
      "target": {
        "backend": "todoist",
        "taskId": "123456789"
      },
      "requestId": "3fcd9de5-f6c0-4a4a-9741-a94e0dce4f17",
      "reservedAt": "2026-09-13T01:00:00.000Z",
      "createdAt": "2026-09-13T01:00:01.000Z"
    }
  ]
}
```

Existing one-time migration mappings can seed `created` receipts in this exact
shape. Every receipt must include repository, number, canonical Issue URL, and
stable node id; those aliases must identify the same Issue. A source matches by
node id or canonical Issue URL, so the target remains known even if it is later
completed, deleted, or absent from an open-task response. Duplicate,
cross-linked, or contradictory aliases are a conflict, never permission to
create again.

Apply uses a two-phase receipt:

1. re-read the source Issue and require the previewed revision and eligibility;
2. append a `reserved` receipt with a deterministic UUID request id using the
   Domain file revision;
3. create through an adapter that guarantees idempotency for that request id;
4. verify the adapter's canonical result has every safe task default;
5. replace the reservation with `created` plus the authoritative task id; and
6. re-read and verify the ledger.

A failure after reservation leaves recovery evidence. Rerunning uses the same
request id and repairs the same receipt; it does not create a second task. A
failure after backend creation reports the known task id when available and
never claims full success. Independent Issues may continue, but the command
returns a partial result and nonzero status.

Even an `already-imported` preview result is re-read from the receipt ledger
during apply. A concurrent change to its source identity, backend, target task,
state, or request id produces a partial failure rather than a stale success.

## Chief workflow and CLI

The chief runs a read-only preview first:

```sh
pan-source-intake preview --config /absolute/path/to/machine-binding.json
```

When the complete preview contains no unresolved conflict, the Domain's
explicit `enabled: true` is standing permission for this narrow registration
operation. The chief deliberately starts a fresh checked apply with:

```sh
pan-source-intake apply \
  --config /absolute/path/to/machine-binding.json \
  --confirm-intake
```

`--confirm-intake` prevents accidental writes by a mistyped command; it is not
discretionary acceptance of each Issue. Apply rechecks each source and uses the
configured local backend adapter. Preview is safe. Both commands report
excluded records, conflicts, existing receipts, recoveries, creations, and
partial failures explicitly.
