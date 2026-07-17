# Store contract

PAN keeps reusable behavior in the tool repository and all user-specific state
in a private data repository.

## Workstreams

Each workstream is a folder containing a `README.md`:

```text
workstreams/
  <path>/
    README.md
```

Folder nesting is the hierarchy. The Project `workstream` field stores the full
path relative to `workstreams/`, using `/` separators. For example:
`rendering/performance`.

The relationship is stored in a Project field rather than a label because
GitHub labels have a 50-character name limit and valid workstream paths can be
longer.

## Backlog Project fields

| Field | Type | Values or format |
| --- | --- | --- |
| `owner` | Single select | `unassigned`, `human`, `agent` |
| `Status` | Single select | `untriaged`, `needs-detail`, `ready`, `in-progress`, `in-review`, `done`, `blocked` |
| `priority` | Single select | `urgent`, `high`, `normal`, `low` |
| `requirements` | Text | One capability requirement per line, such as `repo:example/tool` or `env:local` |
| `autonomy` | Single select | `manual`, `full-auto`, `agent-reviewer` |
| `lease-until` | Text | RFC 3339 UTC timestamp; empty when unleased |
| `claimed-by` | Text | Stable runner identity; empty when unclaimed |
| `workstream` | Text | Full path relative to `workstreams/` |

`Status` is GitHub's built-in Project field, with its options replaced by PAN's
lifecycle.

## Data boundary

The public tool repository must not contain workstream content, Issues, runner
profiles, leases, locators, credentials, or other user-specific state. A PAN
installation points the tool at its own private data repository.
