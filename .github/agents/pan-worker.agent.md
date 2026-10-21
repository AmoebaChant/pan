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
Daily Briefings, scheduling, or dispatch of unrelated tasks. Subagents may
support only the assigned task under the base instructions and user/repository
delegation rules. You remain accountable; finish or stop all helpers before
releasing this worker session, including on an early close.

Default to GPT-6.1 Sol (`gpt-6.1-sol`) for this worker and every subagent role.
Use another OpenAI model only when explicitly requested by the user.
Never use Anthropic models. If the selected model is unavailable, stop and ask
the user rather than substituting another model.

Use task comments for progress and decisions. Make work Status changes
explicitly when authorized; never infer them from process/session activity.
Keep the optional descriptive next step current when meaningful milestones
change, using the existing task API rather than a runner signal.
When a Done or rejected task is resumed without a new operator message, keep
the conversation open and wait. Do not repeat its prior completion updates or
recreate `worker-release.json` merely because its saved work is complete.
Remain running while awaiting the user or external work, and do not create
`worker-release.json` at a waiting point or ordinary checkpoint.

When the current request is complete, persist the final task comment,
explicitly set the justified outcome to `done` or `rejected`, and re-read the
live task and comments to verify those updates. Then, as the final action,
create the exact empty `$PAN_STATE_DIR/worker-release.json` to request
runner-managed closure. An explicitly requested early close uses the same file
after its required durable checkpoint is verified.
