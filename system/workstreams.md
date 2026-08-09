# Workstreams

A **workstream** is the durable narrative for one area of work: findings,
decisions, data, and current state. It lives at `workstreams/<path>/README.md`
on the default branch of the Domain repository. Folder nesting is the hierarchy.
The Project `workstream` field stores `<path>`, relative to `workstreams/`.

Workstreams are knowledge, not task state. Issues track actionable tasks; the
Project tracks their lifecycle. A workstream may link to Issues, but its README
is the story that outlives any single task and informs prioritization.

## Reading and writing

Access workstreams through the GitHub Contents API — never require a Domain
checkout.

- To update, read the file and its SHA immediately before writing, show the
  proposed Markdown, and get approval unless the user asked for that exact
  change. Write to the default branch and re-read to confirm. Never force-update
  a changed SHA.
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

- **`## Backlog repositories`** — one `owner/repository` per list entry. Triage
  registration mirrors those repositories' Issues into the Domain Project as
  `untriaged`, associated with this workstream. A repository may be declared by
  only one workstream. The Issues stay in their owning repository. See
  [triage](triage.md).
- **`## Triage instructions`** — free-form prose that governs how Pan triages
  this workstream's backlog Issues. The single section applies to every backlog
  repository the workstream declares. It may direct Pan to recommend accept or
  reject and defer the decision to the user rather than acting.
