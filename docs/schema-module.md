# Schema module

The package exports a low-dependency Node API over the authenticated `gh` CLI.
PAN and its runners use the same API so Project field names, option validation,
and lease behavior stay consistent.

## Configuration

```js
import { GhClient, PanStore } from "@amoebachant/pan";

const store = new PanStore({
  repository: "owner/private-data-repo",
  projectOwner: "owner",
  projectNumber: 2,
  gh: new GhClient(),
});
```

The active `gh` account needs read-write access to the domain repository and its
Project, including the `project` OAuth scope. `getSchema()` reads the Project and
validates every field and single-select option against
`schema/project-fields.json`.

## Items and fields

`createItem()` creates an Issue, adds it to the Project, and applies PAN fields:

```js
const item = await store.createItem({
  title: "Implement the runner loop",
  body: "Acceptance criteria...",
  fields: {
    owner: "agent",
    status: "ready",
    priority: "normal",
    requirements: ["repo:owner/tool", "env:local"],
    autonomy: "full-auto",
    workstream: "orchestration/runner",
  },
});
```

Use `setFields(item.id, values)` for later updates. `null`, `undefined`, and the
empty string clear a field. Select values are checked before any mutation runs.
`requirements` accepts either newline-delimited text or an array.

`listByFilter()` returns canonical items and supports exact field filters, an
array of accepted values, required capabilities, and lease state:

```js
const work = await store.listByFilter({
  owner: "agent",
  status: "ready",
  requirements: ["env:local"],
  claimable: true,
});
```

Each item contains Issue metadata, a `fields` object keyed by the manifest keys,
and a parsed `requirements` array. Available boolean filters are `unclaimed`,
`leaseExpired`, and `claimable`.

`readCanonicalProject()` is the fail-closed portfolio read:

```js
const snapshot = await store.readCanonicalProject();
console.log(snapshot.id, snapshot.items.map((item) => item.id));
```

It preserves Project connection order and includes Issue creation/update times,
state, repository, labels, assignees, comments, and every configured Project
field. `snapshot.id` is a stable SHA-256 identity over that ordered mutable
evidence; `capturedAt` records the read time and `complete` is true only for a
successful complete read.

Project items paginate to completion up to the configurable
`projectItemSafetyLimit` constructor option (default 1,000). Reads fail rather
than return partial evidence when that ceiling is exceeded, nested field,
assignee, label, or comment connections are truncated, pagination is
inconsistent, or an item is not backed by a readable Issue.

`addComment(item, body)` appends an audit or attention record to an Issue-backed
item.

## Leases

Claims use the design's optimistic read-update-confirm protocol. GitHub Projects
does not provide compare-and-swap field updates, so callers must only start work
after `claimed` is `true`.

```js
const claim = await store.claimWithLease({
  itemId: item.id,
  runner: "machine-a/slot-1",
  assignee: "github-login",
  leaseUntil: new Date(Date.now() + 10 * 60_000).toISOString(),
});

const heartbeat = await store.heartbeat({
  itemId: item.id,
  runner: "machine-a/slot-1",
  leaseUntil: new Date(Date.now() + 10 * 60_000).toISOString(),
});

const release = await store.release({
  itemId: item.id,
  runner: "machine-a/slot-1",
  assignee: "github-login",
  status: "ready",
});
```

An active lease held by another runner is never overwritten. Expired leases can
be reclaimed. Heartbeats require the same runner and a lease that has not
expired. Release clears `claimed-by` and `lease-until`; its default status is
`ready`. Pass the optional Issue assignee when GitHub assignment is part of the
runner identity.
