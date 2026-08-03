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
3. Join Issue state to Project items by Issue URL. Automatically add every
   missing Issue, including closed Issues, with Project Status `untriaged`.
   Do not edit or reopen the Issue or rewrite an existing Project item.
4. Classify every open item, including done, blocked, leased, in-progress,
   in-review, ready, needs-detail, and untriaged work. Preserve Project order as
   human precedence within the same priority. Routine triage ignores closed
   Issues: leave their registered Project item untouched unless the user
   explicitly asks to reconcile or modify a specific closed Issue.
5. State recommendations with Issue URLs and current fields. Ask one focused
   question when the live data is insufficient.
6. For changes not explicitly requested, show proposed updates and get approval.
7. Missing-Issue registration is automatic and does not require approval.
8. Validate every non-empty `workstream` field as a canonical relative path by
   reading `workstreams/<path>/README.md` through the GitHub Contents API.
9. Immediately before each write, use `gh issue view` to confirm current state
   and re-read the Project item. Preserve active runner fields.
8. Apply the smallest direct `gh project item-add`, `gh project item-edit`,
   `gh issue edit`, or `gh issue comment` operation. Re-read the target and
   report only confirmed effects.

Closed Issues are registered without changing their closed state or history, and
routine triage does not reclassify or edit them.

## Scheduled review

First read the due metadata at `PAN_SCHEDULE_DUE_STATE`. Treat the review as due
when `nextReviewAt` is in the past or within the next 60 seconds; the recurring
tick and the due time drift against each other, so a near-miss otherwise costs a
full interval. If it is further out, stop. When due, perform the same direct GitHub reads and
missing-Issue registration. Other mutations remain read-only unless the user
supplied an explicit standing policy. Update the due metadata after the attempt
and never create another scheduler.
