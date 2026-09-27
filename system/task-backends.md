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
pan-task --config <backend.json> migrate-workstreams
pan-task --config <backend.json> migrate-workstreams --input '{"apply":true}'
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

A successful create has persisted and read back the requested initial work
status and planning fields from the configured Issue and Project item. Failure
after either record exists is reported as a partial write with their known
identities rather than as a successful task.

Closing `done` uses GitHub's completed reason. Closing `rejected` uses not
planned. A pre-existing duplicate close reason is read as rejected and is
preserved unless the caller explicitly changes work status.

## Todoist

Todoist native content, description, priority, due date, deadline, comments,
completion, and reopening remain native. One visible `pan-task:v2` block at the
end of the description stores only fields Todoist does not natively provide:
next step, playbook, session ID, Agent status, and the rejected close meaning.
Workstream is represented by native Todoist project membership, not this
block. It is not a workflow or worker-state store.

The adapter fully paginates active tasks. Completed tasks use Todoist's required
completion-date bounds and cursor pagination within one rolling three-month
window, so a recently Done task can still request or resume its saved session.
Older completed tasks remain in Todoist but are outside Pan's normal Todoist
listing and lookup. Native assignee and project scope remain backend
configuration, not Pan ownership.

For source intake, Todoist create supports an optional UUID `idempotencyKey`
sent as `X-Request-Id`.

An optional `projectWorkstreams` object in the selected Todoist backend
configuration explicitly maps native project IDs to Pan workstream paths.
Each workstream may map to only one project. Reads derive `workstream` solely
from that map. Inbox and unmapped projects read as unassigned; project names,
similar text, catalog titles, and legacy description metadata are never
inferred.

Creation with a non-empty workstream resolves its mapped project and rejects a
conflicting explicit project. Updating `workstream` moves the task to its
uniquely mapped native project and rejects empty or unmapped values. Direct
project moves remain distinct and derive their resulting workstream on re-read.
No create or update serializes workstream into `pan-task:v2`.

Domains remove old description-level workstreams once with
`migrate-workstreams`. The command previews by default, reporting exact aligned
cleanup, native project move, and conflict counts. `{"apply":true}` moves only
legacy values with a unique configured destination, removes their obsolete
metadata through Todoist's sync API, and re-reads every candidate to verify the
destination and protected fields without reopening completed tasks. Unmapped
legacy values remain unchanged as explicit conflicts for review. A repeated
run performs no actionable writes. Ordinary reads never run the migration.
