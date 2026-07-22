# Store contract

One PAN domain is one private GitHub repository plus one GitHub Project. The
public package contains no domain workstreams, Issues, machine paths,
credentials, leases, or runner state.

## Workstreams and queue

Workstream narrative lives at `workstreams/<path>/README.md`; directory nesting
is the hierarchy. The Project `workstream` field stores that slash-separated
path. Project ordering is the single canonical queue for humans and runners.
PAN updates that ordering directly and never maintains a second queue.

| Field | Type | Meaning |
| --- | --- | --- |
| `owner` | single select | `unassigned`, `human`, or `agent` |
| `Status` | single select | `untriaged`, `needs-detail`, `ready`, `in-progress`, `in-review`, `done`, `blocked` |
| `priority` | single select | `urgent`, `high`, `normal`, or `low` |
| `requirements` | text | newline-delimited capabilities such as `repo:owner/repo` |
| `autonomy` | single select | `manual`, `full-auto`, or `agent-reviewer` |
| `lease-until` | text | RFC 3339 UTC expiry |
| `claimed-by` | text | stable runner identity |
| `workstream` | text | path relative to `workstreams/` |

`schema/project-fields.json` is the machine-readable manifest. `PanStore`
validates fields and select values before mutation.

## Evidence, reconciliation, and delivery

Complete portfolio evidence preserves Project order, Issue metadata and
comments, workstream revisions, runner availability, and expected-state
identities. A snapshot is usable for mutation only when complete. Actions must
cite durable evidence and use its fresh expected state.

`reconcile missing-issues` adds open repository Issues missing from the Project
deterministically. `reconcile merged-prs --apply` records completed
pull-request delivery after confirming its merge. Direct runner delivery needs
no pull request: the runner confirms the reported commit is on the default
branch before completing the Issue and Project item.

## Leadership

The foreground session's renewable leader lease is stored on the configured
state branch in the private domain repository. It uses expected GitHub blob
state so competing sessions cannot both renew it. Only the current writing
session's identity may execute helpers that mutate domain state. A lost lease
ends the session; a new session must acquire authority again.
