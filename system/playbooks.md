# Playbooks

A playbook is a named set of worker instructions. Domain files live at
`playbooks/<machine>/<name>.md`; the task's `playbook` field selects the file
with the same name.

```markdown
---
name: tool-development
description: Implement and publish a reviewed tool change.
workingDirectory: C:\Repos
---

# tool-development

<setup, implementation, validation, delivery, and decision instructions>

Keep `nextStep` current at meaningful milestones with the existing task API:
`pan-task --config "$PAN_TASK_BACKEND_CONFIG" update "$PAN_TASK_ID" --input
'{"nextStep":"<brief verified next step>"}'`. Clear it when that text no longer
applies; keep detailed progress in comments.
```

`name` and `description` are required. `workingDirectory` is optional when the
runner config provides one, and otherwise must be absolute.

The runner does not interpret playbook prose as fields or policy. It does not
derive capabilities, authorization, dependencies, concurrency limits,
workspace slots, completion, or release from front matter. The instructions
themselves own repository selection, task-local setup, delivery gates, and when
to edit descriptive task fields or work Status, and when to explicitly close
the session early.

Chief sessions read live playbooks when deciding whether agent help is useful.
Choosing a playbook and setting `agentStatus=requested` are separate explicit
task edits.
