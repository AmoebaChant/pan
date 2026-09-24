# Pan programs

Node 22+, ESM, built-ins only.

## Tasks

`pan-task.js` exposes backend-neutral list/get/create/update/comment/comments/
complete/reopen operations. GitHub access uses authenticated `gh`; Todoist
credentials come from the configured local credential file.

## Runner

`pan-runner.js` and `pan-backend-runner.js` are the same runner path. It loads a
reviewed Domain source, opens or resumes `agentStatus=requested`, records
`running` after spawn, and clears Agent status after release or closure.

## Other programs

`pan-chief.js` starts or resumes the persistent chief session.
`pan-workstreams.js` reads the Domain store registry and authoritative digests,
returns one provenance-rich catalog, and resolves detailed workstream
documents without writing them.
`pan-briefing-mcp.js` hosts the optional local briefing review surface.
`pan-source-intake.js` performs explicitly configured source registration for a
non-GitHub backend.
