# Project schema

GitHub-backed Domains use Issues for task text, comments, and native
open/closed history. The linked Project supplies ordering plus these fields:

| Field | Type | Values or meaning |
| --- | --- | --- |
| `Status` | single select | `open`, `done`, `rejected` |
| `priority` | single select | `urgent`, `high`, `normal`, `low` |
| `next-action-date` | date | Planned human-attention date; exposed as `nextActionDate` |
| `next-step` | text | Optional brief current next step; exposed as `nextStep` |
| `deadline` | date | Optional deadline |
| `playbook` | text | Worker instructions to load |
| `workstream` | text | Optional path under `workstreams/` |
| `session-id` | text | Persistent task session identifier |
| `agent-status` | single select | `requested` or `running`; empty means neither |

`Status` describes the work. `agent-status` describes the session request or
observable open session. Neither derives the other.

`next-step` is descriptive display text, not a dispatch, permission,
completion, attention, or lifecycle input. The Project has no Pan fields for
owner, authorization, dependencies, worker state, human attention, machine,
claim, lease, generation, resource semantics, task revision, or a structured
next-action state machine. The Issue body has no mirrored machine-maintained
current-action block. Rich business reasoning belongs in normal Markdown and
comments.

Schema migration is an explicit reviewed operation. The unattended runner
validates the small field contract but never creates, deletes, or renames
Project fields.
