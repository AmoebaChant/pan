---
name: pan-attention
description: List PAN attention, record durable answers, and create Issue-backed tasks directly in GitHub.
---

# PAN attention

Read Project items with `gh project item-list` and inspect comments on blocked,
needs-detail, and in-review Issues with `gh issue view`. Unresolved runner
questions use `<!-- pan:needs-human -->`. In-review work is attention even
without that marker. Runner shutdowns are not human attention.

To answer a runner question:

1. Re-read comments and Project fields. Stop if the request is answered,
   resolved, or no longer blocked/needs-detail.
2. Add a comment containing `<!-- pan:answer -->`, `### Answer`, and the user's
   exact answer.
3. Restore prior owner and priority from the needs-human JSON, set status to
   `ready`, and preserve `resume.affinity` in `claimed-by` when present.
4. Add `<!-- pan:needs-human-resolved -->` with a short resolution.
5. Re-read the Issue and Project item.

To create a task, use `gh issue create`, add that open Issue to the configured
Project, and initialize fields from `PAN_PROJECT_SCHEMA`. New tasks start
`untriaged` unless the user supplied enough information to triage immediately.
Confirm the Issue is open before registration and verify all fields afterward.
