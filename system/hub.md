# Pan Hub

Pan Hub is the local web application and headless session host in
[`AmoebaChant/pan-task-manager`](https://github.com/AmoebaChant/pan-task-manager).
It replaces terminal-window interaction with a workstream portfolio and one
shared chat panel. The central assistant is named **Pan** in the UI; chief
remains its internal role.

## First release scope

One user, one computer, one selected task backend, and local browser access.
The first rollout permits portfolio reads but restricts writes and worker
launches to an explicitly configured test workstream. Expanding that boundary
requires the user's approval. Private Tailscale access is deferred.

Do not add a parallel task backend, audit subsystem, generic authorization
engine, or distributed scheduler. Use the existing task and workstream
interfaces. The host implements session mechanics; agents follow Markdown
instructions for business decisions.

## State and authority

- The selected task backend owns tasks, work status, planning fields, comments,
  agent requests, and saved worker session IDs.
- Workstream stores own their catalogs, narrative, and portfolio metadata.
- Copilot owns resumable agent conversations.
- Hub's local state records managed sessions, conversation display history,
  and pending interactions. It is not another task queue.

Read live state before mutations and surface failures. Completing a prompt,
closing a browser, or terminating a worker never means the task is done.
Archiving a finished chat preserves the task's saved session ID.

## Web interaction

Use the Garden visual direction:

- Workstream status groups are horizontal rows of workstream cards.
- Tasks show useful next steps and prominent needs-input treatment.
- The left pane header contains a clickable Pan character and the Workstreams,
  Needs Attention, and Archive views. Avoid redundant headings and summaries.
- The right chat pane starts at the same vertical position, with an
  equal-height, differently colored header.
- A draggable and keyboard-adjustable divider controls pane widths.
- Clicking Pan selects the main conversation. Clicking a task selects its
  worker conversation. Do not route task-specific decisions through the main
  Pan conversation.
- Show questions inline with suggested answers, any provided default, and a
  freeform alternative. The user must explicitly submit their answer.
- Keep unanswered questions visibly attached to their task and workstream.
  Dismissing a question does not answer or approve it.

Operational attention is separate from task work status. A pending question
does not change priority, work status, planned date, or task ownership.

## Headless sessions

Hub acts as an ACP client to local `copilot --acp --stdio` subprocesses. Neither
ACP nor backend credentials are exposed to browser clients. Negotiate the
installed agent's capabilities rather than assuming draft protocol features.

There is one persistent main Pan conversation and one persistent conversation
per task. Active sessions use separate subprocesses. Session IDs come from the
agent's session creation response and are saved before subsequent reuse.
Supported resume/load operations reconnect the conversation; never silently
replace a failed resume with a new conversation.

Hub requests and launches workers only within its configured operator scope.
An overnight test boundary is not authority to triage or dispatch the rest of
the portfolio. The main Pan session must receive the same restriction.

Routine tools may run under the explicitly configured permission policy.
Questions and permission exceptions remain distinct visible interactions.
Natural-language playbook instructions guide the agent; they are not a
mechanical sandbox.

If native ACP elicitation is unavailable, a small session-bound question tool
may bridge structured questions into the same web interaction. Do not parse
ordinary prose to guess at pending questions or approvals.

## Completion and interruption

Retain the existing `worker-release.json` convention for the first release.
The worker persists and verifies its final task outcome, then creates the
empty release file as its final action. Hub observes the file and closes only
that managed worker process. No custom completion protocol is necessary.

When a process actually exits, clear its agent status while retaining its
session ID and work status. An ordinary ACP end-of-turn is not a process exit
or release request. Waiting for input does not release the worker.

Stopping or restarting Hub must not present interrupted interactions as
successful. Saved conversations remain available; connection-bound questions
must be reissued if their original connection is lost. A browser disconnect
does not stop workers.

## Debugging and tests

Write a local debugging log with timestamps and enough session/task context to
follow launches, requests, connection failures, and process exits. Do not log
credentials. Expose the log location in operational documentation.

Automated coverage should focus on core backend and session behavior, scope
checks, question responses, and persistence. Do not create a brittle visual
regression or UI test suite while the product is iterating.

Exercise the built application in a real browser: talk to Pan, create a task
in the authorized test workstream, start a worker, answer a question, verify a
harmless local file change, and inspect the saved outcome and conversation.

## Cutover

Do not run the terminal runner and Hub against the same task requests
simultaneously. Verify the Hub before switching launchers. Preserve launcher
backups, existing conversations, and any unrelated running sessions.

The first test rollout must remain visibly restricted after cutover. A working
Hub is not implicit approval to expand its write or dispatch scope.
