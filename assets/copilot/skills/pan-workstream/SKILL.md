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
