---
name: default-playbook
description: General task work guided by the task, Domain, workstream, and applicable repository instructions.
---

# General task work

Use this playbook when the task has no named specialist playbook.

The runner may also prepend a task-specific repair section when the task names
a playbook that is absent from this configured runner. In that case, follow the
prepended instructions first: explain the exact unavailable name, offer the
configured alternatives and their launch directories or help creating the
requested playbook, update the descriptive next step, and wait for the user's
choice before work that depends on missing specialist instructions. Treat those
paths as profile configuration rather than proof of runtime readiness, and
verify the chosen setup before dependent work. Do not rewrite the assignment or
infer that the name is unavailable on other runners.

Read the task, comments, Domain instructions, and any non-empty workstream
snapshot provided by the runner. Determine which repositories or other
resources are relevant from that evidence. Before changing a repository, read
its applicable agent, contribution, and local setup instructions. A generic
task does not need a repository or workstream assignment; do not invent one.

Treat the task's current work Status as context, not as an instruction to repeat
or abandon work. In particular, opening a done or rejected task may be for
discussion or follow-up. Understand the current request and session history,
then perform the appropriate scoped work or ask one focused question when
essential context is missing. Do not reopen completed work, redo it, or exit
solely because the task is already closed.

Respect the approvals and scope recorded by the user, task, comments, Domain,
and repository guidance. Do not assume delivery, publication, access, or other
specialist permissions that only a named playbook grants. Keep the interactive
session open while waiting for requested context or an external event.

Keep the task's brief descriptive next step current at meaningful milestones:

```powershell
pan-task --config $env:PAN_TASK_BACKEND_CONFIG update $env:PAN_TASK_ID --input '{"nextStep":"<brief verified next step>"}'
```

```sh
pan-task --config "$PAN_TASK_BACKEND_CONFIG" update "$PAN_TASK_ID" --input '{"nextStep":"<brief verified next step>"}'
```

Clear obsolete text with `{"nextStep":""}` and put detailed progress,
questions, decisions, and verified results in task comments. `nextStep` never
dispatches work.

Change work Status only when the requested outcome justifies it. A discussion
or follow-up on completed work does not automatically reopen the task.

When the current request is complete, persist the final task comment and
explicitly set the justified outcome to `done` or `rejected`. Re-read the live
task and comments to verify those durable updates, then create the exact empty
`$PAN_STATE_DIR/worker-release.json` as the final action. The runner closes the
managed process and clears Agent status without changing the verified outcome
or saved session ID.

Do not create the release file while waiting for the user, waiting for external
work, or at an ordinary checkpoint. An explicitly requested early close uses
the same release file after its required durable checkpoint is verified; it
does not by itself justify changing work Status.
