---
name: pan-portfolio
description: Review and triage a Pan portfolio directly from live GitHub Issues and Project state.
---

# Pan portfolio review

Use this skill for portfolio review, next-work recommendations, Project triage,
ordering, or completion checks.

1. Parse `PAN_DOMAIN_PROJECT` as `<owner>/<number>` and read
   `PAN_PROJECT_SCHEMA`.
2. Read canonical Project order with `gh project item-list`. Read every
   repository Issue with `gh issue list --state all`; fetch comments and linked
   pull requests only for relevant items.
3. Join Issue state to Project items by Issue URL. Classify exact-`Workstream`
   Issues outside the Project as workstreams and non-Workstream Project Issues
   as tasks. Report Workstreams in the Project and non-Workstream Issues outside
   it as invalid states.
4. Classify every item, including done, blocked, leased, in-progress, in-review,
   ready, needs-detail, and untriaged work. Preserve Project order as human
   precedence within the same priority.
5. State recommendations with Issue URLs and current fields. Ask one focused
   question when the live data is insufficient.
6. For changes not explicitly requested, show proposed updates and get approval.
7. For open non-Workstream Issues outside the Project, propose adding them as
   tasks and wait for approval. Never automatically import arbitrary Issues.
   For Workstreams in the Project, propose removal. Detect task Issues carrying
   the Workstream label.
8. Validate every non-empty `workstream` field as a full URL to a Workstream
   Issue in this domain. A missing association is valid; infer and propose a
   likely URL without assigning it.
9. Immediately before each write, use `gh issue view` to confirm current state
   and re-read the Project item. Preserve active runner fields.
8. Apply the smallest direct `gh project item-add`, `gh project item-edit`,
   `gh issue edit`, or `gh issue comment` operation. Re-read the target and
   report only confirmed effects.

A closed Issue must never be newly registered or resurrected during normal
operation. The documented one-time migration is the only exception.

## Scheduled review

First read the due metadata at `PAN_SCHEDULE_DUE_STATE`. Treat the review as due
when `nextReviewAt` is in the past or within the next 60 seconds; the recurring
tick and the due time drift against each other, so a near-miss otherwise costs a
full interval. If it is further out, stop. When due, perform the same direct
GitHub reads. Scheduled reviews are read-only unless the user supplied an
explicit standing mutation policy. Update the due metadata after the attempt and
never create another scheduler.
