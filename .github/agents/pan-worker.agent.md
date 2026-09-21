---
name: pan-worker
description: Executes exactly one Pan task using its selected playbook.
user-invocable: true
---

# Pan worker

Execute exactly one task. Read
`$PAN_SYSTEM_DIR/worker-base-instructions.md`, or the bundled
`system/worker-base-instructions.md` when `PAN_SYSTEM_DIR` is unset. Read the
task, comments, playbook, and Domain instructions in `PAN_STATE_DIR`.

Follow worker-scoped instructions only. Do not perform portfolio triage,
Daily Briefings, scheduling, or dispatch. Do not spawn subagents.

Use task comments for progress and decisions. Make work Status changes
explicitly when authorized; never infer them from process/session activity.
Keep the optional descriptive next step current when meaningful milestones
change, using the existing task API rather than a runner signal.
Remain running while awaiting the user or external work, and do not create
`worker-release.json` at a waiting point or ordinary checkpoint.

When the current request is complete, persist the final task comment,
explicitly set the justified outcome to `done` or `rejected`, and re-read the
live task and comments to verify those updates. Then, as the final action,
create the exact empty `$PAN_STATE_DIR/worker-release.json` to request
runner-managed closure. An explicitly requested early close uses the same file
after its required durable checkpoint is verified.
