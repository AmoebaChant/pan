# Daily Briefing review UI

The optional **Daily Briefing review UI** is a local presentation surface for
the interactive planning loop in [Daily Briefing](daily-briefing.md). It does
not replace that contract, hold authoritative task state, or make planning
decisions. The Pan session still performs every live read, recommendation,
revision, approved write, and verification.

Pan also ships a dedicated **everyday task UI** from the same public-safe design
language. It is a separate GitHub-backed loopback service, not a briefing
proposal and not an orchestrator.

## Everyday task UI

Start fixture mode first:

```sh
node bin/pan-tasks.js --demo
```

Live mode requires both bindings explicitly:

```sh
node bin/pan-tasks.js \
  --config /absolute/path/to/machine.json \
  --checkout /absolute/path/to/this/pan/checkout
```

It never discovers a global agent, skill, Domain, or checkout implicitly.

The primary views are Today, Needs me, In motion, Recent activity, and All
tasks, derived exactly as [task lifecycle](task-lifecycle.md#everyday-derived-views)
defines. A task appears in at most one primary view; All tasks intentionally
contains the complete set. Recent activity is quiet informational history, not
a clearable inbox.

The UI supports fast capture and checked edits for title/details, priority,
workstream, attention schedule, deadline, exact current action, authorization,
dependencies, hold, explicit human↔AI handoff, finish/reject, and recurrence
basics. Details show the current-next-action block, history, artifacts, worker
liveness, and session/workspace affinity. Discuss/open presents the honest
worker terminal/machine instruction; it does not pretend browser chat is a
worker conversation. Finish/reject is refused while machine/session/generation
affinity remains, even for a stopped or checkpointed task; terminal completion
must resume the generation or use checked runner/operator cleanup so local
result and checkpoint evidence is not pruned or orphaned.

Daily commitment still requires the existing explicit briefing approval flow.
An everyday edit may schedule a specific date only when the user directly asks
for that edit; it never silently turns Needs me into Today.

## Interaction model

The UI uses complete proposal and review snapshots rather than one agent turn
per task:

1. Pan establishes the complete live picture and prepares its first read-only
   recommendation.
2. Pan publishes one complete proposal through the briefing MCP service,
   immediately gives the user the clickable review URL, then waits for review
   of that exact revision. Do not begin a blocking wait without first showing
   the link.
3. The user moves through the proposal without waiting for Pan, accepting
   recommendations or marking task-level and overall steering.
4. The browser submits the complete marked-up review once. Pan reasons over the
   review as a whole and either publishes a new complete revision or, after an
   explicit approval, applies the agreed plan.
5. Pan re-reads and verifies the authoritative systems before reporting the
   briefing complete, exactly as the Daily Briefing contract requires.

The review remains active if the user asks a side question in chat. Answer the
question, then immediately resume `await_briefing_review` for the same current
revision unless the user explicitly pauses, cancels, or redirects the
briefing. Publishing a revision without resuming its wait is an incomplete
interaction.

Sending feedback is not approval. The browser's **Approve proposal** action is
the explicit agreement required before Pan makes discretionary planning-date
writes. If the user has unsent markup, the UI requires that feedback to be sent
and incorporated into a new proposal before approval.

The review surface is intentionally dense. Each task is one compact row with
**Agree** and **Disagree** choices. Agree is selected initially. Disagree opens
a free-text steering field; the user is not required to translate natural
planning guidance such as "next week" or "on a quiet day" into a date. A
minimal sticky header keeps the revision, Pan's waiting/thinking state, and the
single submit action visible while scrolling.

Every proposal groups rows into **Today** and **Not today** so the daily
commitment is visible without interpreting recommendation pills. The proposal
is a focused review surface, not a rendering of the complete human queue:

- **Today** shows every task Pan recommends doing today.
- **Not today** shows every overdue or currently-today task that Pan recommends
  moving to a future date or clearing.
- Future-dated or undated tasks not selected for Today are omitted. Pan still
  considered them during the complete live read, and their planning dates
  remain unchanged.

Pan supplies a required `group` value of `today` or `not-today` for each
displayed task. Recommendation text explains why the task belongs in its group.
Pan must make this classification before publishing the first proposal;
Agree/Disagree asks whether the user agrees with that recommendation and never
substitutes for it. Never populate Not today with future or undated backlog, but
never omit overdue work from the recommendation.

A revised row may include `feedbackResponse`, shown explicitly as Pan's response
to the prior review. It must describe what Pan changed or retained and must not
use ambiguous text such as "accepted" for a task the user disagreed with.

Task-level feedback is transient in the browser and MCP service. After approval,
Pan writes durable situational guidance into the authoritative task itself
using the `Pan planning guidance:` description/body marker defined by the Daily
Briefing contract, then verifies that write. The UI may display that value in a
later proposal, but it is never its system of record.

## Service boundary

`bin/pan-briefing-mcp.js` is a dependency-free local MCP server and web service.
It exposes three tools:

- `publish_briefing` replaces the current renderable proposal with a complete
  revision.
- `await_briefing_review` waits until the browser submits one review matching
  that briefing id and revision.
- `complete_briefing` replaces the proposal view with Pan's verified final
  outcome.

The completion view presents that outcome for a person rather than displaying
the raw MCP result object. It leads with the confirmed summary and renders
available structured sections such as today's tasks, durable guidance updates,
and linked agent-attention items. Internal identifiers and transport fields
such as `briefingId`, `revision`, and `status` are not the primary completion
content.

The same process serves the responsive browser UI and a small same-origin HTTP
API. Browser updates use Server-Sent Events; browser submissions use ordinary
HTTP POST requests. The service keeps only the current proposal, one pending
review, one pending MCP wait, and connected browser streams in memory. It has
no database. Browser-local draft markup may be kept in local storage so a page
refresh does not discard unfinished feedback.

GitHub and workstream Markdown remain authoritative. The service must never
infer task meaning, apply task writes, or expose credentials to browser code.

## Local use

### UI demo mode

For UI iteration without Copilot, GitHub, Todoist, or any other live source,
start the service with realistic fixtures:

```sh
node bin/pan-briefing-mcp.js --demo
```

Open `http://127.0.0.1:4319/`. The demo accepts complete browser reviews,
publishes a simulated revised proposal after **Send feedback**, and displays a
simulated completion after **Approve proposal**. It never starts the MCP
protocol and cannot read or write real task data. Restart the command to reset
the demo.

The demo defaults to port `4319` so it can run alongside the MCP-backed UI on
port `4318`. Use `--port` to override it.

### MCP-backed use

Create a checkout-local `.mcp.json` in the Pan repository:

```json
{
  "mcpServers": {
    "pan-briefing": {
      "type": "stdio",
      "command": "node",
      "args": ["bin/pan-briefing-mcp.js"],
      "tools": ["*"],
      "timeout": 43200000
    }
  }
}
```

When a Copilot session loads that MCP server, it serves the review UI at
`http://127.0.0.1:4318/`. Only one process may use the default port at a time.
The host and port may be changed with `--host` and `--port`.
The long MCP timeout permits an `await_briefing_review` call to remain pending
while the user reviews the proposal.

Keep this configuration checkout-local rather than adding the server to the
user-wide MCP configuration: a user-wide stdio server would start the fixed
local web listener in every Copilot session, including sessions unrelated to
Pan.

The initial implementation intentionally binds to loopback and provides no
remote authentication. Do not expose it to another network interface without
adding an authenticated transport such as a private Tailscale route.

If the MCP process restarts, its in-memory proposal and pending review are
lost. Pan republishes the current complete proposal and waits again; the
browser restores matching unsent markup from local storage. No authoritative
task state is lost.

## Everyday service boundary

`bin/pan-task-service.js` and `bin/pan-tasks.js` serve browser assets and a
same-origin JSON API. The service:

- invokes authenticated `gh` only in the Node process;
- sends no credentials or arbitrary command capability to browser code;
- binds loopback only;
- requires an allowed `Origin` and exact Host authority for every write and
  rejects DNS-rebinding-shaped hosts;
- filters and writes only the configured Domain repository plus explicit
  backlog repositories from config;
- limits request and rendered content sizes;
- re-reads the live Issue/Project item and requires `task-revision` before each
  write;
- requires explicit generation/resource operations before disturbing a worker;
  and
- returns real stale/conflict/error responses, never fixture or success-shaped
  fallback data.

The fixture service uses only public invented data. The live service never
writes during startup or read requests. Browser local storage may hold
presentation preferences, not authoritative task state or credentials.
