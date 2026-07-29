# Pan domain configuration

A version-2 domain configuration connects a foreground Pan session to one
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
    "rateLimitRetrySeconds": 900,
    "triageAuthority": "report"
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
a 60-second ordinary retry, a 900-second rate-limit retry, and `report` triage
authority. The interval is
bounded to 300–604800 seconds in configuration; a native session schedule uses
at most one-hour triggers to perform due checks. Pan neither catches up a missed
session nor starts an external timer, and the Copilot session queue supplies
non-overlap.

`startup: "immediate"` performs a fresh startup review; `after-interval` waits
for the first due trigger; `manual` performs no startup review. Changes to
domain, session, or scheduling
settings require exiting and rerunning `pan session`; no background Pan process
exists to restart.

`triageAuthority` is the standing mutation policy for scheduled reviews.
`report` keeps them read-only, so every change waits for approval in the
session. `triage-fields` lets a scheduled review fully triage untriaged items —
those with no `Status` — without asking. Triage means every field that makes an
item actionable: `owner`, `Status`, `priority`, `workstream`, and the
`requirements` that select a playbook. Setting the first four while omitting
`requirements` produces an item that reads `ready` but that no runner can ever
claim, so `requirements` is part of triage rather than a separately approved
field. Already-triaged items still require approval under either value.

A scheduled review counts as due when `nextReviewAt` is in the past or within
the next 60 seconds. The recurring tick fires on a fixed cadence while
`nextReviewAt` is anchored to the end of the previous review, so the two drift
apart by however long a review takes. Without that tolerance a review that ran
even a fraction of a second long would push the next one past the following
tick, halving the effective review rate.

Pan verifies the Copilot command-line options it passes, but it cannot verify
scheduling support: interactive slash commands such as `/every` appear in no
help surface. A session that cannot establish its schedule reports that in the
session instead of failing to launch.

## Setup and migration

The recommended entrypoint is the conversational setup agent:

```powershell
git clone https://github.com/AmoebaChant/pan.git
Set-Location .\pan
npx --yes --package . pan onboard
```

It installs Pan's user-scoped Copilot assets, gathers the setup choices, invokes
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
  --project-title "Personal Pan" `
  --approval-mode prompt `
  --install-assets
```

Fresh setup keeps scheduled reviews disabled. Enable scheduling once the domain
is verified and you want unattended review turns.

To connect an existing private repository and compatible Project, use
`--repository-mode connect`, `--project-mode connect`, and
`--project-number <number>`. `--path` may identify an existing local domain
checkout or a missing path where Pan should clone the repository. Pan preserves
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

On Windows, create self-contained shortcuts that use Pan's packaged icon:

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
