# Playbooks

A playbook is a named set of worker instructions. Domain files live at
`playbooks/<machine>/<name>.md`; the task's `playbook` field selects the file
with the same name.

An empty task assignment selects Pan's portable general default playbook. The
default reads the task, comments, Domain and available workstream guidance, then
follows applicable repository instructions without inventing a repository or
workstream.

When a task explicitly names a playbook that is absent from this configured
runner, the runner preserves that assignment and opens the general default with
a prepended repair prompt. The worker explains the exact unavailable name,
offers the named playbooks actually usable on this runner, and asks whether to
correct the assignment or help create the requested playbook. It waits before
specialist-dependent work and never guesses a mapping or edits the assignment
without approval. Absence on one runner is not evidence of global absence.
Malformed playbooks, invalid working directories, and Domain loading or trust
errors remain explicit failures rather than default fallbacks.

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
