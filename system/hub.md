# Pan Hub

Pan Hub is the local web application and headless session host in
[`AmoebaChant/pan-task-manager`](https://github.com/AmoebaChant/pan-task-manager).
It replaces terminal-window interaction with a workstream portfolio and one
shared chat panel. The central assistant is named **Pan** in the UI; chief
remains its internal role.

## Local operating scope

One user, one computer, one selected task backend, and local browser access.
Hub may manage the complete eligible portfolio selected by that backend. This
permission does not request every task or bypass task ownership rules. Private
Tailscale access is deferred.

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

Hub launches workers only for durable backend requests. Full-Domain access is
not an instruction to request every task. Requests still follow explicit user
instructions, Pan's normal task reasoning, or applicable standing authorization.

Routine tools may run under the explicitly configured permission policy.
Questions and permission exceptions remain distinct visible interactions.
Select and verify the configured model through ACP after creating or loading
the session, before sending a prompt. A process launch flag alone may leave a
different saved model selected. If the required model cannot be confirmed,
report the failure and do not run the conversation on a substitute.
Natural-language playbook instructions guide the agent; they are not a
mechanical sandbox.

If native ACP elicitation is unavailable, a small session-bound question tool
may bridge structured questions into the same web interaction. Do not parse
ordinary prose to guess at pending questions or approvals.

## Main Pan and Domain instructions

Load the chief role, the relevant `system/` contracts, the configured Domain's
`pan.md`, and the machine playbook catalog. Retain the existing Markdown
separation between judgment and mechanics: Pan chooses task edits and requests;
Hub applies task operations and observes requests.

Pan reads and manages the complete eligible portfolio for planning, briefing,
and task execution. Backend ownership rules still exclude tasks belonging to
other people.

Give Pan backend-neutral tools for live task enumeration, individual tasks and
comments, project destinations, workstream context, and task mutations. Read
live task state before every mutation and verify writes. When Domain
instructions require a named project
for creation, obtain and pass an explicit project ID. Do not create in Inbox
as a success-shaped fallback.

The main session does not implement development tasks itself. It records the
outcome, task guidance, workstream, and selected playbook, then requests a
worker with `agentStatus=requested`. It does not invent a session ID.

Existing references to a worker terminal mean that worker's Hub chat. Main
Pan lists tasks needing attention and directs the user to those conversations;
it does not collect answers on behalf of another session.

## Playbooks and dispatch

Use the existing [playbook](playbooks.md) loader and assignment semantics.
Workers use one reviewed Domain source: local `domainPath` or a pinned remote
`domainRepo` and `domainRevision`. Do not silently substitute the remote default
branch. The same source supplies Domain instructions and playbooks.

Snapshot the selected task and its comments, Domain instructions, selected
playbook, full workstream catalog, and selected workstream with source
provenance when opening a worker process. A named playbook selects its configured
working directory; a playbook without one starts in the task's private Hub
session directory so its Markdown can select or clone the correct workspace.
Task workspace setup and delivery decisions remain in Markdown. A blank
assignment uses the configured general default. An unavailable named assignment
remains requested and is not launched until Pan repairs it. Invalid
configuration is not a fallback case.

The mechanical dispatcher polls the selected backend for explicit requests
across the complete eligible portfolio. Hub-originated request writes may
trigger an immediate poll. A task already managed by Hub is not launched twice.
Work status, priority, dates, dependencies, and inferred readiness do not
filter requests. Backend ownership policy still determines eligibility.

Persist the ACP session ID and observed running status before beginning worker
execution. Keep task completion and worker closure independent. Requests are
durable backend state, not an in-memory queue. Log failed launches and leave
the request visible for retry instead of clearing it as if work had started.

Adding request polling does not add recurring autonomous chief scans. Those
need separate authorization.

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

Exercise the built application in a real browser: talk to Pan, have it create a
task in the configured Domain and request the selected worker, answer that
worker's question, and inspect the saved outcome and conversation. Start with
harmless local file changes; the first real task should be a bounded change with
an explicitly agreed delivery boundary.

## Cutover

Do not run the terminal runner and Hub against the same task requests
simultaneously. Verify the Hub before switching launchers. Preserve launcher
backups, existing conversations, and any unrelated running sessions.

Full-Domain access must remain visible after cutover. A working Hub is not
implicit approval to request or launch the backlog.
