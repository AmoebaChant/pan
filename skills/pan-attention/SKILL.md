---
name: pan-attention
description: Surface Pan tasks waiting on the user and create Issue-backed tasks.
---

# Pan attention

Use this to find what needs the user and to create new tasks.

Read the complete Project item set live with `gh` (see
[`system/triage.md`](../../system/triage.md) for reading completely). A task with
a non-empty `needs-human-since` has a worker waiting for the user right now; that
field is the signal and its timestamp gives staleness (see
[`system/project-schema.md`](../../system/project-schema.md) and
[`system/runner.md`](../../system/runner.md)). Rank waiting workers by priority
and how long they have waited; each holds a runner slot until answered. Also
surface `in-review`, `blocked`, and `needs-detail` items.

To answer a waiting worker, tell the user which machine and terminal to answer
in — the worker continues from where it paused, so that is preferable to
restarting it. Do not touch `needs-human-since`, `claimed-by`, or `lease-until`;
the worker clears its own request.

To create a task, `gh issue create`, add it to the Project, and initialize
fields per the schema. New tasks start `untriaged` unless the user gave enough
to triage immediately. Verify fields afterward.
