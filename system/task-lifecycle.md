# Outcome task lifecycle

A Pan task is one stable outcome. It does not change identity when a person or
an AI takes the next step, and the canonical lifecycle has no owner. GitHub
Issues plus the connected Project are the authoritative personal task store.
The runner's local state proves process and workspace ownership only; it is
never a second task queue.

This contract separates three facts that older Pan versions combined:

1. **Outcome state** — what must happen next, stored in Project `Status` and
   `next-action`.
2. **Worker liveness** — whether a worker process is starting, running,
   waiting, checkpointed, stopped, paused after an interruption, or uncertain,
   stored in `worker-state` and corroborated by the lease and durable local
   generation records.
3. **Resource ownership** — which runner/session/workspace may continue the
   task, stored in `claimed-by`, `lease-until`, `machine`, `session-id`, and
   `claim-generation`, with the durable local launch manifest as the
   corroborating record.

Changing one axis does not silently change the others. In particular:

- a live worker may set the outcome to `ready-for-human` while remaining
  `worker-state=waiting-human` with a valid lease;
- a safe durable checkpoint may set `worker-state=checkpointed` and release
  execution capacity while the task remains `ready-for-human`;
- a dead worker leaves the outcome state unchanged and becomes
  `worker-state=paused`; process exit does not release its workspace affinity;
- `deliberate-hold` is a human lifecycle decision, never a crash-recovery
  state; and
- a task in `ready-for-human` or `deliberate-hold` is never automatically
  resumed, even when a reusable session exists.

## Outcome state and next-action matrix

`Status` and `next-action` form one checked pair. Empty or mismatched pairs are
not runnable and are surfaced for triage.

| `Status` | Allowed `next-action` | Meaning |
| --- | --- | --- |
| `ready-for-human` | `clarify`, `discuss`, `approve`, `review`, `act` | A person has the next move. The action must say exactly what kind of attention is needed. |
| `ready-for-ai` | `execute` | The next AI step is explicit, authorized, and dependency-clear, but no worker currently owns execution. |
| `ai-executing` | `execute` | AI has the next move and a durable session owns, or is recovering, the execution attempt. Liveness is read separately. |
| `external-waiting` | `wait` | Progress depends on an external event outside both the user and Pan. |
| `deliberate-hold` | `hold` | The user intentionally chose not to advance the outcome until reconsideration. |
| `done` | `none` | The whole outcome is complete. |
| `rejected` | `none` | The outcome was deliberately abandoned or declined. |

`untriaged`, `needs-detail`, `ready`, `in-progress`, `paused`, `in-review`, and
`blocked`, plus the legacy `owner` field and its options, are retained during
the additive pilot so current installations can be translated or rolled back.
New lifecycle logic, runner selection, and the everyday UI do not derive
responsibility from `owner` and do not write those legacy statuses.

The reason for a human checkpoint belongs in the durable current-next-action
block described below. `ready-for-human` without one exact action is invalid;
generic "needs me" or "review because AI acted" is not sufficient.

## Authorization, dependencies, and holds

`ready-for-ai` is necessary but not sufficient for dispatch:

- `execution-authorized=yes`;
- `dependencies` is empty;
- `next-action=execute`;
- no deliberate hold exists (which follows from the checked matrix);
- the Issue is not a recurring occurrence;
- the named playbook is available and enabled on the machine;
- global, playbook, and optional attention-backpressure capacity permit it; and
- required workspace resources are free or are already affined to this task.

Authorization permits the described next step, not arbitrary scope expansion.
Consequential decisions, new goals, destructive actions, and work outside the
Issue/playbook remain human decisions unless standing Domain instructions
explicitly authorize them.

## Durable current next action

The Issue body carries one machine-maintained block:

```markdown
<!-- pan-current-next-action:start -->
## Current next action

- State: ready-for-human
- Action: approve
- Detail: Approve the production rollout after reading the linked validation.
- Revision: 12
- Updated: 2026-09-10T05:12:30.000Z
<!-- pan-current-next-action:end -->
```

The block is a readable projection of the Project fields, not a separate
authority. Writers preserve all text outside the markers. A missing block is
added by the next approved mutation. A malformed, duplicated, or newer block
is a conflict: do not overwrite it blindly.

Every meaningful transition also gets an idempotent Issue comment whose first
line is `Pan: task transition <revision>`. It records the old and new checked
pair, the specific action/detail, and the actor or claim generation. This is
history, not an inbox. Comments and completed Issues are never deleted.

## Revision and ownership protocol

`task-revision` is a non-negative decimal integer. Empty reads as `0` only for
an unmigrated task. Every UI, triage, and runner transition follows this
protocol:

1. Re-read the live Project item and Issue.
2. Require the caller's expected revision to equal the live `task-revision`.
3. For worker writes, also require the exact live `claim-generation`,
   `session-id`, machine/slot affinity, and runner claim. For UI writes that
   would disturb a worker or workspace, require an explicit operation whose
   preconditions name the current worker/resource state.
4. Validate the complete proposed state/action matrix and operation-specific
   rules.
5. Apply only the requested fields and Issue block/comment.
6. Write `task-revision + 1` last.
7. Re-read and confirm the revision, checked pair, and ownership tuple.

GitHub Project writes are not atomic. A writer that observes a mismatch,
partial write, or failed verification reports a conflict and stops. It never
returns a success-shaped fallback. The next live read exposes the partial state
for explicit retry or recovery.

Runner claims additionally mint a random `claim-generation`. That generation,
not only `claimed-by`, binds all attention, result, lease, and cleanup writes to
one launch lineage. A stale worker or browser cannot complete, clear attention,
or overwrite a newer generation.

## Worker liveness and workspace ownership

`worker-state` has these values:

- `idle` — no session has started;
- `starting` — a claim is confirmed and the owned launcher is being created;
- `running` — the owned worker is active;
- `waiting-human` — the owned worker is active and a human checkpoint is open;
- `checkpointed` — the worker durably recorded a safe resumable checkpoint and
  released execution capacity;
- `paused` — execution stopped unexpectedly or during runner drain and may
  resume only through the owning machine/session;
- `uncertain` — process or generation ownership cannot be proved; fail closed;
- `stopped` — no execution remains after a confirmed terminal or released
  checkpoint transition.

A valid lease means the named runner is actively supervising the generation.
An expired lease does **not** mean the workspace is free. Workspace affinity
persists through `paused`, `waiting-human`, and `checkpointed` until one of:

- the same session resumes;
- a checked handoff explicitly clears `machine`, `session-id`, and
  `claim-generation` after preserving any result/checkpoint;
- terminal cleanup confirms `done` or `rejected`; or
- operator recovery proves every possible launcher dead, preserves all results,
  and deliberately releases the workspace under the runner recovery contract.

On restart, the durable manifest, lock, process-start identity, generation, and
live Project tuple are reconciled before adopting, finalizing, or launching.
Resume never consumes an old human-waiting or held task, clears a newer
attention request, starts a duplicate worker, or discards an unprocessed
result.

## Human checkpoints

A live worker requests attention with `needs-human.json` containing:

```json
{
  "action": "clarify",
  "question": "Which customer cohort should the comparison cover?",
  "detail": "The source data supports enterprise or all paid accounts.",
  "since": "2026-09-10T05:12:30.000Z",
  "safeToRelease": false
}
```

`action` is one of `clarify`, `discuss`, `approve`, or `review`. The runner
changes the outcome to `ready-for-human` with that exact action while keeping
`worker-state=waiting-human` and the lease when `safeToRelease=false`.
Conversation/review stays open until the user explicitly answers, hands the
task back, finishes the outcome, or rejects it.

When a playbook permits `safeToRelease=true`, the worker must first record all
necessary state in the Issue, artifacts, and session. The runner verifies and
publishes the checkpoint, sets `worker-state=checkpointed`, clears the active
lease/claim, and stops the process. The workspace/session affinity remains
reserved. Only an explicit transition to `ready-for-ai/execute` makes it
runnable again.

## Completion

Worker completion reports only what actually happened:

- the whole outcome is complete → `done/none`, clear planning date, close the
  Issue as completed, and show the transition in quiet Recent activity;
- the AI portion is complete but a decision is needed →
  `ready-for-human/<exact action>` with the durable detail and no automatic
  closure;
- the playbook already authorizes another AI step → keep working or checkpoint
  directly to `ready-for-ai/execute`; and
- an external event is now required → `external-waiting/wait`.

There is no generic review tax for AI work. A review, approval, discussion, or
post-merge live-validation gate exists only when the Issue, playbook, or Domain
contract requires it. A playbook that requires the worker to remain through
live validation does not emit a terminal result at PR creation or merge.

Terminal writes clear and verify `next-action-date` before Issue closure and
write `Status=done` or `Status=rejected` last among lifecycle fields. Terminal
cleanup then releases runner/resource fields without changing task history.

## Human attention dates and deadlines

`next-action-date` is a human attention schedule on any nonterminal mixed task:

- today — the user explicitly agreed to put it in Today;
- future — bring the task back to human attention on that date;
- empty — unscheduled; and
- past — an unresolved prior commitment that remains visible until the user
  explicitly reconsiders it.

A new human checkpoint enters Needs me but is **not** automatically put in
Today. Handoffs preserve an existing planning date unless the user explicitly
changes it. Completion and rejection clear it.

The date never gates or orders AI execution. `deadline` is a distinct optional
constraint and is never a not-before date. Deadlines may influence human
recommendations and priority, but do not silently rewrite the attention date.

Recurring cadence and nominal occurrence live in the Issue recurrence section
and occurrence marker. Planning changes never alter cadence.

## AI selection and attention backpressure

After the eligibility checks above, runners sort by:

1. priority (`urgent`, `high`, `normal`, `low`);
2. canonical Project order.

No date participates in eligibility or ordering.

A runner may configure:

```json
{
  "humanAttentionBackpressure": {
    "softLimit": 5,
    "mode": "prefer-autonomous"
  }
}
```

Playbooks declare `humanAttention: autonomous` when the currently authorized
scope can complete without a human checkpoint; the default is
`may-request`. At or above the soft limit, `prefer-autonomous` continues
autonomous-completable work and temporarily skips only `may-request` starts.
It does not pause live workers, block terminal cleanup, or stop autonomous work.
`mode: "off"` disables this policy.

## Everyday derived views

The local task UI derives each task into exactly one primary view:

- **Today** — nonterminal tasks whose `next-action-date` is today;
- **Needs me** — `ready-for-human` whose attention date is empty or overdue,
  excluding tasks already in Today; a future date stays out until due;
- **In motion** — `ready-for-ai`, `ai-executing`, or `external-waiting`,
  excluding tasks already in Today;
- **Recent activity** — terminal outcomes or transition activity within the
  configured recent window; this is quiet information, not a clearable inbox;
- **All tasks** — the full canonical set and the only intentionally overlapping
  browse view.

Past scheduled tasks remain visibly overdue; future checkpoints wait for their
date; unscheduled human checkpoints remain in Needs me. The UI never uses
legacy `owner` to place a task.
