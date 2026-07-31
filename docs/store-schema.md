# Store contract

One Pan domain is one private GitHub repository plus one GitHub Project. GitHub
Issues and Project fields are the only task state.

## Workstreams and queue

Workstream narrative lives at `workstreams/<path>/README.md` on the domain
repository's default branch; directory nesting is the hierarchy. Pan accesses
these files through the GitHub Contents API, so setup does not require a clone.
Every repository Issue is a task and belongs to the Project. Project ordering is
canonical among items with the same priority.

| Field | Type | Owned by | Meaning |
| --- | --- | --- | --- |
| `owner` | single select | triage | `unassigned`, `human`, or `agent`; empty reads as `unassigned` |
| `Status` | single select | triage, then the runner | `untriaged`, `needs-detail`, `ready`, `in-progress`, `in-review`, `done`, `blocked`; empty reads as `untriaged` |
| `priority` | single select | triage | `urgent`, `high`, `normal`, or `low`; empty reads as `normal` |
| `requirements` | text | triage | newline-delimited capabilities such as `repo:owner/repo` |
| `workstream` | text | triage | path relative to `workstreams/` |
| `needs-human-since` | text | the worker | RFC 3339 UTC timestamp; non-empty means a live worker is waiting for you |
| `lease-until` | text | the runner | RFC 3339 UTC expiry |
| `claimed-by` | text | the runner | stable runner identity |

`schema/project-fields.json` is the shared machine-readable contract.
`PanStore` validates fields, select values, and non-empty workstream paths
against repository README files before runner mutations.

`Status` is the built-in Projects field, so its display name is capitalized and
cannot be renamed; Pan's own key for it is `status`. Empty is a legitimate value
for every select, because Issues created by hand never set one: an empty select
reads as its default rather than as an error.

Triage owns the first five fields. A runner owns the last three while it holds
the lease, except that `needs-human-since` is written on the worker's behalf and
must survive requeue. Nothing else may write a field it does not own.

## Asking a human a question

A worker that needs an answer writes `needs-human-since` and asks in its own
terminal. It is a pause, not a failure: the worker stays alive, keeps its lease
and its concurrency slot, and stops spending budget until the answer arrives.
`Status` stays `in-progress`. You answer at that machine's terminal, and the
worker clears the field and continues.

`blocked` therefore has exactly one meaning: the task is waiting on something
outside your control, and no worker is holding it.

| `needs-human-since` | lease | `Status` | Meaning |
| --- | --- | --- | --- |
| empty | held | `in-progress` | working |
| set | held | `in-progress` | alive, waiting for you at its terminal |
| set | expired | `in-progress` | its machine restarted; pending rehydration there |
| empty | expired | `in-progress` | interrupted; resumes normally |
| any | none | `blocked` | waiting on the world |

A task waiting for an answer is only ever resumed on the machine that asked, so
the question is re-posed in a terminal you can actually reach. A resumed worker
re-states its outstanding question, because its request file is per-launch. If
that task instead has to start over from the beginning, the stale request is
cleared.

## Direct GitHub operation

Pan reads current Issues and Project items with `gh`, re-reads a target before
mutation, and verifies the result afterward. During live review and triage it
automatically adds every repository Issue missing from the Project with
`Status=untriaged`. Closed Issues are added without reopening or editing them.
Existing items and runner-owned fields are not rewritten.

The runner selects `owner=agent`, `Status=ready` items by priority, preserving
Project order among equal priorities. It uses `claimed-by` and `lease-until` to
coordinate concurrent workers. A completed task moves to `done` or `in-review`
according to the outcome its agent reports, and work delivered as a pull request
is complete only after the runner confirms the merge from GitHub.
