---
name: pan-attention
description: List Pan attention, record durable answers, and create Issue-backed tasks directly in GitHub.
---

# Pan attention

Read Project items with `gh project item-list`. An item whose
`needs-human-since` is non-empty has a worker waiting for the user right now;
that field is the signal, and its timestamp gives you staleness. Also inspect
blocked, needs-detail, and in-review Issues with `gh issue view`. Unresolved
runner questions use `<!-- pan:needs-human -->`. In-review work is attention
even without that marker. Runner shutdowns are not human attention.

Rank waiting workers by task priority and by how long they have waited. Each one
is holding a runner slot until it is answered.

To answer a runner question:

1. Re-read comments and Project fields. Stop if the request is already answered
   or resolved.
2. Add a comment containing `<!-- pan:answer -->`, `### Answer`, and the user's
   exact answer.
3. If the worker is still waiting, tell the user which machine, worktree, and
   terminal to answer in; the needs-human comment names all three. The worker
   continues from where it paused, so answering it there is always preferable to
   letting it restart.
4. Do not clear `needs-human-since`, change `owner`, `priority`, or `Status`, or
   touch `claimed-by` or `lease-until`. The worker owns clearing its own request,
   and overwriting those fields would hide a live worker or break its lease.
5. Re-read the Issue and Project item.

A recorded answer is durable task context: a worker that has to be relaunched
reads it from the Issue. Answering in the terminal and recording the answer on
the Issue are complementary, not alternatives.

To create a task, use `gh issue create` without the `Workstream` label, add that
open Issue to the configured Project as part of the same explicitly requested
operation, and initialize fields from `PAN_PROJECT_SCHEMA`. New tasks start
`untriaged` unless the user supplied enough information to triage immediately.
Confirm the Issue is open before registration and verify all fields afterward.
