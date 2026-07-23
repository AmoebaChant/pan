# Store contract

One PAN domain is one private GitHub repository plus one GitHub Project. GitHub
Issues and Project fields are the only task state.

## Workstreams and queue

Workstream narrative lives at `workstreams/<path>/README.md`; directory nesting
is the hierarchy. The Project `workstream` field stores that slash-separated
path. Project ordering is canonical among items with the same priority. PAN
updates GitHub directly and never maintains a second queue.

| Field | Type | Meaning |
| --- | --- | --- |
| `owner` | single select | `unassigned`, `human`, or `agent` |
| `Status` | single select | `untriaged`, `needs-detail`, `ready`, `in-progress`, `in-review`, `done`, `blocked` |
| `priority` | single select | `urgent`, `high`, `normal`, or `low` |
| `requirements` | text | newline-delimited capabilities such as `repo:owner/repo` |
| `autonomy` | single select | `manual`, `full-auto`, or `agent-reviewer` |
| `lease-until` | text | RFC 3339 UTC expiry owned by the runner |
| `claimed-by` | text | stable runner identity |
| `workstream` | text | path relative to `workstreams/` |

`schema/project-fields.json` is the shared machine-readable contract.
`PanStore` validates fields and select values before runner mutations.

## Direct GitHub operation

Pan reads current Issues and Project items with `gh`, re-reads a target before
mutation, and verifies the result afterward. It never automatically imports
repository Issues into the Project or resurrects closed work.

The runner selects `owner=agent`, `Status=ready` items by priority, preserving
Project order among equal priorities. It uses `claimed-by` and `lease-until` to
coordinate concurrent workers. Direct delivery is complete only after the
runner confirms its commit is on the default branch.
