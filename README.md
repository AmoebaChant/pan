# PAN

PAN is a hostless personal-agent toolkit for one private GitHub-backed domain of
work. GitHub Issues, Project fields, Project order, and workstream markdown are
the durable record; PAN does not run a localhost host, MCP bridge, daemon, or
detached scheduler.

The published package contains reusable code, schemas, and Copilot assets only.
Domain repositories hold workstreams, runner profiles, machine paths, leases,
credentials, and all other private data.

## Install and set up

PAN requires Node.js 22+, an authenticated `gh` CLI with Project access, and
Copilot CLI for interactive PAN sessions and runners.

```powershell
npm install --global @amoebachant/pan
pan assets install
pan setup
```

`pan setup` creates a private domain repository and GitHub Project, writes a
version-2 domain configuration, and creates an offline runner profile. Supply
`--repository`, `--path`, `--project-owner`, `--project-title`, and
`--approval-mode prompt|allow-all` to automate the wizard. `allow-all` is an
explicit machine-local approval choice; `prompt` is the default.

Use `pan assets status` to inspect the current user's installed agent,
instructions, and skills. Use `pan assets repair` after an upgrade or to repair
missing or changed assets; `--force` replaces changed destinations.

## Start PAN

```powershell
pan session --config C:\domains\personal-domain\pan.json
```

The foreground session validates the domain and installed assets, attempts to
acquire the domain leadership lease, then starts an ordinary interactive
Copilot session with the PAN agent. A leader is a **writing** session; a
concurrent session is **read-only** and cannot mutate the domain or schedule
reviews. Exit the Copilot session to release leadership and stop PAN. Start a
new session to resume; nothing continues after exit.

Set `PAN_CONFIG` instead of repeatedly passing `--config`. Sessions use the
configured model and optional product-context roots. Configuration, session, or
scheduling changes take effect only after exiting and starting a new session.
Restart `pan-runner` only when its runner profile changes.

`pan start`, `stop`, `host`, `connect`, `daemon`, `chat`, and `review` are
retired. Their replacement is the foreground `pan session` command.

## Scheduling

Writing sessions may ask Copilot to create one session-scoped native recurring
schedule. Scheduling has no catch-up runs and relies on Copilot's session queue
to avoid overlap. `startup` is `immediate`, `after-interval`, or `manual`;
review intervals are capped at one hour per native schedule trigger. Failed or
incomplete reviews stay visible in the session and use the configured bounded
retry guidance. If native scheduling is unavailable, start a read-only session
or create the displayed `/every` command manually in the interactive session.

See [domain configuration](docs/domain-configuration.md) for the version-2
schema and migration guidance.

## Stateless helper commands

PAN's agent uses one-shot helper processes against fresh GitHub and workstream
evidence. Every helper requires `--schema-version 1`, a domain configuration,
and normally returns a versioned result with `confirmed`, `rejected`,
`incomplete`, or `failed` status. Mutating helpers require the active session's
leadership environment and fail safely when it cannot be confirmed.

```powershell
pan evidence portfolio --schema-version 1 --config C:\domains\personal-domain\pan.json --json
pan reconcile missing-issues --apply --schema-version 1 --config C:\domains\personal-domain\pan.json
pan attention list --schema-version 1 --config C:\domains\personal-domain\pan.json
```

The helper families are documented in
[triage and attention](docs/triage-and-attention.md). Use
[the action schema](schema/pan-action.json) for proposed mutations and require
fresh expected-state evidence before applying them.

## Runner

`pan-runner` is independent of PAN-session leadership. It reads a private
machine profile, claims compatible `owner=agent`, `ready` work in canonical
Project order, and launches an isolated worktree session.

```powershell
pan-runner --profile C:\domains\personal-domain\runners\machine-a.json --validate-profile
pan-runner --profile C:\domains\personal-domain\runners\machine-a.json --once
```

Runner playbooks default to pull-request delivery. A playbook may use direct
delivery only when explicitly authorized; direct delivery validates that the
reported commit reached the configured default branch, then closes the Issue.
Pull-request delivery leaves work in review until a later reconciliation records
the merged pull request. See [runner](docs/runner.md).

## Node module

The package exports the GitHub store, hostless session, helper-command,
configuration, action, reconciliation, workstream-delivery, runner, and schema
support APIs from `@amoebachant/pan`. See
[the schema module contract](docs/schema-module.md) and
[the store contract](docs/store-schema.md).

```powershell
npm test
```
