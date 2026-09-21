---
name: pan-attention
description: Surface Pan questions and create Issue-backed tasks.
---

# Pan attention

Read the complete live task set and comments. Surface focused questions,
reviews, approvals, and decisions recorded by open worker sessions or task
discussion. `agentStatus=running` means the session remains available even
while awaiting the user.

Do not create an attention field, infer a permanent owner, or translate
comments into work Status. Direct the user to the open worker session when the
conversation belongs there.

To capture a task, create the backend-native task with `status=open`, normal
priority, no planned date, empty playbook/workstream/session, and blank Agent
status unless the user explicitly requested other values. GitHub tasks remain
Issue-backed and Project-ordered.
