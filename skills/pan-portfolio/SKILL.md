---
name: pan-portfolio
description: Review and triage a Pan portfolio from live backend and Domain state.
---

# Pan portfolio review

Follow `system/triage.md`, `system/task-lifecycle.md`, and
`system/project-schema.md`. Fully paginate the selected backend, register
missing GitHub Domain Issues when applicable, and read live workstreams,
comments, and playbooks.

Consider every eligible task for human attention and agent help regardless of
date, priority, work Status, or saved session. Prepare explicit changes to work
Status, priority, dates, playbook, workstream, task text/comments, and Agent
status. Do not derive an owner or recreate next-action, authorization,
dependency, attention, worker, claim, lease, or revision fields.

Request a session by setting `agentStatus=requested`; this is valid for any
task. Work Status changes never close a session. Surface running workers and
their comments without translating them into another lifecycle.

Read and recommend freely. Before every non-standing mutation, show the
current and proposed values and obtain approval. Re-read and verify writes.
