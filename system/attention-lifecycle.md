# Opt-in attention-label lifecycle

`attention-labels-v1` is the bounded Todoist pilot that replaces Pan's
task-side outcome JSON with native completion plus one visible status label.
It is disabled unless both the backend and runner configs name that exact
mode. The legacy lifecycle remains the compatibility default.

## Authoritative task state

These exact Todoist label names are the default mapping:

| Label | Meaning |
| --- | --- |
| `AI Attention Requested` | Start or resume this task's one worker session. The request may be for conversation or execution. |
| `AI Session Open` | The associated session is running and available; this does not imply exclusive ownership or active computation. |
| `AI Needs Help` | An explicit review/approval gate is open, or a routine question exceeded the configured grace period. |
| `External Waiting` | The outcome waits on an external event. |
| `On Hold` | The human deliberately paused progress. |
| `Rejected` | On a completed task, the outcome was declined or abandoned. |

Todoist's task API represents labels by name and accepts names containing
spaces. Operators must create and verify the exact configured labels before
cutover; the runner and migration fail closed if any are absent. A Domain may
override the names in `attentionLabels`, but all writers for that Domain must
use the same mapping.

An open Inbox task with no recognized label needs triage and project
placement. An open task in a named project with no recognized label is an
ordinary human-managed task. A completed task with no recognized label is
Done; a completed task with `Rejected` is declined. Exactly zero or one
recognized label is valid. Multiple recognized labels are a reconciliation
error and no writer chooses a winner. `Rejected` on an active task is also an
error; the adapter writes it only as the checked first step of native rejected
completion. Every write preserves unrelated labels.

Native title, description, project, priority, due date, deadline, recurrence,
and comments retain their normal meanings. Due dates continue to schedule
human attention; they do not dispatch agents. Automatic recurring dispatch is
not part of this pilot.

Worker and runner comments are session-bound writes: each report request names
the expected session and machine, and the adapter re-reads that exact tuple
immediately before posting. A chief may post an ordinary note only with
explicit `actor: "chief"` semantics; migration uses `actor: "migration"`.
An unassociated interrupted launch does not post a session-specific report.

## Session association and dispatch

The only Pan task-side JSON fields used by this mode are `sessionId` and
`machineId`. Source provenance remains readable description text and durable
worker reports remain native comments. Old lifecycle, authorization,
dependency, playbook, workstream, and worker-observation fields are neither
read nor written during normal operation.

On the first attention request, the runner creates a UUID and writes the
complete session/machine pair before launching. A launch is acknowledged as
`AI Session Open` only after the owned launcher records the spawned Copilot
child identity and both processes remain live through the launch handshake. Failure leaves
`AI Attention Requested` visible and retains the same association for
recovery. A later request resumes that exact session with the supported
Copilot CLI `--session-id` option. Before spawning a resume, the runner requires
the exact private `COPILOT_HOME/session-state/<sessionId>/events.jsonl` to
contain persisted conversation data. Missing or empty state is an explicit
launch error; the runner never replaces its id.

An exact empty `worker-release.json` remains the only process-release signal.
The runner verifies and terminates the exact owned process tree, including all
journaled descendants, before releasing the lock. Release removes
`AI Session Open` but retains the session/machine association and persistent
Copilot home. `AI Needs Help`, `External Waiting`, and `On Hold` are not erased
by release. Status reports, comments, completion, and label edits are never
termination authority.

Todoist has no atomic compare-and-set for claiming an unassociated task.
This pilot therefore requires `singleRunnerDomain: true`: only one enabled
attention runner may poll a Domain. A nonblank association for another machine
is skipped. Cross-machine conversation portability and automatic reassignment
are unsupported; recovery is an explicit operator action.

Changing `AI Session Open` back to `AI Attention Requested` while its process
is already live cannot inject a message into that CLI session. The runner
does not duplicate it: it writes one durable routing comment directing the
user to the existing worker terminal and leaves the request visible.

## Session-side workspace and playbook

New sessions start in a private per-task home under the configured runner state
root. They may remain conversations with no playbook. The worker may write
`task-session.json` in its state directory:

```json
{
  "playbookName": "existing-playbook-name",
  "workingDirectory": "/absolute/path/to/an/allowed/workspace",
  "resumptionNote": "Resume after the user approves the prepared change."
}
```

This is session state, not task schema. A workspace is used only on the next
launch after an explicit safe release. It must be beneath one of
`attentionLifecycle.allowedWorkspaceRoots`; otherwise launch fails closed.
Containment uses filesystem-canonical paths before directory creation and is
checked again before trust is written, so a symlink below an allowed root
cannot escape it.
The same session id and Copilot home are retained. Existing repository
instructions load from the actual resumed working directory. Pan does not
grant blanket path or tool permissions merely because a playbook was selected.

## Mechanical attention supervision

Before blocking, a worker writes `awaiting-answer.json` in its state directory:

```json
{
  "version": 1,
  "sessionId": "the-associated-session-id",
  "checkpointId": "unique-within-the-session",
  "timestamp": "2026-09-13T06:00:00.000Z",
  "action": "clarify",
  "question": "Which cohort should the comparison cover?",
  "detail": "Enterprise and all-paid are both safe choices.",
  "immediate": false
}
```

`approve` and `review` (or `immediate: true`) project `AI Needs Help` on the
next poll. `clarify` and `discuss` retain `AI Session Open` for the configured
grace period, default 120 seconds, and project Needs Help only if the same
marker remains unanswered. The runner records the projected checkpoint id
locally. When the worker deletes the marker after receiving the answer, the
runner returns Needs Help to Session Open only if the same session receipt
exists and the current label is still Needs Help. Any On Hold, External
Waiting, new Attention Requested, or other human override is preserved.
Workers do not create timer schedules.

Unexpected exit without the exact release signal retains the association,
projects Needs Help unless a stronger human exception is already present,
records a durable comment, and preserves local evidence and the task lock.
Task locks record the exact runner PID and process-start identity. A restart
may clear an orphan lock or recover a launch only after proving that the runner
identity is dead. A newly allocated association may initialize that same id
only when its matching failure receipt says it was not a resume and definitely
did not reach terminal invocation, with no launcher or child record. Every
`terminal-requested` launch without a worker handshake remains an explicit
uncertain recovery item because Pan cannot prove that no worker survived.
Poll output includes its task id, session id, and recovery reason while
retaining the lock.

## Opt-in configuration and migration

Backend config additions:

```json
{
  "backend": "todoist",
  "lifecycleMode": "attention-labels-v1",
  "inboxProjectId": "<Todoist Inbox project id>",
  "attentionLabels": {
    "requested": "AI Attention Requested",
    "open": "AI Session Open",
    "needsHelp": "AI Needs Help",
    "externalWaiting": "External Waiting",
    "onHold": "On Hold",
    "rejected": "Rejected"
  }
}
```

Runner config additions:

```json
{
  "enabled": false,
  "lifecycleMode": "attention-labels-v1",
  "singleRunnerDomain": true,
  "attentionLifecycle": {
    "questionGraceSeconds": 120,
    "allowedWorkspaceRoots": ["/absolute/approved/workspace/root"]
  }
}
```

Keep the runner disabled during migration. With every writer stopped:

```sh
pan-attention-migrate preview --config /absolute/path/backend.json
pan-attention-migrate apply --config /absolute/path/backend.json \
  --confirm-writers-stopped
```

Preview/apply preserve title, description, project, priority, dates, deadline,
recurrence, unrelated labels, session association, and comments. They remove
all other task-side Pan metadata, including legacy lifecycle, authorization,
playbook, workstream, dependency, and worker fields. A live or uncertain legacy
worker observation is a conflict that must be released or reconciled before
cutover. An associated released human clarification/discussion/approval/review
checkpoint becomes Needs Help and its action/detail is copied to an idempotent
native comment; an ordinary human task remains unlabeled. Partial or differing
association tuples, active terminal metadata, and Rejected on an open task are
conflicts. Legacy ready-for-ai never becomes an attention request by default. To
opt selected tasks into immediate dispatch, add one
`--request-attention <task-id>` per reviewed task to both preview and apply.
Conflicting labels, partial associations, unmatched requested ids, missing
exact labels, stale revisions, and per-task write failures are reported
without guessing.

After apply, switch the backend config to `attention-labels-v1`, run the
disabled runner once with `--dry-run`, inspect candidates and conflicts, then
enable exactly one runner. End-to-end readiness still requires a live proof:
request attention on one disposable task, observe one session id and Session
Open only after launch, exercise a timed question and explicit gate, release,
request attention again, verify the same id resumes, and confirm unrelated
labels and native task fields remain unchanged.
