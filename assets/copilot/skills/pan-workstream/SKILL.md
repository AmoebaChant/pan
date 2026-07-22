---
name: pan-workstream
description: Safely prepare, edit, and publish a PAN domain workstream directly to its default branch.
---

# PAN workstream delivery

Use this skill to create or update a workstream README in the configured PAN
domain. Workstreams are domain narrative, not product-context content.

1. Read the current workstream and obtain fresh portfolio evidence if the update
   records a recommendation, commitment, or state transition.
2. Confirm current writing leadership. Never edit another session's workspace
   or the user's working tree for PAN delivery.
3. Prepare an isolated workspace:
   `pan workstream prepare <workstream-path> --rationale <reason> --source-turn <turn> --schema-version 1 --config <config> --json`.
4. Edit only the prepared workstream README. Keep the hierarchy represented by
   its folder path, preserve unrelated changes, and record durable facts rather
   than session-only claims.
5. Publish using the returned operation ID:
   `pan workstream publish <operation-id> --schema-version 1 --config <config> --json`.

The publish result is the delivery receipt. Report its commit and push only when
they are confirmed. If it is rejected or incomplete, preserve the reported
workspace and follow its safe recovery steps; never force-push, discard remote
changes, or create a replacement delivery branch.
