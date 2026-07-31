---
name: pan-portfolio
description: Review and triage a Pan portfolio directly from live GitHub Issues and Project state.
---

# Pan portfolio review

Use this skill for portfolio review, next-work recommendations, Project triage,
ordering, or completion checks.

1. Parse `PAN_DOMAIN_PROJECT` as `<owner>/<number>` and read
   `PAN_PROJECT_SCHEMA`.
2. Read canonical Project order with `gh project item-list`. Read repository
   Issues directly with `gh issue list --state all`; fetch comments and linked
   pull requests only for relevant items.
3. Join Issue state to Project items by Issue URL. Automatically add every
   repository Issue missing from the Project, including closed Issues, and set
   its Project Status to `untriaged`. Do not edit or reopen the Issue.
4. Re-read the Project, then classify every item, including done, blocked,
   leased, in-progress, in-review,
   ready, needs-detail, and untriaged work. Preserve Project order as human
   precedence within the same priority.
5. State recommendations with Issue URLs and current fields. Ask one focused
   question when the live data is insufficient.
6. For changes not explicitly requested, show proposed updates and get approval.
7. Immediately before each write, use `gh issue view` and re-read any existing
   Project item. Preserve active runner fields.
8. Apply the smallest direct `gh project item-add`, `gh project item-edit`,
   `gh issue edit`, or `gh issue comment` operation. Re-read the target and
   report only confirmed effects.

Missing-Issue registration is automatic and does not require approval. It adds
closed Issues without changing their closed state or history and never
overwrites fields on an existing Project item.

## Scheduled review

First read the due metadata at `PAN_SCHEDULE_DUE_STATE`. Treat the review as due
when `nextReviewAt` is in the past or within the next 60 seconds; the recurring
tick and the due time drift against each other, so a near-miss otherwise costs a
full interval. If it is further out, stop. When due, perform the same direct GitHub reads and
missing-Issue registration. Other scheduled-review mutations remain read-only
unless the user supplied an explicit standing policy. Update the due metadata
after the attempt and never create another scheduler.
