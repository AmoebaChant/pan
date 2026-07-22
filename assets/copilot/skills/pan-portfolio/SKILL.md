---
name: pan-portfolio
description: Review a configured PAN portfolio using complete evidence, deterministic reconciliation, and safe action helpers.
---

# PAN portfolio review

Use this skill for a portfolio review, a next-work recommendation, Project
triage, ordering, or reconciliation request.

1. Read fresh complete evidence:
   `pan evidence portfolio --schema-version 1 --config <config> --json`.
   Stop and explain the diagnostics if its result is incomplete or not usable
   for mutation.
2. Classify every Project item. Account explicitly for completed, protected,
   blocked, leased, in-progress, and in-review work; do not replace the
   canonical Project order with a local queue.
3. In a writing session, run deterministic maintenance before model-selected
   changes:
   - `pan reconcile missing-issues --apply --schema-version 1 --config <config> --json`
   - `pan reconcile merged-prs --apply --schema-version 1 --config <config> --json`
   Refresh the portfolio after any confirmed effect.
4. State the recommendation with durable evidence, rationale, confidence, and
   uncertainty. Ask a focused question when evidence cannot support a safe
   decision.
5. For a model-selected mutation, write the supported action document, then run
   `pan action validate --action-file <file> --schema-version 1 --config <config> --json`.
   Apply only a validated action while current leadership is confirmed:
   `pan action apply --action-file <file> --schema-version 1 --config <config> --json`.

Treat the helper envelope as authoritative. Report its actual status and
confirmed effects; do not call a rejected, incomplete, or unconfirmed action
successful.

## Scheduled review

For a native scheduled turn, first read the launch-local due metadata named by
`PAN_SCHEDULE_DUE_STATE`. If `nextReviewAt` has not arrived, report that no
review is due and do not make a portfolio decision or mutation. When it is due,
perform the same reconciliation and fresh evidence steps above immediately
before reasoning. After the review attempt, update the metadata with the review
time and next configured due time. Never use a prior conversation or a missed
session as evidence that a review is due, and never create another scheduler or
retry loop.
