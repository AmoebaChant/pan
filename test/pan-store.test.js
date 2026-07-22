import assert from "node:assert/strict";
import test from "node:test";

import { PanStore } from "../src/index.js";

const NOW = new Date("2026-07-17T20:00:00Z");
const FUTURE = "2026-07-17T20:10:00Z";
const LATER = "2026-07-17T20:12:00Z";
const PAST = "2026-07-17T19:59:00Z";
const MANIFEST = {
  fields: [
    {
      key: "owner",
      name: "owner",
      type: "single_select",
      options: ["unassigned", "human", "agent"],
    },
    {
      key: "status",
      name: "Status",
      type: "single_select",
      options: [
        "untriaged",
        "needs-detail",
        "ready",
        "in-progress",
        "in-review",
        "done",
        "blocked",
      ],
    },
    {
      key: "priority",
      name: "priority",
      type: "single_select",
      options: ["urgent", "high", "normal", "low"],
    },
    {
      key: "requirements",
      name: "requirements",
      type: "text",
    },
    {
      key: "autonomy",
      name: "autonomy",
      type: "single_select",
      options: ["manual", "full-auto"],
    },
    {
      key: "leaseUntil",
      name: "lease-until",
      type: "text",
    },
    {
      key: "claimedBy",
      name: "claimed-by",
      type: "text",
    },
    {
      key: "workstream",
      name: "workstream",
      type: "text",
    },
  ],
};

test("loads and validates the live Project schema", async () => {
  const { store } = fixture();
  const schema = await store.getSchema();

  assert.equal(schema.projectId, "project-id");
  assert.equal(schema.fields.status.options.ready, "status-ready");
  assert.equal(schema.fields.workstream.id, "field-workstream");
});

test("retries schema loading after a transient failure", async () => {
  const { store, gh } = fixture({ failSchemaOnce: true });

  await assert.rejects(store.getSchema(), /rate limit exceeded/i);
  const schema = await store.getSchema();

  assert.equal(schema.projectId, "project-id");
  assert.equal(
    gh.jsonCalls.filter(
      (args) => args[0] === "project" && args[1] === "view",
    ).length,
    2,
  );
});

test("creates an Issue, adds it to the Project, and sets fields", async () => {
  const { store, gh } = fixture();
  const item = await store.createItem({
    title: "Implement a runner",
    body: "Acceptance criteria",
    labels: ["enhancement"],
    assignees: ["octocat"],
    fields: {
      owner: "agent",
      status: "ready",
      requirements: ["repo:AmoebaChant/pan", "env:local"],
      workstream: "lab/pan",
    },
  });

  assert.equal(item.number, 2);
  assert.equal(item.fields.owner, "agent");
  assert.equal(item.fields.status, "ready");
  assert.deepEqual(item.requirements, [
    "repo:AmoebaChant/pan",
    "env:local",
  ]);
  assert.deepEqual(gh.issueCreates[0].labels, ["enhancement"]);
  assert.deepEqual(gh.issueCreates[0].assignees, ["octocat"]);
});

test("scopes marker lookup to open repair Issues", async () => {
  const { store, gh } = fixture({
    openIssues: [
      {
        number: 9,
        title: "Repair PAN",
        body: "<!-- pan:self-repair:abc -->",
        url: "https://github.com/AmoebaChant/pan-work/issues/9",
        state: "OPEN",
      },
    ],
  });

  const issue = await store.findIssueByMarker(
    "<!-- pan:self-repair:abc -->",
    { state: "open" },
  );

  assert.equal(issue.number, 9);
  const args = gh.jsonCalls.find(
    (call) => call[0] === "issue" && call[1] === "list",
  );
  assert.equal(valueAfter(args, "--state"), "open");
});

test("cleans up a partially created item when field setup fails", async () => {
  const { store, gh } = fixture({ failProjectEdit: true });

  await assert.rejects(
    store.createItem({
      title: "Broken item",
      fields: { owner: "agent" },
    }),
    /project edit failed/,
  );

  assert.equal(gh.items.some((item) => item.id === "item-2"), false);
  assert.deepEqual(gh.deletedIssues, [2]);
});

test("rejects unknown fields and invalid select options", async () => {
  const { store, gh } = fixture();

  await assert.rejects(
    store.setFields("item-1", { unknown: "value" }),
    /Unknown PAN field/,
  );
  await assert.rejects(
    store.setFields("item-1", { owner: "agent", status: "invalid" }),
    /Invalid status value/,
  );
  await assert.rejects(
    store.createItem({
      title: "Must not be created",
      fields: { status: "invalid" },
    }),
    /Invalid status value/,
  );
  assert.equal(gh.issueCreates.length, 0);
  assert.equal(gh.projectEdits, 0);
});

test("clears an empty requirements array", async () => {
  const { store } = fixture({
    items: [makeItem({ requirements: "repo:example/tool" })],
  });

  await store.setFields("item-1", { requirements: [] });

  assert.equal((await store.getItem("item-1")).fields.requirements, "");
});

test("filters canonical items by fields, requirements, and lease state", async () => {
  const { store } = fixture({
    items: [
      makeItem({
        id: "ready",
        owner: "agent",
        status: "ready",
        requirements: "repo:AmoebaChant/pan\nenv:local",
      }),
      makeItem({
        id: "leased",
        owner: "agent",
        status: "ready",
        claimedBy: "runner-a",
        leaseUntil: FUTURE,
      }),
      makeItem({
        id: "expired",
        owner: "agent",
        status: "ready",
        claimedBy: "runner-b",
        leaseUntil: PAST,
      }),
    ],
  });

  assert.deepEqual(
    (await store.listByFilter({ owner: "agent", claimable: true })).map(
      (item) => item.id,
    ),
    ["ready", "expired"],
  );
  assert.deepEqual(
    (
      await store.listByFilter({
        requirements: ["repo:AmoebaChant/pan", "env:local"],
      })
    ).map((item) => item.id),
    ["ready"],
  );
});

test("bounds board reads and fetches individual items directly", async () => {
  const { store, gh } = fixture();

  await store.listItems();
  const boardRead = gh.jsonCalls.find(
    (args) =>
      args[0] === "api" &&
      args[1] === "graphql" &&
      valueAfterAssignment(args, "query")?.includes("items(first: 20"),
  );
  assert.ok(boardRead);
  assert.equal(
    gh.jsonCalls.some(
      (args) =>
        args[0] === "project" &&
        ["field-list", "item-list"].includes(args[1]),
    ),
    false,
  );

  gh.jsonCalls.length = 0;
  const item = await store.getItem("item-1");

  assert.equal(item.id, "item-1");
  assert.equal(
    gh.jsonCalls.some(
      (args) => args[0] === "project" && args[1] === "item-list",
    ),
    false,
  );
  assert.equal(
    gh.jsonCalls.some(
      (args) => args[0] === "api" && args[1] === "graphql",
    ),
    true,
  );
});

test("reads every Project page in canonical order with complete Issue evidence", async () => {
  const { store, gh } = fixture({
    items: [
      makeItem({
        id: "item-3",
        number: 3,
        assignees: ["octocat"],
        labels: ["urgent"],
        comments: [
          {
            id: "comment-3",
            body: "Commitment confirmed.",
            url: "comment-url",
            createdAt: "2026-07-19T10:00:00Z",
            updatedAt: "2026-07-19T11:00:00Z",
            author: "octocat",
          },
        ],
      }),
      makeItem({ id: "item-1", number: 1 }),
      makeItem({ id: "item-2", number: 2 }),
    ],
    projectPageSize: 2,
  });

  const snapshot = await store.readCanonicalProject();

  assert.equal(snapshot.complete, true);
  assert.match(snapshot.id, /^sha256:[0-9a-f]{64}$/);
  assert.equal(snapshot.capturedAt, NOW.toISOString());
  assert.deepEqual(
    snapshot.items.map((item) => item.id),
    ["item-3", "item-1", "item-2"],
  );
  assert.equal(snapshot.items[0].createdAt, "2026-07-17T18:00:00Z");
  assert.equal(snapshot.items[0].updatedAt, "2026-07-17T19:00:00Z");
  assert.deepEqual(snapshot.items[0].assignees, ["octocat"]);
  assert.deepEqual(snapshot.items[0].labels, ["urgent"]);
  assert.equal(snapshot.items[0].comments[0].author, "octocat");
  assert.equal(
    gh.jsonCalls.filter(
      (args) =>
        valueAfterAssignment(args, "projectId") &&
        valueAfterAssignment(args, "query")?.includes("items(first:"),
    ).length,
    2,
  );
});

test("derives a stable identity from ordered mutable evidence", async () => {
  const { store, gh } = fixture();

  const first = await store.readCanonicalProject();
  const unchanged = await store.readCanonicalProject();
  gh.items[0].content.updatedAt = "2026-07-17T19:30:00Z";
  const changed = await store.readCanonicalProject();

  assert.equal(first.id, unchanged.id);
  assert.notEqual(first.id, changed.id);
});

test("fails closed at the configurable Project safety ceiling", async () => {
  const { store } = fixture({
    items: [
      makeItem({ id: "item-1" }),
      makeItem({ id: "item-2" }),
      makeItem({ id: "item-3" }),
    ],
    projectItemSafetyLimit: 2,
  });

  await assert.rejects(
    store.readCanonicalProject(),
    /exceeding the 2-entry read limit/,
  );
});

test("fails closed when an item has unpaged field values", async () => {
  const { store } = fixture({ truncatedFieldValues: true });

  await assert.rejects(store.getItem("item-1"), /cannot be read safely/);
});

test("classifies unreadable and unsupported Project content without omitting it", async () => {
  for (const option of [
    "truncatedAssignees",
    "truncatedLabels",
    "truncatedComments",
  ]) {
    const { store } = fixture({ [option]: true });
    const snapshot = await store.readCanonicalProject();
    assert.equal(snapshot.complete, false, option);
    assert.equal(snapshot.items.length, 1, option);
    assert.equal(snapshot.items[0].contentClassification, "unreadable", option);
  }

  const { store } = fixture({
    items: [
      makeItem({ id: "draft-1", contentType: "DraftIssue" }),
      makeItem({ id: "pr-1", contentType: "PullRequest" }),
      makeItem({
        id: "cross-domain-1",
        number: 3,
        repository: "other/domain",
      }),
    ],
  });
  const snapshot = await store.readCanonicalProject();
  assert.equal(snapshot.complete, true);
  assert.deepEqual(
    snapshot.items.map((item) => item.contentClassification),
    ["draft", "pull-request", "cross-domain-issue"],
  );
});

test("preserves Project read failures without fabricating comments", async () => {
  const { store } = fixture({ failProjectRead: true });

  await assert.rejects(
    store.readCanonicalProject(),
    /API rate limit exceeded while reading Project items/,
  );
});

test("claims an available item and confirms lease ownership", async () => {
  const { store, gh } = fixture({
    items: [makeItem({ status: "ready" })],
  });

  const result = await store.claimWithLease({
    itemId: "item-1",
    runner: "runner-a",
    assignee: "octocat",
    leaseUntil: FUTURE,
  });

  assert.equal(result.claimed, true);
  assert.equal(result.item.fields.claimedBy, "runner-a");
  assert.equal(result.item.fields.leaseUntil, FUTURE);
  assert.equal(result.item.fields.status, "in-progress");
  assert.deepEqual(gh.issueEdits, [
    { number: 1, flag: "--add-assignee", assignee: "octocat" },
  ]);
});

test("does not steal an active lease from another runner", async () => {
  const { store } = fixture({
    items: [
      makeItem({
        claimedBy: "runner-a",
        leaseUntil: FUTURE,
        status: "in-progress",
      }),
    ],
  });

  const result = await store.claimWithLease({
    itemId: "item-1",
    runner: "runner-b",
    leaseUntil: LATER,
  });

  assert.deepEqual(
    { claimed: result.claimed, reason: result.reason },
    { claimed: false, reason: "leased" },
  );
  assert.equal(result.item.fields.claimedBy, "runner-a");
});

test("rolls back a claim when Issue assignment fails", async () => {
  const { store } = fixture({
    items: [makeItem({ status: "ready" })],
    failAssignee: true,
  });

  await assert.rejects(
    store.claimWithLease({
      itemId: "item-1",
      runner: "runner-a",
      assignee: "octocat",
      leaseUntil: FUTURE,
    }),
    /assignment failed/,
  );

  const item = await store.getItem("item-1");
  assert.equal(item.fields.status, "ready");
  assert.equal(item.fields.claimedBy, "");
  assert.equal(item.fields.leaseUntil, "");
});

test("allows an expired lease to be reclaimed", async () => {
  const { store } = fixture({
    items: [
      makeItem({
        claimedBy: "runner-a",
        leaseUntil: PAST,
        status: "in-progress",
      }),
    ],
  });

  const result = await store.claimWithLease({
    itemId: "item-1",
    runner: "runner-b",
    leaseUntil: FUTURE,
  });

  assert.equal(result.claimed, true);
  assert.equal(result.item.fields.claimedBy, "runner-b");
});

test("heartbeats only a live lease owned by the runner", async () => {
  const { store } = fixture({
    items: [
      makeItem({
        claimedBy: "runner-a",
        leaseUntil: FUTURE,
        status: "in-progress",
      }),
    ],
  });

  const wrongRunner = await store.heartbeat({
    itemId: "item-1",
    runner: "runner-b",
    leaseUntil: LATER,
  });
  assert.equal(wrongRunner.reason, "not-owner");

  const renewed = await store.heartbeat({
    itemId: "item-1",
    runner: "runner-a",
    leaseUntil: LATER,
  });
  assert.equal(renewed.renewed, true);
  assert.equal(renewed.item.fields.leaseUntil, LATER);
});

test("releases the owning runner and returns the item to ready", async () => {
  const { store, gh } = fixture({
    items: [
      makeItem({
        claimedBy: "runner-a",
        leaseUntil: FUTURE,
        status: "in-progress",
      }),
    ],
  });

  const result = await store.release({
    itemId: "item-1",
    runner: "runner-a",
    assignee: "octocat",
  });

  assert.equal(result.released, true);
  assert.equal(result.item.fields.claimedBy, "");
  assert.equal(result.item.fields.leaseUntil, "");
  assert.equal(result.item.fields.status, "ready");
  assert.deepEqual(gh.issueEdits, [
    { number: 1, flag: "--remove-assignee", assignee: "octocat" },
  ]);
});

test("atomically escalates a leased task to urgent human attention", async () => {
  const { store, gh } = fixture({
    items: [
      makeItem({
        owner: "agent",
        status: "in-progress",
        priority: "low",
        claimedBy: "runner-a",
        leaseUntil: FUTURE,
        assignees: ["runner-bot"],
      }),
    ],
  });

  const result = await store.requestHumanAttention({
    itemId: "item-1",
    runner: "runner-a",
    runnerAssignee: "runner-bot",
    humanAssignee: "octocat",
  });

  assert.equal(result.requested, true);
  assert.equal(result.item.fields.owner, "human");
  assert.equal(result.item.fields.status, "blocked");
  assert.equal(result.item.fields.priority, "urgent");
  assert.equal(result.item.fields.claimedBy, "");
  assert.equal(result.item.fields.leaseUntil, "");
  assert.deepEqual(gh.issueEdits, [
    { number: 1, flag: "--remove-assignee", assignee: "runner-bot" },
    { number: 1, flag: "--add-assignee", assignee: "octocat" },
  ]);
});

test("restores the lease and runner assignment when human assignment fails", async () => {
  const { store } = fixture({
    items: [
      makeItem({
        owner: "agent",
        status: "in-progress",
        priority: "low",
        claimedBy: "runner-a",
        leaseUntil: FUTURE,
        assignees: ["runner-bot"],
      }),
    ],
    failAssignee: true,
  });

  await assert.rejects(
    store.requestHumanAttention({
      itemId: "item-1",
      runner: "runner-a",
      runnerAssignee: "runner-bot",
      humanAssignee: "octocat",
    }),
    /assignment failed/,
  );

  const item = await store.getItem("item-1");
  assert.equal(item.fields.status, "in-progress");
  assert.equal(item.fields.owner, "agent");
  assert.equal(item.fields.priority, "low");
  assert.equal(item.fields.claimedBy, "runner-a");
  assert.equal(item.fields.leaseUntil, FUTURE);
  assert.deepEqual(item.assignees, ["runner-bot"]);
});

test("resolves human attention idempotently and restores prior priority", async () => {
  const { store, gh } = fixture({
    items: [
      makeItem({
        owner: "human",
        status: "blocked",
        priority: "urgent",
        assignees: ["octocat"],
      }),
    ],
  });

  await store.resolveHumanAttention({
    itemId: "item-1",
    humanAssignee: "octocat",
    priority: "low",
    resumeAffinity: "resume:runner-a/pan-development",
  });
  const result = await store.resolveHumanAttention({
    itemId: "item-1",
    humanAssignee: "octocat",
    priority: "low",
    resumeAffinity: "resume:runner-a/pan-development",
  });

  assert.equal(result.resolved, true);
  assert.equal(result.item.fields.status, "ready");
  assert.equal(result.item.fields.owner, "agent");
  assert.equal(result.item.fields.priority, "low");
  assert.equal(
    result.item.fields.claimedBy,
    "resume:runner-a/pan-development",
  );
  assert.deepEqual(gh.issueEdits, [
    { number: 1, flag: "--remove-assignee", assignee: "octocat" },
  ]);
});

test("closes an Issue when its runner releases it as done", async () => {
  const { store, gh } = fixture({
    items: [
      makeItem({
        claimedBy: "runner-a",
        leaseUntil: FUTURE,
        status: "in-progress",
      }),
    ],
  });

  const result = await store.release({
    itemId: "item-1",
    runner: "runner-a",
    status: "done",
  });

  assert.equal(result.released, true);
  assert.equal(result.item.fields.status, "done");
  assert.equal(result.item.state, "closed");
  assert.deepEqual(gh.issueStateEdits, [
    { number: 1, action: "close", reason: "completed" },
  ]);
});

test("keeps an Issue open when completed work enters review", async () => {
  const { store, gh } = fixture({
    items: [
      makeItem({
        claimedBy: "runner-a",
        leaseUntil: FUTURE,
        status: "in-progress",
      }),
    ],
  });

  const result = await store.release({
    itemId: "item-1",
    runner: "runner-a",
    status: "in-review",
  });

  assert.equal(result.released, true);
  assert.equal(result.item.fields.status, "in-review");
  assert.equal(result.item.state, "open");
  assert.deepEqual(gh.issueStateEdits, []);
});

test("completes in-review work after its linked pull request merges", async () => {
  const { store, gh } = fixture({
    items: [
      makeItem({
        status: "in-review",
        linkedPullRequests: [
          {
            number: 42,
            url: "https://github.com/AmoebaChant/pan/pull/42",
            state: "MERGED",
            mergedAt: "2026-07-17T19:30:00Z",
            repository: "AmoebaChant/pan",
          },
        ],
      }),
    ],
  });

  const result = await store.reconcileMergedPullRequests();

  assert.deepEqual(result, {
    scanned: 1,
    completed: [
      {
        itemId: "item-1",
        issueNumber: 1,
        pullRequestUrl: "https://github.com/AmoebaChant/pan/pull/42",
      },
    ],
  });
  assert.equal((await store.getItem("item-1")).fields.status, "done");
  assert.deepEqual(gh.issueStateEdits, [
    { number: 1, action: "close", reason: "completed" },
  ]);
});

test("leaves in-review work unchanged while its linked pull request is open", async () => {
  const { store, gh } = fixture({
    items: [
      makeItem({
        status: "in-review",
        linkedPullRequests: [
          {
            number: 42,
            url: "https://github.com/AmoebaChant/pan/pull/42",
            state: "OPEN",
            mergedAt: null,
            repository: "AmoebaChant/pan",
          },
        ],
      }),
    ],
  });

  const result = await store.reconcileMergedPullRequests();

  assert.deepEqual(result, { scanned: 1, completed: [] });
  assert.equal((await store.getItem("item-1")).fields.status, "in-review");
  assert.deepEqual(gh.issueStateEdits, []);
});

test("marks an auto-closed linked Issue done without closing it again", async () => {
  const { store, gh } = fixture({
    items: [
      makeItem({
        status: "in-review",
        state: "CLOSED",
        linkedPullRequests: [
          {
            number: 42,
            url: "https://github.com/AmoebaChant/pan/pull/42",
            state: "MERGED",
            mergedAt: "2026-07-17T19:30:00Z",
            repository: "AmoebaChant/pan",
          },
        ],
      }),
    ],
  });

  const result = await store.reconcileMergedPullRequests();

  assert.equal(result.completed.length, 1);
  assert.equal((await store.getItem("item-1")).fields.status, "done");
  assert.deepEqual(gh.issueStateEdits, []);
});

test("preserves confirmed done status when merged PR Issue closure fails", async () => {
  const { store } = fixture({
    items: [
      makeItem({
        status: "in-review",
        linkedPullRequests: [
          {
            number: 42,
            url: "https://github.com/AmoebaChant/pan/pull/42",
            state: "MERGED",
            mergedAt: "2026-07-17T19:30:00Z",
            repository: "AmoebaChant/pan",
          },
        ],
      }),
    ],
    failIssueClose: true,
  });

  const result = await store.reconcileMergedPullRequests();

  assert.deepEqual(result.completed, []);
  assert.equal((await store.getItem("item-1")).fields.status, "done");
});

test("retries closure of a done merged pull request without another status transition", async () => {
  const { store, gh } = fixture({
    items: [
      makeItem({
        status: "in-review",
        linkedPullRequests: [
          {
            number: 42,
            url: "https://github.com/AmoebaChant/pan/pull/42",
            state: "MERGED",
            mergedAt: "2026-07-17T19:30:00Z",
            repository: "AmoebaChant/pan",
          },
        ],
      }),
    ],
    failIssueClose: true,
  });

  await store.reconcileMergedPullRequests();
  gh.failIssueClose = false;
  const result = await store.reconcileMergedPullRequests();

  assert.equal(result.completed.length, 1);
  assert.equal((await store.getItem("item-1")).fields.status, "done");
  assert.deepEqual(gh.issueStateEdits, [
    { number: 1, action: "close", reason: "completed" },
    { number: 1, action: "close", reason: "completed" },
  ]);
});

test("does not complete merged review work with an active lease", async () => {
  const { store, gh } = fixture({
    items: [
      makeItem({
        status: "in-review",
        claimedBy: "runner-a",
        leaseUntil: FUTURE,
        linkedPullRequests: [
          {
            number: 42,
            url: "https://github.com/AmoebaChant/pan/pull/42",
            state: "MERGED",
            mergedAt: "2026-07-17T19:30:00Z",
            repository: "AmoebaChant/pan",
          },
        ],
      }),
    ],
  });

  const result = await store.reconcileMergedPullRequests();

  assert.deepEqual(result.completed, []);
  assert.equal((await store.getItem("item-1")).fields.status, "in-review");
  assert.deepEqual(gh.issueStateEdits, []);
});

test("restores a claimed task when closing its Issue fails", async () => {
  const { store, gh } = fixture({
    items: [
      makeItem({
        claimedBy: "runner-a",
        leaseUntil: FUTURE,
        status: "in-progress",
        assignees: ["octocat"],
      }),
    ],
    failIssueClose: true,
  });

  await assert.rejects(
    store.release({
      itemId: "item-1",
      runner: "runner-a",
      assignee: "octocat",
      status: "done",
    }),
    /Issue closure failed/,
  );

  const item = await store.getItem("item-1");
  assert.equal(item.fields.status, "in-progress");
  assert.equal(item.fields.claimedBy, "runner-a");
  assert.equal(item.fields.leaseUntil, FUTURE);
  assert.equal(item.state, "open");
  assert.deepEqual(gh.issueEdits, [
    { number: 1, flag: "--remove-assignee", assignee: "octocat" },
    { number: 1, flag: "--add-assignee", assignee: "octocat" },
  ]);
});

test("does not release an expired lease", async () => {
  const { store } = fixture({
    items: [
      makeItem({
        claimedBy: "runner-a",
        leaseUntil: PAST,
        status: "in-progress",
      }),
    ],
  });

  const result = await store.release({
    itemId: "item-1",
    runner: "runner-a",
  });

  assert.equal(result.released, false);
  assert.equal(result.reason, "lease-expired");
});

test("adds a comment to an Issue-backed item", async () => {
  const { store, gh } = fixture();
  const item = await store.getItem("item-1");

  await store.addComment(item, "Runner update");

  assert.deepEqual(gh.issueComments, [
    {
      number: 1,
      repository: "AmoebaChant/pan-work",
      body: "Runner update",
    },
  ]);
});

test("reads Issue comments", async () => {
  const { store, gh } = fixture();
  gh.commentsByIssue.set(1, [
    {
      id: "comment-1",
      body: "Question",
      url: "comment-url",
      createdAt: "2026-07-20T16:00:00Z",
      author: { login: "octocat" },
    },
  ]);

  const comments = await store.listComments(await store.getItem("item-1"));

  assert.deepEqual(comments, [
    {
      id: "comment-1",
      body: "Question",
      url: "comment-url",
      createdAt: "2026-07-20T16:00:00Z",
      author: "octocat",
    },
  ]);
});

test("adds open repository Issues missing from the Project", async () => {
  const { store, gh } = fixture({
    openIssues: [
      {
        number: 1,
        title: "Task",
        body: "",
        url: "https://github.com/AmoebaChant/pan-work/issues/1",
        state: "OPEN",
      },
      {
        number: 2,
        title: "New task",
        body: "Details",
        url: "https://github.com/AmoebaChant/pan-work/issues/2",
        state: "OPEN",
      },
    ],
  });

  const items = await store.syncOpenIssues();

  assert.equal(items.length, 2);
  assert.equal(items[1].number, 2);
});

test("finds existing Issue membership and adds a missing Issue without cleanup", async () => {
  const { store, gh } = fixture({
    items: [makeItem({ number: 1 })],
    openIssues: [
      {
        number: 2,
        title: "Existing Issue",
        body: "",
        url: "https://github.com/AmoebaChant/pan-work/issues/2",
        state: "OPEN",
      },
    ],
  });
  const snapshot = await store.readCanonicalProject();

  const existing = await store.findProjectIssueMembership(
    "https://github.com/AmoebaChant/pan-work/issues/1",
    { expectedProjectId: snapshot.id },
  );
  const added = await store.ensureIssueProjectMembership(
    "https://github.com/AmoebaChant/pan-work/issues/2",
    { expectedProjectId: snapshot.id },
  );

  assert.equal(existing.item.id, "item-1");
  assert.equal(added.added, true);
  assert.equal(added.item.id, "item-2");
  assert.deepEqual(gh.deletedIssues, []);
});

test("confirms each required Project field and retains partial registration failures", async () => {
  const { store, gh } = fixture({
    items: [makeItem({ owner: "", status: "", priority: "", autonomy: "" })],
    failProjectEdit: true,
  });

  const failed = await store.ensureItemFields("item-1", {
    owner: "unassigned",
    status: "untriaged",
  });

  assert.equal(failed.complete, false);
  assert.deepEqual(failed.confirmedFields, []);
  assert.equal((await store.getItem("item-1")).id, "item-1");
  assert.deepEqual(gh.deletedIssues, []);
});

test("updates Project item ordering", async () => {
  const { store, gh } = fixture();

  await store.reorderItems(["item-2", "item-1"]);

  assert.deepEqual(gh.projectOrders, [
    { itemId: "item-2", afterId: undefined },
    { itemId: "item-1", afterId: "item-2" },
  ]);
});

function fixture({
  items = [makeItem()],
  failAssignee = false,
  failProjectEdit = false,
  openIssues = [],
  truncatedFieldValues = false,
  truncatedAssignees = false,
  truncatedLabels = false,
  truncatedComments = false,
  failSchemaOnce = false,
  failProjectRead = false,
  failIssueClose = false,
  projectPageSize,
  projectItemSafetyLimit,
} = {}) {
  const gh = new FakeGh(items, {
    failAssignee,
    failProjectEdit,
    openIssues,
    truncatedFieldValues,
    truncatedAssignees,
    truncatedLabels,
    truncatedComments,
    failSchemaOnce,
    failProjectRead,
    failIssueClose,
    projectPageSize,
  });
  return {
    gh,
    store: new PanStore({
      repository: "AmoebaChant/pan-work",
      projectOwner: "AmoebaChant",
      projectNumber: 2,
      gh,
      manifest: MANIFEST,
      projectItemSafetyLimit,
      now: () => NOW,
      sleep: async () => {},
    }),
  };
}

class FakeGh {
  constructor(
    items,
    {
      failAssignee = false,
      failProjectEdit = false,
      openIssues = [],
      truncatedFieldValues = false,
      truncatedAssignees = false,
      truncatedLabels = false,
      truncatedComments = false,
      failSchemaOnce = false,
      failProjectRead = false,
      projectPageSize,
      failIssueClose = false,
    } = {},
  ) {
    this.items = structuredClone(items);
    this.failAssignee = failAssignee;
    this.failProjectEdit = failProjectEdit;
    this.openIssues = structuredClone(openIssues);
    this.truncatedFieldValues = truncatedFieldValues;
    this.truncatedAssignees = truncatedAssignees;
    this.truncatedLabels = truncatedLabels;
    this.truncatedComments = truncatedComments;
    this.schemaFailures = failSchemaOnce ? 1 : 0;
    this.failProjectRead = failProjectRead;
    this.projectPageSize = projectPageSize;
    this.failIssueClose = failIssueClose;
    this.issueCreates = [];
    this.issueEdits = [];
    this.issueStateEdits = [];
    this.issueComments = [];
    this.commentsByIssue = new Map();
    this.projectOrders = [];
    this.deletedIssues = [];
    this.projectEdits = 0;
    this.nextIssue = 2;
    this.jsonCalls = [];
  }

  async run(args) {
    if (args[0] === "issue" && args[1] === "create") {
      const issue = {
        title: valueAfter(args, "--title"),
        body: valueAfter(args, "--body"),
        labels: valuesAfter(args, "--label"),
        assignees: valuesAfter(args, "--assignee"),
      };
      this.issueCreates.push(issue);
      return `https://github.com/AmoebaChant/pan-work/issues/${this.nextIssue}`;
    }
    if (args[0] === "project" && args[1] === "item-edit") {
      if (this.failProjectEdit) {
        throw new Error("project edit failed");
      }
      this.projectEdits += 1;
      this.#editProjectItem(args);
      return "";
    }
    if (args[0] === "issue" && args[1] === "edit") {
      const flag = args.find((arg) =>
        ["--add-assignee", "--remove-assignee"].includes(arg),
      );
      this.issueEdits.push({
        number: Number(args[2]),
        flag,
        assignee: valueAfter(args, flag),
      });
      if (
        this.failAssignee &&
        flag === "--add-assignee" &&
        valueAfter(args, flag) === "octocat"
      ) {
        throw new Error("assignment failed");
      }
      const item = this.items.find(
        (candidate) => candidate.content?.number === Number(args[2]),
      );
      if (item) {
        const assignee = valueAfter(args, flag);
        if (flag === "--add-assignee" && !item.assignees.includes(assignee)) {
          item.assignees.push(assignee);
        }
        if (flag === "--remove-assignee") {
          item.assignees = item.assignees.filter(
            (candidate) => candidate !== assignee,
          );
        }
      }
      return "";
    }
    if (
      args[0] === "issue" &&
      ["close", "reopen"].includes(args[1])
    ) {
      const action = args[1];
      this.issueStateEdits.push({
        number: Number(args[2]),
        action,
        reason: valueAfter(args, "--reason"),
      });
      if (this.failIssueClose && action === "close") {
        throw new Error("Issue closure failed");
      }
      const item = this.items.find(
        (candidate) => candidate.content?.number === Number(args[2]),
      );
      if (item) {
        item.content.state = action === "close" ? "CLOSED" : "OPEN";
      }
      return "";
    }
    if (args[0] === "issue" && args[1] === "comment") {
      this.issueComments.push({
        number: Number(args[2]),
        repository: valueAfter(args, "--repo"),
        body: valueAfter(args, "--body"),
      });
      return "https://github.com/AmoebaChant/pan-work/issues/1#issuecomment-1";
    }
    if (args[0] === "api" && args[1] === "graphql") {
      this.projectOrders.push({
        itemId: valueAfterAssignment(args, "itemId"),
        afterId: valueAfterAssignment(args, "afterId"),
      });
      return "";
    }
    if (args[0] === "project" && args[1] === "item-delete") {
      const itemId = valueAfter(args, "--id");
      this.items = this.items.filter((item) => item.id !== itemId);
      return "";
    }
    if (args[0] === "issue" && args[1] === "delete") {
      this.deletedIssues.push(Number(args[2].match(/\/issues\/(\d+)$/)[1]));
      return "";
    }
    throw new Error(`Unexpected gh command: ${args.join(" ")}`);
  }

  async runJson(args) {
    this.jsonCalls.push(args);
    if (args[0] === "project" && args[1] === "view") {
      if (this.schemaFailures > 0) {
        this.schemaFailures -= 1;
        throw new Error("API rate limit exceeded for user");
      }
      return { id: "project-id", number: 2 };
    }
    if (args[0] === "issue" && args[1] === "list") {
      return structuredClone(this.openIssues);
    }
    if (args[0] === "issue" && args[1] === "view") {
      return {
        comments: structuredClone(
          this.commentsByIssue.get(Number(args[2])) ?? [],
        ),
      };
    }
    if (args[0] === "project" && args[1] === "item-add") {
      const issueUrl = valueAfter(args, "--url");
      const number = Number(issueUrl.match(/\/issues\/(\d+)$/)[1]);
      const created = this.issueCreates.find(
        (_issue, index) => index + 2 === number,
      );
      const openIssue = this.openIssues.find((issue) => issue.number === number);
      const item = makeItem({
        id: `item-${number}`,
        number,
        title: created?.title ?? openIssue?.title,
        body: created?.body ?? openIssue?.body,
      });
      this.items.push(item);
      this.nextIssue = Math.max(this.nextIssue, number + 1);
      return { id: item.id };
    }
    if (args[0] === "api" && args[1] === "graphql") {
      const query = valueAfterAssignment(args, "query");
      if (valueAfterAssignment(args, "projectId") && query.includes("fields(first:")) {
        return {
          data: {
            node: {
              fields: {
                nodes: MANIFEST.fields.map((field) => ({
                  __typename:
                    field.type === "single_select"
                      ? "ProjectV2SingleSelectField"
                      : "ProjectV2Field",
                  id: `field-${field.key}`,
                  name: field.name,
                  options: (field.options ?? []).map((option) => ({
                    id: `${field.key}-${option}`,
                    name: option,
                  })),
                })),
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        };
      }
      if (valueAfterAssignment(args, "projectId") && query.includes("items(first:")) {
        if (this.failProjectRead) {
          throw new Error(
            "API rate limit exceeded while reading Project items",
          );
        }
        const start = Number(valueAfterAssignment(args, "cursor") ?? 0);
        const end = this.projectPageSize
          ? Math.min(start + this.projectPageSize, this.items.length)
          : this.items.length;
        return {
          data: {
            node: {
              items: {
                totalCount: this.items.length,
                nodes: this.items
                  .slice(start, end)
                  .map((item) => this.#graphQlItem(item)),
                pageInfo: {
                  hasNextPage: end < this.items.length,
                  endCursor: end < this.items.length ? String(end) : null,
                },
              },
            },
          },
        };
      }
      const item = this.items.find(
        (candidate) => candidate.id === valueAfterAssignment(args, "itemId"),
      );
      return {
        data: {
          node: item ? this.#graphQlItem(item) : null,
        },
      };
    }
    throw new Error(`Unexpected gh JSON command: ${args.join(" ")}`);
  }

  #editProjectItem(args) {
    const item = this.items.find(
      (candidate) => candidate.id === valueAfter(args, "--id"),
    );
    const fieldId = valueAfter(args, "--field-id");
    const field = MANIFEST.fields.find(
      (candidate) => `field-${candidate.key}` === fieldId,
    );
    if (args.includes("--clear")) {
      item[field.name] = "";
      return;
    }
    if (field.type === "single_select") {
      const optionId = valueAfter(args, "--single-select-option-id");
      item[field.name] = field.options.find(
        (option) => `${field.key}-${option}` === optionId,
      );
      return;
    }
    item[field.name] = valueAfter(args, "--text");
  }

  #graphQlItem(item) {
    return {
      id: item.id,
      fieldValues: {
        nodes: MANIFEST.fields
          .map((field) => ({
            field: { name: field.name },
            ...(field.type === "single_select"
              ? { name: item[field.name] }
              : { text: item[field.name] }),
          }))
          .filter((value) => (value.name ?? value.text) !== ""),
        pageInfo: { hasNextPage: this.truncatedFieldValues },
      },
      content: {
        ...(item.contentType === null
          ? null
          : {
              __typename: item.contentType,
              ...item.content,
              repository: { nameWithOwner: item.repository },
              assignees: {
                nodes: item.assignees.map((login) => ({ login })),
                pageInfo: { hasNextPage: this.truncatedAssignees },
              },
              labels: {
                nodes: item.labels.map((name) => ({ name })),
                pageInfo: { hasNextPage: this.truncatedLabels },
              },
              comments: {
                nodes: item.comments.map((comment) => ({
                  ...comment,
                  author: comment.author ? { login: comment.author } : null,
                })),
                pageInfo: { hasNextPage: this.truncatedComments },
              },
              closedByPullRequestsReferences: {
                nodes: item.linkedPullRequests.map((pullRequest) => ({
                  number: pullRequest.number,
                  url: pullRequest.url,
                  state: pullRequest.state,
                  mergedAt: pullRequest.mergedAt,
                  repository: {
                    nameWithOwner: pullRequest.repository,
                  },
                })),
                pageInfo: { hasNextPage: false },
              },
            }),
      },
    };
  }
}

function makeItem({
  id = "item-1",
  number = 1,
  title = "Task",
  body = "",
  owner = "unassigned",
  status = "untriaged",
  priority = "normal",
  requirements = "",
  autonomy = "manual",
  leaseUntil = "",
  claimedBy = "",
  workstream = "lab/pan",
  assignees = [],
  labels = [],
  comments = [],
  linkedPullRequests = [],
  contentType = "Issue",
  repository = "AmoebaChant/pan-work",
  state = "OPEN",
  createdAt = "2026-07-17T18:00:00Z",
  updatedAt = "2026-07-17T19:00:00Z",
} = {}) {
  return {
    id,
    content: {
      number,
      title,
      body,
      state,
      url: `https://github.com/${repository}/issues/${number}`,
      createdAt,
      updatedAt,
    },
    contentType,
    repository,
    assignees,
    labels,
    comments,
    linkedPullRequests,
    owner,
    Status: status,
    priority,
    requirements,
    autonomy,
    "lease-until": leaseUntil,
    "claimed-by": claimedBy,
    workstream,
  };
}

function valueAfter(args, flag) {
  return args[args.indexOf(flag) + 1];
}

function valuesAfter(args, flag) {
  return args.flatMap((arg, index) => (arg === flag ? [args[index + 1]] : []));
}

function valueAfterAssignment(args, name) {
  const assignment = args.find((arg) => arg.startsWith(`${name}=`));
  return assignment?.slice(name.length + 1);
}
