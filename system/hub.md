# Pan Hub

Pan Hub is the local web application and headless session host in
[`AmoebaChant/pan-task-manager`](https://github.com/AmoebaChant/pan-task-manager).
It replaces terminal-window interaction with a task area and one shared chat
area. The central assistant is named **Pan** in the UI; chief remains its
internal role.

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

- Workstream status groups contain wrapping rows of workstream cards without
  horizontal page scrolling. Cards can be reordered and moved between status
  groups with a visible insertion gap; write the resulting state and portfolio
  order to the owning workstream store after a live re-read.
- Tasks show useful next steps, their next-action date at the bottom right of
  dated cards, and prominent needs-input treatment.
- Checking a task completes it in the selected backend immediately in the
  local projection, keeps the fresh completion in its current portfolio view
  with a struck-through title, and allows reopening through undo or the same
  control. When a recurring backend reuses that task ID for its next
  occurrence, replace the completed projection with the authoritative open
  occurrence and reapply the active view predicate. A future occurrence must
  leave Today immediately; another occurrence still due today remains visible
  and incomplete.
- The left pane header contains a clickable Pan character followed by Today,
  All, Agents, and Options, in that order. Today contains open tasks
  whose next-action date is the local date today or earlier. Workstreams remain
  visible by default in Today and All and use the positive/green treatment when
  that view has no matching tasks. A portfolio control lets the user show or
  hide those empty workstreams after the active task filter is applied. Persist
  that choice independently for each workstream-backed view across navigation,
  reload, and Hub restart. Never show an empty **Tasks without a workstream**
  fallback card. Avoid redundant headings and summaries.
- Call the left content pane the **Task Area** and the right pane the **Chat
  Area**. Today, All, and Agents select task scope; Options selects how that
  scope is presented and which completion bands are visible. The Task Area offers
  **Workstreams** and **Task List** presentations. Task List can group tasks by
  workstream or by status in this order: incomplete, completed today, completed
  earlier. Do not repeat a task's workstream on each task when its containing
  group already identifies that workstream. Workstreams retains its
  empty-workstream option.
- Dismiss Options when a pointer is pressed outside it or Escape is pressed.
  Interacting with controls inside the panel keeps it open; Escape returns
  focus to Options.
- Keep a search field at the top of the Task Area, above its scrolling content,
  on desktop and phone. Apply case-insensitive, space-separated search terms
  to task titles, descriptions, next steps, and workstream paths, titles, and
  descriptions. Require all terms to match. A matching workstream includes its
  tasks; a matching task retains its containing workstream. Search composes
  with Today/All and Agents, and the applicable completion visibility and
  empty-workstream preferences, in both presentations and both Task List
  groupings, without mutating task or workstream state. Offer a clear control
  and an explicit no-matches state.
- Agents contains tasks with running/requested agents, agents waiting for
  human input or answer delivery, and resumable stopped/interrupted sessions
  on open tasks. Completed/rejected tasks remain in Agents while their agent
  is active or waiting, not merely because old history exists. Show readable
  agent state on each task. This scope is independent of task dates and
  completion-history visibility; hide empty workstreams. Support search,
  both presentations, and both Task List groupings without changing backend
  status or session intent merely by navigating.
- In Today and All, both Task Area presentations offer independent visibility
  for tasks completed today and tasks completed earlier. Persist presentation
  and Task List grouping globally, and completion visibility independently per top-level
  scope across navigation, reload, and Hub restart. Today never includes
  completions from earlier days. All remains the complete open scope plus
  whichever completion bands are enabled. Needs-input treatment remains inline
  on matching tasks; completed history is available through All's completion
  options rather than separate Needs Attention or Archive scopes.
- The right chat pane starts at the same vertical position, with an
  equal-height, differently colored header.
- A draggable and keyboard-adjustable divider controls pane widths.
- Clicking Pan selects the main conversation. Clicking a task selects its
  worker conversation, and double-clicking a task opens its edit dialog. Tasks
  can be reordered within a workstream or moved to another writable workstream
  with a visible insertion gap. Do not route task-specific decisions through
  the main Pan conversation.
- On phone-width screens, replace the two-pane layout with one content area and
  an iPhone-style bottom bar for Pan, Today, All, Agents, Options, and Create
  task. Pan opens the main conversation. Today and All show the same
  workstream portfolio with their corresponding task filter. Opening a task
  replaces the portfolio with its worker conversation, whose top-left back
  control returns to the current filtered portfolio. Keep the page background
  solid through the top safe area and browser overscroll; do not fade to the
  browser's default white surface.
- Show questions inline with suggested answers, any provided default, and a
  freeform alternative. The user must explicitly submit their answer. Waiting
  for that answer has no user-response deadline; bridge questions must not keep
  one timeout-bound MCP request open for the duration of the wait.
  Hide the ordinary message composer in both Main Pan and worker chats while
  a question is unanswered or its answer is awaiting delivery, including a
  failed delivery that needs retry. Keep the question's answer and retry
  controls available. Restore the composer with its existing draft and
  attachments once the agent receives the answer.
- Treat the Main Pan and worker chat composers as ordinary multiline freeform
  text fields. Give their scoped forms and textareas stable chat-specific
  names, IDs, accessible labels, `autocomplete="off"`, and text input-mode,
  capitalization, correction, and spellcheck semantics. Avoid payment,
  identity, contact, and one-time-code terminology in composer metadata and
  placeholders, and add scoped password-manager ignore metadata where
  supported. Do not disable autofill on unrelated task forms or inputs.
- Preserve authored line breaks when rendering conversation Markdown. Present
  streamed internal reasoning as subdued "Thinking" content that is visually
  distinct from the agent's response. Allow images pasted from the clipboard
  to be previewed, removed, and submitted as native ACP image content only when
  the connected agent advertises image prompt support; enforce bounded payload
  limits and surface unsupported media or capability failures.
- Open, select, and reload Main Pan and worker conversations at their newest
  content on phone and desktop. Returning to a conversation also defaults to
  the newest content; Hub does not persist incidental scroll offsets. Continue
  following incoming and streaming content only while the reader is at or near
  the bottom. Deliberately scrolling into history disables that follow behavior
  until the reader returns near the bottom or reopens the conversation.
- Keep the newest message and composer visible through delayed Markdown or
  media layout, viewport changes, phone safe areas, and software-keyboard
  resizing. Height changes must not leave a following conversation short of
  the actual bottom or disturb a reader who is browsing earlier messages.
- Keep unanswered questions visibly attached to their task and workstream.
  Dismissing a question does not answer or approve it.

Operational attention is separate from task work status. A pending question
does not change priority, work status, planned date, or task ownership.

Retain all recorded conversation messages and tool activity through Hub reload
and restart; do not silently cap saved history. Refresh live state on browser
reconnect, return from the background, and network recovery, without allowing
an older snapshot to overwrite newer streamed content. Display failures inline
in the conversation and show current process/turn state for main Pan as well
as workers. Tool activity includes readable input, output, title, and status.

Task and workstream mutations use one ordered optimistic queue. Apply each
change to the visible portfolio immediately, preserve undo and redo history,
and flush writes to their authoritative backend or store in order. Refresh
waits for queued writes before reading live state and replays changes made
while that read is in flight. A failed write remains visible with later intent
queued for explicit retry; do not silently roll it back or report it as saved.
The user may instead explicitly discard the blocked unsynced projection and
return to the last confirmed state.
The manual refresh control is also the queue activity indicator and spins
during both refresh reads and write flushes.

## Headless sessions

Hub acts as an ACP client to local `copilot --acp --stdio` subprocesses. Neither
ACP nor backend credentials are exposed to browser clients. Negotiate the
installed agent's capabilities rather than assuming draft protocol features.

There is one persistent main Pan conversation and one persistent conversation
per task. Active sessions use separate subprocesses. Session IDs come from the
agent's session creation response and are saved before subsequent reuse.
Supported resume/load operations reconnect the conversation; never silently
replace a failed resume with a new conversation.

When a saved session cannot be loaded, retain its identity and transcript,
surface the failure, and clear the failed worker's process request instead of
retrying indefinitely in background dispatch. An explicit Resume retries that
same identity. Missing underlying agent state requires an operator recovery
decision; the rendered transcript is not a substitute ACP conversation.

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
ordinary prose to guess at pending questions or approvals. The bridge publishes
the pending question and ends its tool call; Hub delivers the eventual answer
in a later agent turn.

Prefer that bridge over timeout-bound native elicitation for human questions.
Persist unanswered questions and submitted answers independently of process
memory. There is no human response deadline. Accept the browser submission
after saving it, without holding its HTTP request open until the agent finishes
the delivery turn. Identify answers by question ID, reject stale submissions,
and retain failed deliveries with an explicit retry. If restart interrupts
delivery confirmation, report that uncertainty rather than silently dropping
the answer or claiming it was received. Reconnecting a waiting worker does not
send a bootstrap prompt that repeats its question.
If a preceding turn asks a question, an already-queued ordinary follow-up must
not bypass it. Keep that message visible, report that it was not delivered,
and ask the user to answer before resending it.

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

Task creation opened from a workstream card preselects that exact workstream
path and its optional `default-playbook` metadata. General task creation leaves
the workstream unselected rather than silently choosing the first catalog
entry. Backend project destination and workstream are distinct: when one
non-Inbox project name exactly matches the selected workstream title, Hub may
preselect it, but the destination remains explicit and editable before
creation. Ambiguous or unmatched destinations require user selection.

Main Pan also receives the normal local operational tool surface and explicit
Hub session inspection, stop, and message operations. It may diagnose logs,
processes, builds, and saved conversations and perform bounded Hub recovery.
This operational authority does not make main Pan the implementer of a worker's
assigned task.

The main session does not implement development tasks itself. It records the
outcome, task guidance, workstream, and selected playbook, then requests a
worker with `agentStatus=requested`. It does not invent a session ID.

Existing references to a worker terminal mean that worker's Hub chat. Main
Pan lists tasks needing attention and directs the user to those conversations;
it does not collect answers on behalf of another session.

Before the first worker session, task chat shows an explicit launch action
instead of message input. A stopped task with a saved session shows its
conversation history and an explicit resume action instead of message input.
Message input is available while the worker process is active, and sending
during an active turn queues the follow-up behind that turn. A structured
question remains a distinct interaction and keeps ordinary message submission
disabled until answered.

Resume only reconnects the saved conversation. In particular, resuming a Done
or rejected task without a new operator message must leave the worker running
and ready for discussion; the worker must not replay its prior
completion updates or recreate `worker-release.json`. The explicit resume
action itself is not completion of a new request.

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

An optional positive `concurrency` value in a playbook limits that playbook's
simultaneously managed workers on the Hub host. Hub restores previously running
managed sessions first after restart and counts them against the limit. It then
launches requested tasks in stable backend precedence order until capacity is
full. Deferred tasks remain requested without changing work status, dates,
saved session IDs, or any other task field.

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

A resumed Done or rejected task remains active while waiting for the operator's
first new message. The fact that its saved conversation and work status record
an earlier completion is not a fresh release request.

## Local deployment

The machine's Hub deployment path serializes canonical builds, browser
acceptance, and service deployment with one host-wide lock shared by every
worktree. A deployment of the integration branch must:

1. refuse an overlapping operation and a dirty, detached, wrong-branch, or
   diverged canonical checkout;
2. fetch the configured remote branch, build its exact commit in an isolated
   staging checkout, and record that commit as the browser and server build
   identity before changing the canonical checkout;
3. fast-forward the canonical checkout only, stop the configured service for
   artifact promotion, atomically replace the built browser and server
   directories, and restart that exact service;
4. verify health and served asset identity through loopback and the configured
   Tailscale origin; and
5. restore and restart the prior built artifacts when promotion, restart, or
   verification fails, while surfacing the failure.

Deployment never changes task work status or treats restart as worker
completion. Installed clients regularly check for a waiting service-worker
version. They present an update-ready action rather than forcing a reload that
could destroy unsent composer text or interrupt active interaction.

This deployment gate applies when a task delivers a new commit to the
configured Pan Hub integration branch. A task that does not change that branch
must still merge, update, and verify every canonical checkout or production
surface it did change, but must not restart Hub merely as a generic completion
ritual. The worker remains live, and therefore retains its playbook concurrency
slot, through every applicable merge, deployment, and production verification
gate.

When a process actually exits, clear its agent status while retaining its
session ID and work status. An ordinary ACP end-of-turn is not a process exit
or release request. Waiting for input does not release the worker.

Stopping or restarting Hub must not present interrupted interactions as
successful. A graceful service restart preserves running worker intent and
restores those saved conversations before consuming new capacity; it does not
clear Agent status or change work status. Connection-bound questions must be
reissued if their original connection is lost. A browser disconnect does not
stop workers.

## Debugging and tests

Write a local debugging log with timestamps and enough session/task context to
follow launches, requests, connection failures, and process exits. Do not log
credentials. Expose the log location in operational documentation.

Automated coverage should focus on core backend and session behavior, scope
checks, question responses, and persistence. Do not create a brittle visual
regression suite while the product is iterating. Relevant Hub UI, browser API,
task mutation, and workstream-loading changes must additionally pass the
rendered browser acceptance suite before being reported complete.

The acceptance environment is a second, explicitly marked local Hub instance.
It must use a configurable non-production port and a dedicated root containing
all generated configuration, Domain fixtures, task data, Hub state, logs,
process identity, and browser profile. Its deterministic local task backend
must preserve the same create, read, update, status, comment, project,
workstream, and date contracts used by Hub. Resettable fixtures cover writable
and non-writable workstreams, recurring and non-recurring dates, comments,
session states, and rejected writes.

Acceptance startup must fail closed rather than inherit normal configuration:
reject the production port, remote Domains, trusted origins, wildcard scope,
production task backends, or any configuration, credential-bearing home,
state, session, Domain, fixture, or agent path outside the acceptance root.
Use a deliberately failing fake agent executable; browser portfolio acceptance
does not launch a real agent. Stop only the process whose live acceptance
identity matches the generated process record.

Browser automation drives the built application through user-visible controls
and verifies authoritative fixture persistence after reload. At minimum it
covers task selection, moving a task between writable workstreams and back,
Today and Not Today actions, menu appearance and dismissal, task editing, and
visible mutation errors. A failed run must preserve actionable diagnostics,
including a screenshot and trace, and must never fall back to mocked handlers
or a production service.

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
