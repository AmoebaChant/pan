---
name: pan-portfolio
description: Review and triage a Pan portfolio directly from live GitHub Issues and Project state.
---

# Pan portfolio review

Use this skill for portfolio review, next-work recommendations, Project triage,
ordering, or completion checks.

1. Parse `PAN_DOMAIN_PROJECT` as `<owner>/<number>` and read
   `PAN_PROJECT_SCHEMA`.
2. Read the canonical Project order in full. Prefer GraphQL cursor pagination
   (`items(first:100 after:$cursor)` repeated until `pageInfo.hasNextPage` is
   false) as the robust way to guarantee the complete item set. Otherwise use
   `gh project item-list <number> --owner <owner> --format json -L <large>`,
   but note `item-list` exposes no cursor, so a large `-L` alone is not proof of
   completeness: apply the same truncation-detection discipline as for Issues —
   if the returned item count equals the requested `-L`, treat the set as
   possibly truncated and fail closed (report the incompleteness and stop)
   rather than assuming completeness. Read every repository Issue with
   `gh issue list --state all --limit <large>`; because that limit is a hard cap
   with no truncation signal, verify the returned row count is strictly below
   the requested limit — if it equals the limit, treat the set as possibly
   truncated and fail closed (report the incompleteness and stop) rather than
   proceeding, or page fully with `gh api --paginate`/GraphQL. Fetch comments
   and linked pull requests only for relevant items.
3. Join Issue state to Project items by Issue URL. Automatically add every
   missing Issue, including closed Issues, with Project Status `untriaged`.
   Do not edit or reopen the Issue or rewrite an existing Project item.
   Then read the domain's workstream READMEs and collect any
   `## Backlog repositories` declarations (one `owner/repository` per list
   entry). Workstream discovery must be complete: if the workstream listing is
   truncated or incomplete, or any declared workstream README cannot be read,
   fail closed — report the incompleteness and reconcile no external
   repositories at all, because an undiscovered duplicate declaration could make
   an ambiguous repository look uniquely owned. Fetch each declared
   repository's complete Issue set with
   `gh issue list --repo <owner/repository> --state all --limit <large>`,
   applying the same truncation check (fail closed when the returned count
   equals the limit, or page fully), join by
   URL, and add
   the missing external Issues as `untriaged` with the declaring workstream in
   the `workstream` field. A repository maps to one workstream only: if two
   workstreams declare it, skip that repository and report the conflict. Never
   overwrite a conflicting existing `workstream`; surface it instead. External
   Issues stay in their owning repository — never create proxy Issues, and send
   comments, closures, and edits to `--repo <owner/repository>`.
   Because reconciliation must add *every* missing Issue, never claim the
   Project or Issue sets are complete unless truncation has been ruled out on
   each read.
4. Classify every open item, including done, blocked, leased, in-progress,
   in-review, ready, needs-detail, and untriaged work. Preserve Project order as
   human precedence within the same priority. Routine triage ignores closed
   Issues, including external backlog Issues: leave their registered Project
   item untouched and never reopen or retriage them unless the user explicitly
   asks to reconcile or modify a specific closed Issue.
5. State recommendations with Issue URLs and current fields. Ask one focused
   question when the live data is insufficient.
6. For changes not explicitly requested, show proposed updates and get approval.
7. Missing-Issue registration is automatic and does not require approval.
8. Validate every non-empty `workstream` field as a canonical relative path by
   reading `workstreams/<path>/README.md` through the GitHub Contents API.
9. Immediately before each write, use `gh issue view` to confirm current state
   and re-read the Project item. Preserve active runner fields.
10. Apply the smallest direct `gh project item-add`, `gh project item-edit`,
   `gh issue edit`, or `gh issue comment` operation. Re-read the target and
   report only confirmed effects.

Closed Issues are registered without changing their closed state or history, and
routine triage does not reclassify, reopen, or edit them.

## Scheduled review

First read the due metadata at `PAN_SCHEDULE_DUE_STATE`. Treat the review as due
when `nextReviewAt` is in the past or within the next 60 seconds; the recurring
tick and the due time drift against each other, so a near-miss otherwise costs a
full interval. If it is further out, stop. When due, perform the same direct GitHub reads and
missing-Issue registration. Other mutations remain read-only unless the user
supplied an explicit standing policy. Update the due metadata after the attempt
and never create another scheduler.
