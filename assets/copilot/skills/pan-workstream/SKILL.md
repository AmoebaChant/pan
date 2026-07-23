---
name: pan-workstream
description: Edit and publish a PAN workstream directly from the domain repository's default branch.
---

# PAN workstream delivery

Use this skill to create or update a workstream README in the configured domain.

1. Read the workstream and directly related live GitHub Issue or Project item.
2. Work directly in the domain repository on its default branch. Pull remote
   changes before editing. Do not create a feature branch or worktree.
3. Edit only the intended workstream README. Preserve unrelated changes and
   record durable facts rather than session-only claims.
4. Commit only the intended README with the repository convention and push the
   default branch. If the remote changed, pull and resolve the conflict without
   discarding either side, then push and verify the remote commit. Never
   force-push or discard unrelated changes.
