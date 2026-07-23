---
name: pan-workstream
description: Safely edit and publish a PAN workstream with ordinary isolated git operations.
---

# PAN workstream delivery

Use this skill to create or update a workstream README in the configured domain.

1. Read the workstream and directly related live GitHub Issue or Project item.
2. Create an isolated worktree and feature branch from the current default
   branch. Never edit another session's workspace or the user's working tree.
3. Edit only the intended workstream README. Preserve unrelated changes and
   record durable facts rather than session-only claims.
4. Commit with the repository convention, merge with `--no-ff` into the default
   branch, push, and verify the remote commit. Never force-push or discard
   unrelated changes.
