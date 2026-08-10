# Project schema

The connected GitHub Project is the task queue. Each Project item wraps one
Domain Issue and carries the fields below. This is the complete, canonical field
contract — there are no other fields Pan relies on, and Pan never invents new
ones.

`Status` is the built-in Projects status field, so its display name is
capitalized and cannot be renamed. Every other field is a custom field created
with exactly the name shown. Any select field left empty on a hand-created Issue
reads as its documented default rather than as an error.

## Fields

| Field | Type | Owned by | Meaning |
| --- | --- | --- | --- |
| `owner` | single select | triage | `unassigned` \| `human` \| `agent`. Empty reads as `unassigned`. Separates the human queue from the agent queue; nothing else does. |
| `Status` | single select | triage, then the runner | `untriaged` \| `needs-detail` \| `ready` \| `in-progress` \| `in-review` \| `done` \| `blocked`. Empty reads as `untriaged`. |
| `priority` | single select | triage | `urgent` \| `high` \| `normal` \| `low`. Empty reads as `normal`. |
| `playbook` | text | triage | The name of the playbook that should run this task (see [playbooks](playbooks.md)). Empty means no playbook has been chosen yet. |
| `workstream` | text | triage | Optional path relative to `workstreams/`. Empty means the task has no workstream. |
| `needs-human-since` | text | the worker | RFC 3339 UTC timestamp. Non-empty means a live worker is waiting for the user right now. |
| `lease-until` | text | the runner | RFC 3339 UTC timestamp. When a claim expires. |
| `claimed-by` | text | the runner | Stable identity of the runner holding the task. |

## Status meanings

- `untriaged` — added to the Project but not yet reviewed. Registration of
  missing Issues sets this automatically.
- `needs-detail` — reviewed, but lacks enough information to act. Waiting on the
  user to add detail.
- `ready` — fully triaged and dispatchable. For an `agent`-owned task this
  requires a non-empty `playbook`. For a `human`-owned task it just means the
  user can pick it up.
- `in-progress` — a runner has claimed it and a worker is running (or is
  rehydrating, or is waiting on the user with `needs-human-since` set).
- `in-review` — the worker finished but a human should look before it is done
  (for example, a pull request awaiting merge).
- `done` — complete and confirmed. For pull-request work, confirmed merged.
  Setting `Status=done` and closing the Issue go together: whoever marks a task
  `done` also closes its Issue as completed (`gh issue close --reason
  completed`), and a task is never left `done` with its Issue still open.
- `blocked` — waiting on something outside the user's control, with no worker
  holding it. This is the *only* meaning of `blocked`.

## Ownership rules

- **Triage owns** `owner`, `Status`, `priority`, `playbook`, and `workstream`.
- **The runner owns** `Status` transitions after it claims, plus `lease-until`
  and `claimed-by`, while it holds the lease.
- **The worker owns** `needs-human-since`, written on its behalf by the runner
  (see [worker base instructions](worker-base-instructions.md)). It must survive
  a requeue.
- Nothing writes a field it does not own. In particular, answering a worker's
  question never touches `needs-human-since`, `claimed-by`, or `lease-until`.

## Dispatch rule

A task is dispatchable to a runner only when **all** of these hold:

1. `owner` is `agent`;
2. `Status` is `ready`;
3. `playbook` is non-empty and names a playbook the machine runs.

An `agent` + `ready` task with an empty `playbook` can never be claimed by any
runner — never leave a task in that state. If you cannot choose a playbook yet,
keep the task `needs-detail`, or propose the playbook and readiness together and
get approval for both.

## Waiting-for-human states

`needs-human-since` is the single signal that a human is needed. A worker that
needs an answer stays alive, keeps its lease and its concurrency slot, and stops
spending budget while it waits; `Status` stays `in-progress`.

| `needs-human-since` | lease | `Status` | Meaning |
| --- | --- | --- | --- |
| empty | held | `in-progress` | working |
| set | held | `in-progress` | alive, waiting for the user at its terminal |
| set | expired | `in-progress` | its machine restarted; pending rehydration there |
| empty | expired | `in-progress` | interrupted; resumes normally |
| any | none | `blocked` | waiting on the world |

A task waiting for an answer is only ever resumed on the machine that asked, so
the question is re-posed in a terminal the user can reach.
