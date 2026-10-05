# Triage

Triage reads the complete live task set and decides what the work record should
say. The runner has no role in this judgment.

For GitHub, join every Domain Issue to the Project by URL and register missing
Issues without editing or reopening them. For Todoist, fully paginate the
configured scope. Preserve backend order as precedence within equal priority.

Enumerate the complete live workstream catalog through the shared resolver,
then read detailed workstream documents only as needed. Never use a runner
snapshot as current chief state. Read live playbooks and relevant workstream
context. For each task, decide:

- whether its work Status remains open, is done, or is rejected;
- priority, planned date, brief current next step, deadline, playbook, and
  workstream;
- what dependency, approval, hold, review, or delivery context belongs in task
  text or comments; and
- whether opening or resuming its saved agent session would be useful.

These are explicit business decisions. Keep `nextStep` descriptive; do not
derive a permanent owner, create a next-action state pair, encode dependencies
or authorization as runner gates, or turn a comment into a state transition.

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

## Efficient live review

Start with one complete live task inventory and the complete workstream catalog.
Use those reads to assess every eligible task; complete coverage does not mean
fetching every linked document or investigating every adjacent concern.

Batch independent evidence reads. For GitHub, retrieve relevant Issue comments
with paginated `gh` reads or batched GraphQL rather than serial per-task commands
that each re-enumerate the entire Project. Keep the configured backend as the
authority and use its task identities and mutation contract; these reads do not
create another task store. Run independent read batches concurrently where
supported rather than hiding serial reads inside one long shell command.

Read enough comment history to establish current approvals, holds, dependencies,
and review gates. Do not assume the last few comments contain every unresolved
constraint. Fetch full workstream documents and linked PR, pipeline, or external
records only when they can change a classification or recommendation. Keep
returned context focused on the decision rather than dumping large histories.

Reuse evidence already read live during this review for analysis, not as durable
state. Re-read before mutations and verify afterward. Incorporate changes found
during the review without restarting unrelated investigation; repeat broader
reads only when the changed state invalidates their conclusions.

## Applying decisions

When assigning a workstream, use an exact path present in the live catalog.
Paths are globally unique across configured stores, so the task value remains
unqualified. If selecting a store for a new workstream is not clearly governed
by an explicit instruction or the configured default policy, ask rather than
guess.

Read and recommend freely. An explicit user request authorizes that exact
change; otherwise show the proposed task edits and obtain approval. Re-read
immediately before writing and verify afterward.

Scheduled triage may perform documented standing-authorized reconciliations
and missing-Issue registration. It must not manufacture approval, task
completion, rejection, session requests, or session release.
