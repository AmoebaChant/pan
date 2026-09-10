---
name: pan-attention
description: Surface Pan tasks waiting on the user and create Issue-backed tasks.
---

# Pan attention

Read the complete live Project and use
[`system/task-lifecycle.md`](../../system/task-lifecycle.md). Do not use the
legacy `owner` field.

Surface `ready-for-human` tasks by exact action (`clarify`, `discuss`,
`approve`, `review`, `act`), with Today first, then priority and staleness.
Also show paused/uncertain workers, but do not turn crash recovery into a
deliberate hold or automatically runnable task.

A live `worker-state=waiting-human` session may coexist with Needs me. Tell the
user the real machine/terminal to continue in; do not pretend browser chat is
connected. Do not clear attention, claims, leases, sessions, or generations
without the matching checked transition.

To capture a task, create a Domain Issue, add it to the Project, initialize
`ready-for-human/clarify`, `execution-authorized=no`, `worker-state=idle`,
revision 1, and the durable current-next-action block. A new checkpoint is not
automatically Today. Recurrence uses a first-line nominal occurrence marker and
separate `## Recurrence` cadence; the runner never dispatches it.
