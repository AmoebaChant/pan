---
name: default-playbook
description: General task work guided by the task, Domain, workstream, and applicable repository instructions.
---

# General task work

Use this playbook when the task has no named specialist playbook.

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
or follow-up on completed work does not automatically reopen the task. Exit
normally when the current request is complete; create the runner release file
only when the user or applicable guidance explicitly directs an early close.
