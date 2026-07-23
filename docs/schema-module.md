# PAN module and schemas

`@amoebachant/pan` is an ESM package with no runtime dependencies. It requires
Node.js 22+ and uses the authenticated `gh` CLI for GitHub operations.

```js
import {
  GhClient,
  PanStore,
  loadDomainConfig,
  startPanSession,
} from "@amoebachant/pan";
```

## Public surface

The package exports domain configuration, setup, asset, session, Project store,
runner, playbook, and task-execution utilities. The sole package executable is
`pan`; `pan-runner` remains available as `bin/pan-runner.js` for its
profile-based worker process.

## Store use

```js
const store = new PanStore({
  repository: "example/private-domain",
  projectOwner: "example",
  projectNumber: 2,
  gh: new GhClient(),
});

const items = await store.listItems();
```

`listItems()` preserves canonical Project order and fails rather than silently
returning partial field, assignee, label, or comment data. Runner methods such
as `listByFilter`, `claimWithLease`, `heartbeat`, and `release` validate Project
fields against `schema/project-fields.json`.

## Contracts

- `schema/domain-config.json` - domain and foreground-session configuration.
- `schema/playbook.json` and `schema/runner-profile.json` - private runner
  capability and delivery configuration.
- `schema/project-fields.json` - shared GitHub Project fields.

Schemas are reusable contracts, not locations for domain data, credentials,
machine paths, or live lease values.
