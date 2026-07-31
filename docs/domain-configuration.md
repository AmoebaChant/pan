# Pan domain configuration

Pan keeps shared domain configuration and machine-local settings separate. The
domain repository is accessed through GitHub APIs and never needs a local
checkout.

## Shared `pan.json`

The default branch of the domain repository contains a small version-3
`pan.json`:

```json
{
  "version": 3,
  "domain": {
    "repository": "example/personal-domain",
    "projectOwner": "example",
    "projectNumber": 12
  },
  "agent": { "name": "pan", "model": "gpt-5.6-sol" },
  "scheduling": {
    "enabled": true,
    "reviewIntervalSeconds": 3600,
    "startup": "immediate",
    "retrySeconds": 60,
    "rateLimitRetrySeconds": 900
  },
  "policy": { "triageAuthority": "report" }
}
```

Pan reads and updates this file with the GitHub Contents API. Every update uses
the current blob SHA, so a concurrent edit fails instead of being silently
overwritten, and every accepted update remains in Git history.

Fetch the document and SHA:

```powershell
pan config get --config <machine-config> --json
```

Update it after editing a local copy:

```powershell
pan config update --config <machine-config> `
  --document .\pan.json `
  --expected-sha <sha>
```

## Machine configuration

Setup writes a local `pan-machine` locator under `%LOCALAPPDATA%\PAN\domains`
unless `--local-config` is supplied. It contains only the domain repository
locator, local product-context paths, and local agent executable/model
overrides. Authentication remains with `gh`. Runner identity, capabilities,
repository checkouts used by playbooks, worktree roots, state directories, and
terminal preferences remain in the separate local runner profile.

No workstream, task, lifecycle, ordering, or lease state is stored locally.

## API-only setup

Create or join a domain with:

```powershell
pan setup example/personal-domain
```

Setup creates or validates the private repository, backlog Project, required
Project fields, exact `Workstream` label, and shared `pan.json`, then writes
only this machine's local configuration. Re-running the command on another
machine fetches the existing shared configuration and asks only for local
settings. Setup is idempotent and fails on incompatible Projects, labels, or
shared identity instead of replacing them.

Fresh setup leaves scheduled reviews disabled. Enable them in shared
configuration after verification.

## Scheduling

Scheduling defaults are shared. A native session schedule uses at most
one-hour triggers and launch-local due metadata; Pan does not create an
external scheduler or catch up reviews after a session exits.

`policy.triageAuthority` may be `report` or `triage-fields`. The latter permits
a scheduled review to fill triage fields only for untriaged items. Already
triaged items still require approval, and active runner-owned fields remain
untouched.

## Legacy configuration

Version-1 and version-2 checkout-based configuration remains readable for
migration and compatibility. New domains use the shared version-3 document and
machine locator. The schemas are
[`schema/domain-config.json`](../schema/domain-config.json) and
[`schema/machine-domain-config.json`](../schema/machine-domain-config.json).
