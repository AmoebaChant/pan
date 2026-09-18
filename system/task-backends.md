# Task backends

Each Domain selects one authoritative task backend. GitHub and Todoist expose
the same small task record through `pan-task`:

```sh
pan-task --config <backend.json> list
pan-task --config <backend.json> get <id>
pan-task --config <backend.json> create --input @request.json
pan-task --config <backend.json> update <id> --input @request.json
pan-task --config <backend.json> comment <id> --input @request.json
pan-task --config <backend.json> comments <id>
pan-task --config <backend.json> complete <id> --input '{"outcome":"done"}'
pan-task --config <backend.json> reopen <id>
```

The common task record contains:

- backend and native task identifiers;
- title, description, URL, comments, and native open/closed reason;
- work `status`: `open`, `done`, or `rejected`;
- priority, planned date (`nextActionDate`), optional brief `nextStep`,
  deadline, playbook, and workstream;
- persistent `sessionId`; and
- `agentStatus`: empty, `requested`, or `running`.

Work status and Agent status are independent. Completing or reopening a task
does not request, stop, release, or detach a session. Requesting a session is
an ordinary update to `agentStatus=requested`, valid for every task.

Adapters validate basic types, configured scope, backend identifiers, and
authentication. They return explicit API and partial-write errors. They do not
decide whether work is ready, infer an owner, validate business transitions,
route next-action pairs, or interpret comments as state changes.

`nextStep` is plain descriptive text for a current milestone or concrete next
action. Empty or missing values read as an empty string. It never affects
dispatch, permissions, work status, Agent status, or completion.

## GitHub

The GitHub adapter talks directly to the configured repository and Project. It
does not use a second task store or lifecycle policy layer. Issue title/body,
comments, state, and state reason remain native. Project fields store the
portable planning and session fields described in
[Project schema](project-schema.md).

Closing `done` uses GitHub's completed reason. Closing `rejected` uses not
planned. A pre-existing duplicate close reason is read as rejected and is
preserved unless the caller explicitly changes work status.

## Todoist

Todoist native content, description, priority, due date, deadline, comments,
completion, and reopening remain native. One visible `pan-task:v2` block at the
end of the description stores only fields Todoist does not natively provide:
next step, playbook, workstream, session ID, Agent status, and the rejected
close meaning. It is not a workflow or worker-state store.

The adapter fully paginates active tasks. Completed tasks use Todoist's required
completion-date bounds and cursor pagination within one rolling three-month
window, so a recently Done task can still request or resume its saved session.
Older completed tasks remain in Todoist but are outside Pan's normal Todoist
listing and lookup. Native assignee and project scope remain backend
configuration, not Pan ownership.

For source intake, Todoist create supports an optional UUID `idempotencyKey`
sent as `X-Request-Id`.
