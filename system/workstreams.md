# Workstreams

A **workstream** is the durable narrative for one area of work: findings,
decisions, data, and current state. Its stable identifier is one unqualified
path such as `teams-meeting-stage/avatar-support`. The selected task backend's
`workstream` field stores exactly that path.

Workstreams are knowledge, not task state. Issues or another selected backend
track actionable tasks. A workstream may link to tasks, but its README is the
story that outlives any single task and informs prioritization.

## Stores and identity

The Domain repository is always the implicit writable store `domain`. A Domain
may mount more writable GitHub repositories through `workstream-stores.json`:

```json
{
  "version": 1,
  "defaultStore": "domain",
  "stores": [
    {
      "id": "shared",
      "repository": "organization/shared-workstreams"
    }
  ]
}
```

`stores` contains only additional stores. Store ids are lowercase letters,
digits, and hyphens, start with a letter, and cannot be `domain`.
`defaultStore` names `domain` or one configured additional store. Repository
names use `owner/repository`.

The same workstream path must not appear in more than one configured store.
Every reader rejects duplicate paths explicitly; store order and
`defaultStore` never resolve ambiguity. Existing task values therefore remain
portable, unqualified paths while each catalog entry supplies its owning store
and repository.

There is no read-only store mode, personal overlay, or private metadata layer.
All workstream content and portfolio metadata belong to the owning store and
are shared with everyone who uses it.

## Store catalog

Every store has an authoritative `workstreams/README.md` digest. Readers use
the digest to enumerate workstreams instead of recursively searching the
repository. It lists every root and nested workstream in this exact format:

```markdown
# Workstreams

<!-- pan-workstream-catalog:v1 -->

| Path | Name | Description |
| --- | --- | --- |
| [product](product/README.md) | Product | Product direction and decisions. |
| [product/launch](product/launch/README.md) | Launch | Launch readiness and evidence. |
```

The heading, marker, table headings, and separator are literal. Each following
line is one catalog row. The path is relative to `workstreams/`; its link must
be exactly `<path>/README.md`. Name and description must be non-empty,
single-line text without a pipe character. The description is deliberately
brief; detailed context remains in `workstreams/<path>/README.md`.

Creating, renaming, moving, or removing a workstream updates its owning
store's digest in the same change. Workers may create workstreams when the task
and approval allow it, subject to the same rule.

## Selecting a store

Use an explicit user or Domain instruction when it names the destination
store. Otherwise use `defaultStore` only when Domain policy clearly makes that
default appropriate for the new workstream. If the appropriate store is not
clear, ask the user rather than guessing. Never infer a store from search
order, repository visibility, subject matter, or where a related task lives.

Before creating or moving a workstream, enumerate the live catalogs and verify
that its path is globally unused. Before any write, re-read the owning
repository's live digest and affected README with their current revisions.

## Portfolio metadata

Each detailed workstream README starts with YAML frontmatter that describes how
the workstream appears in portfolio views:

```yaml
---
title: Friendly Workstream Name
state: active
portfolio-order: 100
---
```

- **`title`** is the friendly display name. The catalog name should match it.
  The folder path remains the stable identifier used by tasks.
- **`state`** is one of `active`, `monitoring`, `back-burner`, or `closed`.
  Readers may accept legacy capitalization and map legacy `Exploring` to
  `monitoring`, but every write uses the canonical lowercase value.
- **`portfolio-order`** is a non-negative integer defining global workstream
  precedence across all stores and states. Writers should leave gaps between
  values, such as `100`, `200`, and `300`, so most reorders update only the
  moved workstream. Rebalance all values only when no integer remains between
  adjacent items.

Portfolio metadata is planning and presentation state. It does not change task
lifecycle, runner eligibility, dispatch, ownership, or leases.

## Reading and writing

Chief sessions use the checkout supplied by their launcher:
`node "$PAN_CHECKOUT/bin/pan-workstreams.js" list --config "$PAN_CONFIG"`
(PowerShell:
`node (Join-Path $env:PAN_CHECKOUT 'bin\pan-workstreams.js') list --config $env:PAN_CONFIG`).
Use the same path with `resolve <path>` to read one detailed README with source
provenance. Do not assume the packaged bin is globally installed. Direct
package users may use the installed `pan-workstreams` bin. The config uses
Pan's existing `domainPath` or `domainRepo` source fields; a remote
`domainRevision` may pin the Domain source for a runner, while chief sessions
normally read live default branches.

Access GitHub-backed workstreams through the GitHub Contents API.

- To update, read the file and its SHA immediately before writing, show the
  proposed Markdown, and get approval unless the user asked for that exact
  change. Write to the owning repository's default branch and re-read to
  confirm. Never force-update a changed SHA.
- Metadata-only updates preserve all unrelated frontmatter and Markdown.
- A title change also updates the matching catalog row's name in the same
  change.
- After saving, scan for action items and ask whether any should become task
  Issues. List candidates; never create them silently.

One unavailable or malformed configured store makes complete enumeration fail
with the store id and repository. Readers must not silently continue with a
partial catalog or resolve the same path from another store.

## Routing new information to a workstream

When the user shares a durable fact, decision, or piece of state, enumerate the
catalog and decide which workstream it belongs in by matching the digest and,
as needed, detailed README context.

- If exactly one workstream clearly fits, propose adding the information there.
- If several could fit, or none clearly does, **ask** the user rather than
  guessing.
- If the information is really a new area, propose creating a new workstream
  and identify its store under the selection rules above.

Ephemeral or conversational remarks are not durable knowledge and do not need
to be recorded.

## Optional sections a README may declare

- **`## Backlog repositories`** — one exact `owner/repository` per list entry.
  For the GitHub backend, triage adds those repositories' Issues to the Domain
  Project as `untriaged`. For a non-GitHub backend, these declarations become
  intake sources only when live `task-backend.json` explicitly enables
  `sourceIntake.githubIssues.workstreamBacklogs`; ordinary README links never
  count. More than one workstream may declare the same repository. Pan records
  the declaring workstream when that is unambiguous and leaves it unset rather
  than guessing when several declare it. See [source intake](source-intake.md)
  and [triage](triage.md).
- **`## Triage instructions`** — free-form prose that governs how Pan triages
  this workstream's backlog Issues. The single section applies to every backlog
  repository the workstream declares. It may direct Pan to recommend accept or
  reject and defer the decision to the user rather than acting.
