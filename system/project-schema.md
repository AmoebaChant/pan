# Project schema

The connected GitHub Project is the canonical personal task queue. Each item
wraps one Issue and carries the fields below. The checked lifecycle, liveness,
resource, revision, date, and transition rules are defined in
[Outcome task lifecycle](task-lifecycle.md).

## Fields

| Field | Type | Meaning |
| --- | --- | --- |
| `Status` | single select | Canonical outcome state: `ready-for-human`, `ready-for-ai`, `ai-executing`, `external-waiting`, `deliberate-hold`, `done`, or `rejected`. Additive pilot schema also retains legacy `untriaged`, `needs-detail`, `ready`, `in-progress`, `paused`, `in-review`, and `blocked` options for translation/recovery only. |
| `next-action` | single select | Exact next move: `clarify`, `discuss`, `approve`, `review`, `act`, `execute`, `wait`, `hold`, or `none`. It must match `Status`. |
| `priority` | single select | `urgent`, `high`, `normal`, or `low`. Empty reads as `normal`. |
| `next-action-date` | date | Human attention schedule. It never gates or orders AI execution. Past dates remain unresolved until explicit reconsideration. |
| `deadline` | date | Optional deadline. It is distinct from attention scheduling and is never a not-before gate. |
| `playbook` | text | Playbook name for AI execution. |
| `workstream` | text | Optional path relative to `workstreams/`. |
| `execution-authorized` | single select | `no` or `yes`. Empty reads as `no`. `ready-for-ai` is dispatchable only with `yes`. |
| `dependencies` | text | Empty means the authorized next step has no unresolved dependency. Non-empty text explains what prevents dispatch. |
| `worker-state` | single select | `idle`, `starting`, `running`, `waiting-human`, `checkpointed`, `paused`, `uncertain`, or `stopped`. |
| `needs-human-since` | text | RFC 3339 UTC timestamp for an open human checkpoint. It may coexist with a live lease. |
| `lease-until` | text | RFC 3339 UTC timestamp for active runner supervision. |
| `claimed-by` | text | Stable runner identity currently supervising execution. |
| `machine` | text | Machine or `<machine>::<slot>` workspace affinity. Persists until explicit resource release. |
| `session-id` | text | Durable Copilot session id. |
| `claim-generation` | text | UUID binding one claim/launch lineage. Stale generations may not write. |
| `task-revision` | text | Non-negative decimal revision. Writers compare live state and increment this last. |
| `owner` | single select | **Legacy pilot recovery only:** `unassigned`, `human`, or `agent`. New lifecycle logic and UI never read or write it. |

Empty single-selects do not become implicit valid lifecycle pairs. A task with a
missing/mismatched `Status` or `next-action` is non-runnable and needs triage.

## Checked pairs

| `Status` | Allowed `next-action` |
| --- | --- |
| `ready-for-human` | `clarify`, `discuss`, `approve`, `review`, `act` |
| `ready-for-ai` | `execute` |
| `ai-executing` | `execute` |
| `external-waiting` | `wait` |
| `deliberate-hold` | `hold` |
| `done` | `none` |
| `rejected` | `none` |

The runner dispatches only `ready-for-ai/execute` with
`execution-authorized=yes`, empty `dependencies`, a non-recurring Issue, an
enabled playbook, capacity, and safe resources. It changes the pair to
`ai-executing/execute` when claiming. It never selects by date.

## Reconciling the schema

Schema reconciliation is an interactive, idempotent action. The unattended
runner validates but never mutates schema.

1. Read every Project field and all single-select options live and completely.
2. Compare against the table above.
3. Stop on a canonical name with an incompatible type.
4. Preview every missing field and option, then obtain confirmation.
5. Create missing fields with `gh project field-create`.
6. Add options with `updateProjectV2Field`, carrying every existing option id,
   name, color, and description unchanged. Append new options with color `GRAY`
   and description `""`; never delete, rename, reorder, or recreate an existing
   option.
7. Re-read and verify.

Extra fields/options are tolerated. In particular the additive pilot retains
legacy fields/options until an independently reviewed cutover and recovery
window are complete.

## Transition writes

Every transition follows the live re-read, expected revision, ownership,
checked-pair, update, revision-last, and verification protocol in
[task lifecycle](task-lifecycle.md#revision-and-ownership-protocol).

The Issue body receives the durable current-next-action block, and meaningful
transitions receive an idempotent `Pan: task transition <revision>` comment.
Conversation and browser state are never authoritative.

### Terminal transition

For `done` and `rejected`:

1. Re-read and verify the expected revision and transition preconditions.
2. Complete recurrence rollover first when applicable.
3. Clear `next-action-date` and verify it is empty.
4. Close the Issue as completed (`done`) or not planned (`rejected`) and verify
   its state reason.
5. Re-read the Project item and write the terminal checked pair.
6. Update the Issue block/comment, increment `task-revision` last, and verify.
7. Clear active lease/claim/resource fields only after terminal state is
   confirmed; never delete session history or results.

A failure leaves the confirmed partial state visible for retry. Clients never
return success merely because an earlier write succeeded.

## Additive pilot translation

Migration translates current legacy values instead of treating `owner` as
future authority:

- `human + needs-detail` → `ready-for-human/clarify`;
- `human + ready|in-progress|in-review` → `ready-for-human/act` (use
  `review` only when durable context names a real review);
- `agent + ready` → `ready-for-ai/execute` only when playbook, authorization,
  and dependencies validate;
- `agent + in-progress` → `ai-executing/execute`, preserving the live claim;
- legacy `paused` → `ai-executing/execute` plus `worker-state=paused`;
- legacy `blocked` → `external-waiting/wait` unless durable evidence shows a
  deliberate hold or exact human action;
- `done` and `rejected` retain their terminal meaning with `next-action=none`.

The translation preserves dates, deadlines, comments, Project order,
recurrence markers, machine/session affinity, leases, and results. See
[Todoist migration and recovery](todoist-migration.md) for reverse mapping.
