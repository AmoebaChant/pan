import assert from "node:assert/strict";
import test from "node:test";

import { GhClient, IssueCatalog } from "../src/index.js";

const NOW = new Date("2026-07-22T21:00:00.000Z");

test("catalogs every open and closed Issue while excluding pull-request records", async () => {
  const gh = new CatalogGh({
    open: [
      issue(4, { comments: [comment(41)] }),
      pullRequest(5),
      issue(2, { comments: [comment(21), comment(22)] }),
    ],
    closed: [issue(1, { state: "closed", closedAt: "2026-07-21T00:00:00Z" })],
  });
  const catalog = await catalogFor(gh).read();

  assert.equal(catalog.complete, true);
  assert.deepEqual(
    catalog.issues.map((entry) => [entry.number, entry.state, entry.comments.length]),
    [
      [1, "closed", 0],
      [2, "open", 2],
      [4, "open", 1],
    ],
  );
  assert.equal(catalog.excludedPullRequests, 1);
  assert.deepEqual(catalog.source.issues.states, {
    open: { complete: true, count: 3 },
    closed: { complete: true, count: 1 },
  });
  assert.equal(catalog.source.comments.complete, true);
  assert.equal(catalog.source.relationships.excluded, true);
  assert.ok(
    gh.calls.includes("repos/example/domain/issues/2/comments"),
    "comments are paged for each non-PR Issue",
  );
});

test("returns incomplete diagnostics instead of treating partial evidence as complete", async () => {
  const gh = new CatalogGh({
    open: [issue(1), { ...issue(2), title: undefined }],
    closed: new Error("GitHub rate limit while reading closed Issues"),
  });
  const catalog = await catalogFor(gh).read();

  assert.equal(catalog.complete, false);
  assert.equal(catalog.source.issues.complete, false);
  assert.equal(catalog.issues.length, 1);
  assert.deepEqual(
    catalog.diagnostics.map((entry) => entry.code).sort(),
    ["issues-incomplete", "malformed-issue"],
  );
});

test("detects a changed Issue population during the verification read", async () => {
  let openReads = 0;
  const gh = {
    async paginateRestJson(path) {
      if (path.includes("state=closed")) {
        return [];
      }
      if (path.includes("comments")) {
        return [];
      }
      openReads += 1;
      return openReads === 1 ? [issue(1)] : [issue(1), issue(2)];
    },
  };

  const catalog = await catalogFor(gh).read();

  assert.equal(catalog.complete, false);
  assert.ok(
    catalog.diagnostics.some((entry) => entry.code === "issues-changed"),
  );
});

test("records deliberately excluded nested sources and stable mutable identities", async () => {
  const first = new CatalogGh({
    open: [issue(2), issue(1)],
    closed: [],
  });
  const second = new CatalogGh({
    open: [issue(1), issue(2)],
    closed: [],
  });
  const excluded = await catalogFor(first).read({ includeComments: false });
  const repeated = await catalogFor(second).read({ includeComments: false });

  assert.equal(excluded.complete, true);
  assert.equal(excluded.source.comments.excluded, true);
  assert.equal(excluded.source.comments.complete, false);
  assert.equal(excluded.id, repeated.id);

  second.byState.open[0].updated_at = "2026-07-23T00:00:00.000Z";
  const changed = await catalogFor(second).read({ includeComments: false });
  assert.notEqual(excluded.id, changed.id);
});

test("marks relationship requests incomplete when the source intentionally lacks them", async () => {
  const catalog = await catalogFor(
    new CatalogGh({ open: [issue(1)], closed: [] }),
  ).read({ includeRelationships: true });

  assert.equal(catalog.complete, false);
  assert.equal(catalog.source.relationships.complete, false);
  assert.match(catalog.diagnostics.at(-1).message, /not supported/i);
});

test("GhClient REST pagination checks every page and safety limit", async () => {
  const client = new GhClient();
  const seen = [];
  client.runJson = async (args) => {
    seen.push(args.at(-1));
    const page = new URL(`https://example.test/${args.at(-1)}`).searchParams.get(
      "page",
    );
    return page === "1" ? [{ id: 1 }, { id: 2 }] : [];
  };

  assert.deepEqual(
    await client.paginateRestJson("repos/example/domain/issues", {
      pageSize: 2,
      safetyLimit: 2,
    }),
    [{ id: 1 }, { id: 2 }],
  );
  assert.equal(seen.length, 2);

  client.runJson = async () => [{ id: 1 }, { id: 2 }];
  await assert.rejects(
    client.paginateRestJson("repos/example/domain/issues", {
      pageSize: 2,
      safetyLimit: 2,
    }),
    /safety limit/,
  );
});

function catalogFor(gh) {
  return new IssueCatalog({
    repository: "example/domain",
    gh,
    now: () => NOW,
  });
}

class CatalogGh {
  constructor(byState) {
    this.byState = byState;
    this.calls = [];
  }

  async paginateRestJson(path) {
    this.calls.push(path);
    if (path.includes("/comments")) {
      const number = Number(path.match(/issues\/(\d+)\/comments/)[1]);
      return this.byState.open
        .concat(this.byState.closed)
        .find((entry) => entry.number === number)?.comments ?? [];
    }
    const state = new URL(`https://example.test/${path}`).searchParams.get("state");
    const result = this.byState[state];
    if (result instanceof Error) {
      throw result;
    }
    return structuredClone(result);
  }
}

function issue(number, options = {}) {
  return {
    id: number,
    node_id: `I_${number}`,
    number,
    html_url: `https://github.com/example/domain/issues/${number}`,
    url: `https://api.github.com/repos/example/domain/issues/${number}`,
    title: `Issue ${number}`,
    body: "Evidence",
    state: options.state ?? "open",
    created_at: "2026-07-20T00:00:00.000Z",
    updated_at: options.updatedAt ?? "2026-07-21T00:00:00.000Z",
    closed_at: options.closedAt ?? null,
    labels: [{ name: "tracked" }],
    assignees: [{ login: "octocat" }],
    user: { login: "author" },
    comments: options.comments ?? [],
  };
}

function pullRequest(number) {
  return {
    ...issue(number),
    pull_request: { url: `https://api.github.com/repos/example/domain/pulls/${number}` },
  };
}

function comment(id) {
  return {
    id,
    node_id: `IC_${id}`,
    body: `Comment ${id}`,
    html_url: `https://github.com/example/domain/issues/1#issuecomment-${id}`,
    created_at: "2026-07-21T00:00:00.000Z",
    updated_at: "2026-07-21T00:00:00.000Z",
    user: { login: "commenter" },
  };
}
