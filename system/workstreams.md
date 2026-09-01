# Workstreams

A **workstream** is the durable narrative for one area of work: findings,
decisions, data, and current state. It lives at `workstreams/<path>/README.md`
on the default branch of the Domain repository. Folder nesting is the hierarchy.
The Project `workstream` field stores `<path>`, relative to `workstreams/`.

Workstreams are knowledge, not task state. Issues track actionable tasks; the
Project tracks their lifecycle. A workstream may link to Issues, but its README
is the story that outlives any single task and informs prioritization.

## Portfolio metadata

Each workstream README starts with YAML frontmatter that describes how the
workstream appears in portfolio views:

```yaml
---
title: Friendly Workstream Name
state: active
portfolio-order: 100
---
```

- **`title`** is the friendly display name. The folder path remains the stable
  workstream identifier used by Project items.
- **`state`** is one of `active`, `monitoring`, `back-burner`, or `closed`.
  Readers may accept legacy capitalization and map legacy `Exploring` to
  `monitoring`, but every write uses the canonical lowercase value.
- **`portfolio-order`** is a non-negative integer defining global workstream
  precedence across all states. Writers should leave gaps between values, such
  as `100`, `200`, and `300`, so most reorders update only the moved workstream.
  Rebalance all values only when no integer remains between adjacent items.

Portfolio metadata is planning and presentation state. It does not change task
lifecycle, runner eligibility, dispatch, ownership, or leases.

## Reading and writing

Access workstreams through the GitHub Contents API — never require a Domain
checkout.

- To update, read the file and its SHA immediately before writing, show the
  proposed Markdown, and get approval unless the user asked for that exact
  change. Write to the default branch and re-read to confirm. Never force-update
  a changed SHA.
- Metadata-only updates preserve all unrelated frontmatter and Markdown.
- After saving, scan for action items and ask whether any should become task
  Issues. List candidates; never create them silently.

## Routing new information to a workstream

When the user shares a durable fact, decision, or piece of state, decide which
workstream it belongs in by matching it against what each workstream's README
says it should hold. For example, "I just replaced the HVAC filter" belongs in a
home-maintenance workstream (e.g. `adulting-journal`) if that workstream's
README says it records household upkeep.

- If exactly one workstream clearly fits, propose adding the information there.
- If several could fit, or none clearly does, **ask** the user rather than
  guessing.
- If the information is really a new area, propose creating a new workstream.

Ephemeral or conversational remarks are not durable knowledge and do not need to
be recorded.

## Optional sections a README may declare

- **`## Backlog repositories`** — one `owner/repository` per list entry. During
  triage, Pan adds those repositories' Issues to the Domain Project as
  `untriaged` for triage. It adds a Project item that references each Issue — the
  Issue is never copied and stays in its own repository. More than one workstream
  may declare the same repository. Pan records the declaring workstream in an
  added item's `workstream` field when that is unambiguous; when several
  workstreams declare the same repository, it leaves the association unset rather
  than guessing. See [triage](triage.md).
- **`## Triage instructions`** — free-form prose that governs how Pan triages
  this workstream's backlog Issues. The single section applies to every backlog
  repository the workstream declares. It may direct Pan to recommend accept or
  reject and defer the decision to the user rather than acting.
