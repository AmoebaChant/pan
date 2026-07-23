---
name: pan-portfolio
description: Review and triage a PAN portfolio directly from live GitHub Issues and Project state.
---

# PAN portfolio review

Use this skill for portfolio review, next-work recommendations, Project triage,
ordering, or completion checks.

1. Parse `PAN_DOMAIN_PROJECT` as `<owner>/<number>` and read
   `PAN_PROJECT_SCHEMA`.
2. Read canonical Project order with `gh project item-list`. Read repository
   Issues directly with `gh issue list --state all`; fetch comments and linked
   pull requests only for relevant items.
3. Join Issue state to Project items by Issue URL. Exclude closed Issues from
   new or untriaged work even if the Project result lacks Issue state.
4. Classify every item, including done, blocked, leased, in-progress, in-review,
   ready, needs-detail, and untriaged work. Preserve Project order as human
   precedence within the same priority.
5. State recommendations with Issue URLs and current fields. Ask one focused
   question when the live data is insufficient.
6. For changes not explicitly requested, show proposed updates and get approval.
7. Immediately before each write, use `gh issue view` to confirm the Issue is
   still open and re-read the Project item. Preserve active runner fields.
8. Apply the smallest direct `gh project item-add`, `gh project item-edit`,
   `gh issue edit`, or `gh issue comment` operation. Re-read the target and
   report only confirmed effects.

Never automatically register all repository Issues. A closed Issue must never
be added or resurrected without an explicit user request.

## Scheduled review

First read the due metadata at `PAN_SCHEDULE_DUE_STATE`. If no review is due,
stop. When due, perform the same direct GitHub reads. Scheduled reviews are
read-only unless the user supplied an explicit standing mutation policy.
Update the due metadata after the attempt and never create another scheduler.
