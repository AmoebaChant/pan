# PAN helpers, triage, and attention

PAN helpers are stateless commands for a configured private domain. They create
fresh evidence and return versioned JSON-friendly results rather than relying
on a host process. Every helper requires:

```text
--schema-version 1 --config <domain-config.json>
```

`PAN_CONFIG` may provide the configuration path. `--json` prints the complete
result. A result has a status of `confirmed`, `rejected`, `incomplete`, or
`failed`, confirmed effects, diagnostics, recovery steps, and operation
receipts where applicable. A non-confirmed result is not permission to assume a
side effect occurred.

## Evidence

```powershell
pan evidence issues --schema-version 1 --config C:\domains\domain\pan.json --json
pan evidence portfolio --schema-version 1 --config C:\domains\domain\pan.json --json
```

`issues` reads the complete configured-repository Issue catalog and reports
whether comments and relationships are complete. `portfolio` reads Project,
Issue, workstream, and runner evidence and returns a snapshot ID plus expected
state. Read again after incomplete evidence; only a complete,
mutation-usable snapshot authorizes an action proposal.

## Leadership

```powershell
pan leadership status --schema-version 1 --config C:\domains\domain\pan.json --json
pan leadership assert --schema-version 1 --config C:\domains\domain\pan.json --json
```

`status` is read-only. `acquire`, `assert`, `renew`, and `release` require the
active session's `PAN_SESSION_ID`, `PAN_LEADERSHIP_HOLDER`, and
`PAN_LEADERSHIP_GENERATION` environment values. They return rejected results
when authority cannot be confirmed. Continue read-only or start a new session
after lease expiry; never invent or reuse a lost generation.

## Reconciliation

```powershell
pan reconcile missing-issues --schema-version 1 --config C:\domains\domain\pan.json --json
pan reconcile missing-issues --apply --schema-version 1 --config C:\domains\domain\pan.json --json
pan reconcile merged-prs --apply --schema-version 1 --config C:\domains\domain\pan.json --json
```

Both operations are dry-run without `--apply`. Apply requires confirmed
leadership. Missing-Issue reconciliation adds absent open Issues to the Project.
Merged-PR reconciliation verifies eligible merged pull-request delivery and
returns per-item receipts. Refresh evidence and retry only the unconfirmed
effects when a result is incomplete.

## Actions

```powershell
pan action validate --action-file C:\work\actions.json --schema-version 1 --config C:\domains\domain\pan.json --json
pan action apply --action-file C:\work\actions.json --schema-version 1 --config C:\domains\domain\pan.json --json
```

The action file is JSON and is limited to 1 MiB. Validation checks schema,
policy, citations, and fresh expected state without applying a mutation.
Apply additionally requires current leadership. Every mutation needs an
idempotency key and the matching expected-state snapshot; stale, unknown, or
policy-prohibited actions are rejected. Use the receipt and recovery guidance,
refresh evidence, and submit only the affected action again.

## Attention

```powershell
pan attention list --schema-version 1 --config C:\domains\domain\pan.json --json
pan attention answer 42 "Use the existing API." --schema-version 1 --config C:\domains\domain\pan.json
pan attention add "Implement feature" --workstream product/api --repo example/tool --owner agent --schema-version 1 --config C:\domains\domain\pan.json
```

`list` reads unresolved human attention and in-review items. `answer` requires
leadership and records a durable answer for an actionable item, restoring
blocked agent work when appropriate. `add` requires leadership and creates an
untriaged Issue. It accepts `--body` or `--body-file`, `--workstream`,
`--owner`, `--priority`, `--autonomy`, and repeatable `--repo` and
`--requirement`; do not combine `--body` and `--body-file`.

Use the `attention` family directly; `inbox`, `answer`, and `add` are not PAN
commands.

## Workstream delivery

```powershell
pan workstream prepare product/api --rationale "Record agreed API decision" --source-turn turn-12 --schema-version 1 --config C:\domains\domain\pan.json --json
pan workstream publish operation-id --schema-version 1 --config C:\domains\domain\pan.json --json
```

Both commands require the active session ID and confirmed leadership.
`prepare` creates an isolated workspace and receipt for one workstream
README. Make the intended change there, then `publish` uses the operation ID to
commit, push, and verify it directly on the domain default branch. It returns
commit, push, cleanup, or recovery information. This is direct PAN workstream
delivery, not runner direct-delivery policy and not a pull request.

## Session and migration

Use `pan session --config <path>` for interactive PAN work. `pan start`,
`stop`, `host`, `connect`, `daemon`, `chat`, and `review` are retired because
PAN has no host, endpoint, token, MCP bridge, or detached scheduler. Exit and
restart the foreground session after domain/session/scheduling changes. See
[domain configuration](domain-configuration.md) and [runner](runner.md).
