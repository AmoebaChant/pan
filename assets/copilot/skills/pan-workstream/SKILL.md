---
name: pan-workstream
description: Edit and publish repository-backed Pan workstreams through the GitHub Contents API.
---

# Pan workstream delivery

A workstream is the durable knowledge for an area, stored at
`workstreams/<path>/README.md` on the default branch of
`PAN_DOMAIN_REPOSITORY`. Folder nesting is the hierarchy. The Project
`workstream` field stores `<path>`, relative to `workstreams/`. GitHub Issues
track actionable tasks; they do not replace the workstream narrative.

1. Read repository guidance, the workstream README, its parent and child
   READMEs, and directly associated live task items through GitHub APIs.
2. For an update, show the proposed Markdown and get approval unless the user
   explicitly requested that exact change.
3. Re-read the file and SHA immediately before writing. Create or update it with
   the GitHub Contents API on the default branch using the repository's commit
   convention. Never clone the domain or force-update a changed SHA.
4. Re-read the file after every write and report the confirmed commit.
5. Scan saved content for action items. Ask whether any should become domain
   task Issues; list candidates and never create them silently.

To include an external repository's Issues in this domain's backlog, add a
`## Backlog repositories` section to the workstream README and list each
`owner/repository` on its own line. Portfolio reconciliation then registers
those Issues in the domain Project as `untriaged`, associated with this
workstream. A repository may be declared by only one workstream in the domain;
the Issues remain in their owning repository, so all comments, closures, and
edits target that repository.

A workstream README may also add a `## Triage instructions` section with
free-form prose that governs how Pan triages that workstream's backlog Issues.
The single section applies to all of the backlog repositories that workstream
declares.
