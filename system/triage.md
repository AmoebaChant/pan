# Triage

Triage reads the complete live task set and decides what the work record should
say. The runner has no role in this judgment.

For GitHub, join every Domain Issue to the Project by URL and register missing
Issues without editing or reopening them. For Todoist, fully paginate the
configured scope. Preserve backend order as precedence within equal priority.

Read live playbooks and relevant workstream context. For each task, decide:

- whether its work Status remains open, is done, or is rejected;
- priority, planned date, deadline, playbook, and workstream;
- what dependency, approval, hold, review, or delivery context belongs in task
  text or comments; and
- whether opening or resuming its saved agent session would be useful.

These are explicit business decisions. Do not derive a permanent owner, create
a next-action field, encode dependencies or authorization as runner gates, or
turn a comment into a state transition.

Request agent help by setting `agentStatus=requested`. This is valid for every
task, including done and rejected tasks. If `sessionId` is empty, the runner
creates one. If it exists, the runner resumes it. Do not manually invent a
session ID merely to satisfy a gate.

Changing work Status never releases a session, and blank Agent metadata is not
a close command. When the user wants an active session closed, direct that
session explicitly; the worker follows its playbook's early-close procedure or
the user closes the process. A worker awaiting the user remains running and
should be surfaced from its comments and live session, not through a separate
attention field.

Read and recommend freely. An explicit user request authorizes that exact
change; otherwise show the proposed task edits and obtain approval. Re-read
immediately before writing and verify afterward.

Scheduled triage may perform documented standing-authorized reconciliations
and missing-Issue registration. It must not manufacture approval, task
completion, rejection, session requests, or session release.
