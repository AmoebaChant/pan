# PAN module and schemas

`@amoebachant/pan` is an ESM package with no runtime dependencies. It requires
Node.js 22+ and uses the authenticated `gh` CLI for GitHub operations.

```js
import {
  GhClient,
  PanStore,
  loadDomainConfig,
  startPanSession,
  createEvidenceCommandHandlers,
  createActionCommandHandlers,
} from "@amoebachant/pan";
```

## Public surface

The package exports `GhClient`/`GhCommandError`, `PanStore`, domain
configuration load/validate/migrate helpers, setup and asset services, session
launch and Copilot-contract helpers, command result and command-handler
factories, leadership primitives, action and reconciliation services,
portfolio/workstream services, and runner/playbook/task utilities. Import the
named API you need from the package root.

Host, daemon, endpoint, MCP, launcher, and persistent review-runtime APIs are
not exported. The sole package executable is `pan`; `pan-runner` remains
available as `bin/pan-runner.js` for its profile-based worker process.

## Store use

```js
const store = new PanStore({
  repository: "example/private-domain",
  projectOwner: "example",
  projectNumber: 2,
  gh: new GhClient(),
});

const snapshot = await store.readCanonicalProject();
if (!snapshot.complete) throw new Error("Complete Project evidence is required");
```

`readCanonicalProject()` preserves canonical Project order and fails rather
than silently returning partial Issue, field, assignee, label, or comment
evidence. `createItem`, `setFields`, `listByFilter`, `claimWithLease`,
`heartbeat`, and `release` validate Project fields against
`schema/project-fields.json`.

## Contracts

- `schema/domain-config.json` — version-2 domain/session/scheduling policy.
- `schema/pan-action.json` — evidence-backed proposed actions and groups.
- `schema/pan-command-result.json` — helper status, receipts, diagnostics, and
  recovery.
- `schema/portfolio-snapshot.json` — complete evidence and expected-state
  identities.
- `schema/playbook.json` and `schema/runner-profile.json` — private runner
  capability and delivery configuration.
- `schema/project-fields.json` — required GitHub Project fields.

Schemas are reusable contracts, not locations for a user's domain data,
credentials, machine paths, or live lease values. See
[helper command behavior](triage-and-attention.md) for preconditions and
recovery.
