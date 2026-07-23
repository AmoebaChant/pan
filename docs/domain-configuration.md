# PAN domain configuration

A version-2 domain configuration connects a foreground PAN session to one
private GitHub repository and Project. It contains domain identity, session
settings, scheduling, leadership, and action policy. Runner paths, capability,
capacity, terminal, and approval settings belong only in the private runner
profile.

## Version 2

```json
{
  "version": 2,
  "domain": {
    "repository": "example/personal-domain",
    "projectOwner": "example",
    "projectNumber": 12,
    "path": "C:\\domains\\personal-domain"
  },
  "state": { "branch": "pan-state", "path": ".pan" },
  "session": {
    "agent": { "name": "pan", "model": "gpt-5.6-sol" },
    "productContextRoots": [
      { "label": "product", "path": "C:\\repos\\product" }
    ]
  },
  "scheduling": {
    "enabled": true,
    "reviewIntervalSeconds": 3600,
    "startup": "immediate",
    "retrySeconds": 60,
    "rateLimitRetrySeconds": 900
  },
  "leadership": { "leaseSeconds": 120, "heartbeatSeconds": 30 },
  "policy": {
    "automatic": ["field-update"],
    "approvalRequired": ["issue-create"],
    "prohibited": []
  }
}
```

`domain.path` is an absolute local clone path. `state.path` is confined to the
repository and cannot escape it. `session.agent.name` is required; its
`executable` defaults to `copilot`, and `model` defaults to Copilot's `auto`
selection when omitted. Product-context roots are optional local directories
added to the Copilot session.

The `schema/domain-config.json` contract accepts version 1 only for migration.
New configurations must use version 2.

## Scheduling and restart behavior

Scheduling defaults to enabled, a 24-hour review interval, immediate startup,
a 60-second ordinary retry, and a 900-second rate-limit retry. The interval is
bounded to 300–604800 seconds in configuration; a native session schedule uses
at most one-hour triggers to perform due checks. PAN neither catches up a missed
session nor starts an external timer, and the Copilot session queue supplies
non-overlap.

`startup: "immediate"` performs a fresh startup review; `after-interval` waits
for the first due trigger; `manual` performs no startup review. If the Copilot
CLI lacks required scheduling support, use a read-only session or create the
displayed `/every` command manually. Changes to domain, session, or scheduling
settings require exiting and rerunning `pan session`; no background PAN process
exists to restart.

## Setup and migration

The recommended entrypoint is the conversational setup agent:

```powershell
npx @amoebachant/pan onboard
```

It installs PAN's user-scoped Copilot assets, gathers the setup choices, invokes
the deterministic commands below, verifies the result, and can create Windows
desktop shortcuts.

`pan setup` writes a version-2 configuration and an offline runner profile. To
create a new private repository and Project non-interactively:

```powershell
pan setup --repository example/personal-domain `
  --repository-mode create `
  --path C:\domains\personal-domain `
  --project-owner example `
  --project-mode create `
  --project-title "Personal PAN" `
  --approval-mode prompt `
  --install-assets
```

Fresh setup keeps scheduled reviews disabled so it works with Copilot CLI
versions that do not yet expose native recurring schedules. Enable scheduling
later only after `pan verify` succeeds with a scheduling-capable CLI.

To connect an existing private repository and compatible Project, use
`--repository-mode connect`, `--project-mode connect`, and
`--project-number <number>`. `--path` may identify an existing local domain
checkout or a missing path where PAN should clone the repository. PAN preserves
compatible configuration, runner settings, workstreams, and README content,
creates missing setup data and Project fields, and rejects incompatible or
locally modified setup files rather than replacing them. The same command may
be rerun to resume or confirm a partially completed setup.

Verify the installed assets, domain identity, Project schema, Copilot contract,
and runner profile together:

```powershell
pan verify --config C:\domains\personal-domain\pan.json `
  --profile C:\domains\personal-domain\runners\machine.json
```

On Windows, create self-contained shortcuts that use PAN's packaged icon:

```powershell
pan shortcuts create `
  --config C:\domains\personal-domain\pan.json `
  --profile C:\domains\personal-domain\runners\machine.json `
  --selection both
```

For a version-1 configuration, use the exported migration helper or rewrite
the document before starting a session. Move `agent` under `session.agent`;
replace legacy cadences with `scheduling` and `leadership`; retain `domain`,
`state`, `reviewPolicy`, `selfRepair`, and `attention`; and add an explicit
`policy` when the domain needs mutation classifications. Version-1 settings
that describe a host, transcript runtime, poll loop, or daemon do not create a
hostless background service.

When moving from a runner profile, copy only `store.repository`,
`store.projectOwner`, `store.projectNumber`, and `store.path` to `domain`.
Keep the runner's machine identity, clone map, worktree root, terminal,
capacity, capabilities, approval mode, and `domainConfigPath` in its runner
profile. Never put authentication tokens or machine-private values in a public
package schema or asset.

## Policy and recovery

`policy.automatic`, `approvalRequired`, and `prohibited` classify supported
action kinds. Mutations also require current leadership and fresh expected
state; configuration alone never grants authority. `attention.assignee` routes
genuine blocking questions. Optional self-repair creates a deduplicated
pull-request-delivery task after an unexpected review failure; it does not
retry itself or merge a pull request automatically.

If asset verification fails, run `pan assets repair`. If another session holds
leadership, use the read-only session or wait for lease expiry. If leadership
is lost, PAN stops the child session; start a new foreground session rather
than attempting to reuse its authority.
