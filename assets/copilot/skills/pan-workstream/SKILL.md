---
name: pan-workstream
description: Read, create, update, archive, and relate Pan Workstream Issues through GitHub APIs.
---

# Pan workstream delivery

A workstream is a long-lived Issue in `PAN_DOMAIN_REPOSITORY` carrying the exact
`Workstream` label. Its body is canonical GitHub Flavored Markdown. It must
never be added to the backlog Project. Parent/sub-issue relationships represent
nested workstreams, and closing the Issue archives it.

1. Read the Workstream Issue, its parent and children, and directly associated
   live task items.
2. For an update, show the proposed body or structured update comment and get
   approval unless the user explicitly requested that exact change.
3. Re-read the Issue immediately before writing. Update its body with
   `gh issue edit`; record significant change context in a comment containing
   `<!-- pan:workstream-update -->`.
4. Create workstreams with the exact label and no Project membership. Use
   GitHub's documented sub-issue API to establish an approved parent.
5. Re-read the Issue and relationships after every write.
6. Scan saved content for action items. Ask whether any should become domain
   task Issues; list candidates and never create them silently.

Activity reports use the current body as current state, structured comments,
documented edit metadata, and associated task activity. State explicitly when
historical body diffs are unavailable.
