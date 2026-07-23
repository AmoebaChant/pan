# PAN domain configuration

A version-2 domain configuration connects a foreground PAN session to one
private GitHub repository and Project. It contains domain identity, session
settings, and optional scheduling. Runner paths, capability,
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
  }
}
```

`domain.path` is an absolute local clone path. `session.agent.name` is required; its
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
CLI lacks required scheduling support, create the
displayed `/every` command manually. Changes to domain, session, or scheduling
settings require exiting and rerunning `pan session`; no background PAN process
exists to restart.

## Setup and migration

The recommended entrypoint is the conversational setup agent:

```powershell
git clone https://github.com/AmoebaChant/pan.git
Set-Location .\pan
npx --yes --package . pan onboard
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
the document before starting a session. Move `agent` under `session.agent` and
replace the review cadence with `scheduling`. Version-1 settings that describe
a host, transcript runtime, poll loop, leadership lease, or daemon are not used
by the foreground session.

When moving from a runner profile, copy only `store.repository`,
`store.projectOwner`, `store.projectNumber`, and `store.path` to `domain`.
Keep the runner's machine identity, clone map, worktree root, terminal,
capacity, capabilities, approval mode, and `domainConfigPath` in its runner
profile. Never put authentication tokens or machine-private values in a public
package schema or asset.

## Recovery

If asset verification fails, run `pan assets repair`. Issue and Project
operations use live GitHub reads, so retry only after inspecting the target's
current state. Runner lease recovery remains local to `pan-runner`.
