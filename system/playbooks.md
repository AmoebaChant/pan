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
```

`name` and `description` are required. `workingDirectory` is optional when the
runner config provides one, and otherwise must be absolute.

The runner does not interpret playbook prose as fields or policy. It does not
derive capabilities, authorization, dependencies, concurrency limits,
workspace slots, completion, or release from front matter. The instructions
themselves own repository selection, task-local setup, delivery gates, and when
to edit work Status or explicitly close the session early.

Chief sessions read live playbooks when deciding whether agent help is useful.
Choosing a playbook and setting `agentStatus=requested` are separate explicit
task edits.
