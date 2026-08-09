---
name: pan-workstream
description: Read and update Pan workstream narrative through the GitHub Contents API.
---

# Pan workstream

Use this to read or update a workstream's durable narrative and to route new
information to the right workstream.

Follow [`system/workstreams.md`](../../system/workstreams.md): workstreams live
at `workstreams/<path>/README.md` on the Domain repo's default branch, accessed
through the GitHub Contents API (never clone). For an update, read the file and
SHA immediately before writing, show the proposed Markdown, get approval unless
the user asked for that exact change, write to the default branch, and re-read to
confirm. After saving, scan for action items and ask whether any should become
task Issues.

When the user shares a durable fact, match it to the workstream whose README
says it should hold that kind of information and propose recording it there; when
several fit or none clearly does, ask rather than guess.
