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
      key: "needsHumanSince",
      name: "needs-human-since",
      type: "text",
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

test("rejects unknown fields and invalid select options", async () => {
  const { store, gh } = fixture();

  await assert.rejects(
    store.setFields("item-1", { unknown: "value" }),
    /Unknown Pan field/,
  );
  await assert.rejects(
    store.setFields("item-1", { owner: "agent", status: "invalid" }),
    /Invalid status value/,
  );
  assert.equal(gh.projectEdits, 0);
});

test("clears an empty requirements array", async () => {
  const { store } = fixture({
    items: [makeItem({ requirements: "repo:example/tool" })],
  });

  await store.setFields("item-1", { requirements: [] });

  assert.equal((await store.getItem("item-1")).fields.requirements, "");
});

test("validates a non-empty workstream path before writing the Project field", async () => {
  const validated = [];
  const { store } = fixture({
    workstreamStore: {
      async validate(workstream) {
        validated.push(workstream);
        return { path: workstream };
      },
    },
  });

  await store.setFields("item-1", {
    workstream: "lab/pan",
  });

  assert.deepEqual(validated, [
    "lab/pan",
  ]);
});

test("skips workstream validation when the field is empty", async () => {
  const validated = [];
  const { store } = fixture({
    workstreamStore: {
      async validate(workstream) {
        validated.push(workstream);
        return { path: workstream };
      },
    },
  });

  await store.setFields("item-1", {
    owner: "agent",
    workstream: "",
  });

  assert.deepEqual(validated, []);
});

test("rejects a non-empty workstream path that fails validation", async () => {
  const { store } = fixture({
    workstreamStore: {
      async validate(workstream) {
        throw new Error(`workstream ${workstream} not found`);
      },
    },
  });

  await assert.rejects(
    store.setFields("item-1", { workstream: "missing/path" }),
    /workstream missing\/path not found/,
  );
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

test("excludes closed Issue-backed items when filtering by open", async () => {
  const { store } = fixture({
    items: [
      makeItem({
        id: "open-ready",
        owner: "agent",
        status: "ready",
        state: "OPEN",
      }),
      makeItem({
        id: "undefined-ready",
        owner: "agent",
        status: "ready",
        state: undefined,
      }),
      makeItem({
        id: "empty-ready",
        owner: "agent",
        status: "ready",
        state: "",
      }),
      makeItem({
        id: "closed-ready",
        owner: "agent",
        status: "ready",
        state: "CLOSED",
      }),
      makeItem({
        id: "mixedcase-closed-ready",
        owner: "agent",
        status: "ready",
        state: "Closed",
      }),
      makeItem({
        id: "lower-closed-ready",
        owner: "agent",
        status: "ready",
        state: "closed",
      }),
    ],
  });

  assert.deepEqual(
    (await store.listByFilter({ owner: "agent", open: true })).map(
      (item) => item.id,
    ),
    ["open-ready", "undefined-ready", "empty-ready"],
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

test("reads every Project page in canonical order", async () => {
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

  const items = await store.listItems();

  assert.deepEqual(
    items.map((item) => item.id),
    ["item-3", "item-1", "item-2"],
  );
  assert.equal(items[0].createdAt, "2026-07-17T18:00:00Z");
  assert.equal(items[0].updatedAt, "2026-07-17T19:00:00Z");
  assert.deepEqual(items[0].assignees, ["octocat"]);
  assert.deepEqual(items[0].labels, ["urgent"]);
  assert.equal(items[0].comments[0].author, "octocat");
  assert.equal(
    gh.jsonCalls.filter(
      (args) =>
        valueAfterAssignment(args, "projectId") &&
        valueAfterAssignment(args, "query")?.includes("items(first:"),
    ).length,
    2,
  );
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
    store.listItems(),
    /exceeding the 2-entry read limit/,
  );
});

test("fails closed when an item has unpaged field values", async () => {
  const { store } = fixture({ truncatedFieldValues: true });

  await assert.rejects(store.getItem("item-1"), /cannot be read safely/);
});

test("rejects unreadable Project content and preserves supported non-Issue items", async () => {
  for (const option of [
    "truncatedAssignees",
    "truncatedLabels",
    "truncatedComments",
  ]) {
    const { store } = fixture({ [option]: true });
    await assert.rejects(store.listItems(), /cannot be read safely/, option);
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
  const items = await store.listItems();
  assert.deepEqual(
    items.map((item) => item.contentClassification),
    ["draft", "pull-request", "cross-domain-issue"],
  );
});

test("preserves Project read failures without fabricating comments", async () => {
  const { store } = fixture({ failProjectRead: true });

  await assert.rejects(
    store.listItems(),
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

test("aborts a claim on a closed Issue without writing any field or assignment", async () => {
  const { store, gh } = fixture({
    items: [makeItem({ status: "ready", state: "CLOSED" })],
  });

  const result = await store.claimWithLease({
    itemId: "item-1",
    runner: "runner-a",
    assignee: "octocat",
    leaseUntil: FUTURE,
  });

  assert.deepEqual(
    { claimed: result.claimed, reason: result.reason },
    { claimed: false, reason: "issue-closed" },
  );
  const item = await store.getItem("item-1");
  assert.equal(item.fields.claimedBy, "");
  assert.equal(item.fields.status, "ready");
  assert.equal(item.fields.leaseUntil, "");
  assert.deepEqual(gh.issueEdits, []);
  assert.equal(gh.projectEdits, 0);
});

test("releases the claim when the Issue closes between the claim write and its confirmation", async () => {
  const { store, gh } = fixture({
    items: [makeItem({ status: "ready" })],
    closeOnFieldEdit: true,
  });

  const result = await store.claimWithLease({
    itemId: "item-1",
    runner: "runner-a",
    assignee: "octocat",
    leaseUntil: FUTURE,
  });

  assert.deepEqual(
    { claimed: result.claimed, reason: result.reason },
    { claimed: false, reason: "issue-closed" },
  );
  const item = await store.getItem("item-1");
  // Runner-owned fields are cleared, but the quiet rollback must not write the
  // status field on the now-closed Issue.
  assert.equal(item.fields.claimedBy, "");
  assert.equal(item.fields.leaseUntil, "");
  assert.deepEqual(
    gh.projectFieldEdits.filter(
      (edit) => edit.field === "status" && edit.value === "ready",
    ),
    [],
    "the quiet rollback must not write status:ready on the closed Issue",
  );
  assert.deepEqual(
    gh.issueEdits.filter((e) => e.flag === "--add-assignee"),
    [],
  );
  assert.deepEqual(gh.issueComments, []);
});

test("releases the claim and reports issue-closed when confirmation fails on a now-closed Issue", async () => {
  const { store, gh } = fixture({
    items: [makeItem({ status: "ready" })],
    mismatchAndCloseOnFieldEdit: true,
  });
  const result = await store.claimWithLease({
    itemId: "item-1",
    runner: "runner-a",
    assignee: "octocat",
    leaseUntil: FUTURE,
  });
  assert.deepEqual(
    { claimed: result.claimed, reason: result.reason },
    { claimed: false, reason: "issue-closed" },
  );
  const item = await store.getItem("item-1");
  assert.equal(item.fields.claimedBy, "");
  assert.equal(item.fields.leaseUntil, "");
  assert.deepEqual(
    gh.projectFieldEdits.filter(
      (edit) => edit.field === "status" && edit.value === "ready",
    ),
    [],
    "the quiet rollback must not write status:ready on the closed Issue",
  );
  assert.deepEqual(
    gh.issueEdits.filter((e) => e.flag === "--add-assignee"),
    [],
  );
  assert.deepEqual(gh.issueComments, []);
});

test("tolerates a not-owner release during a closed rollback without throwing", async () => {
  const { store } = fixture({
    items: [makeItem({ status: "ready" })],
    stealClaimOnClose: true,
  });
  const result = await store.claimWithLease({
    itemId: "item-1",
    runner: "runner-a",
    assignee: "octocat",
    leaseUntil: FUTURE,
  });
  assert.deepEqual(
    { claimed: result.claimed, reason: result.reason },
    { claimed: false, reason: "issue-closed" },
  );
});

test("throws when the closed rollback release cannot be confirmed", async () => {
  const { store } = fixture({
    items: [makeItem({ status: "ready" })],
    failReleaseConfirmOnClose: true,
  });
  await assert.rejects(
    store.claimWithLease({
      itemId: "item-1",
      runner: "runner-a",
      assignee: "octocat",
      leaseUntil: FUTURE,
    }),
    /Claim rollback failed/,
  );
});

test("releases the claim without touching the assignee when the Issue closes at the assignee write", async () => {
  const { store, gh } = fixture({
    items: [makeItem({ status: "ready" })],
    closeOnAssign: true,
  });
  const result = await store.claimWithLease({
    itemId: "item-1",
    runner: "runner-a",
    assignee: "octocat",
    leaseUntil: FUTURE,
  });
  assert.notEqual(result.claimed, true);
  assert.deepEqual(
    { claimed: result.claimed, reason: result.reason },
    { claimed: false, reason: "issue-closed" },
  );
  const item = await store.getItem("item-1");
  assert.equal(item.fields.claimedBy, "");
  assert.equal(item.fields.leaseUntil, "");
  // The final-read closed path must NOT write status and must NOT remove the
  // assignee on the closed Issue; the stray assignee is left for recovery.
  assert.deepEqual(
    gh.projectFieldEdits.filter(
      (edit) => edit.field === "status" && edit.value === "ready",
    ),
    [],
    "the quiet rollback must not write status:ready on the closed Issue",
  );
  const assigneeEdits = gh.issueEdits.filter((e) => e.assignee === "octocat");
  assert.deepEqual(
    assigneeEdits.map((e) => e.flag),
    ["--add-assignee"],
    "no remove-assignee write may land on the closed Issue",
  );
});

test("does not write status:in-progress when the Issue closes before the status write", async () => {
  const { store, gh } = fixture({
    items: [makeItem({ status: "ready" })],
    closeOnFieldEdit: true,
  });

  const result = await store.claimWithLease({
    itemId: "item-1",
    runner: "runner-a",
    assignee: "octocat",
    leaseUntil: FUTURE,
  });

  assert.equal(result.claimed, false);
  assert.equal(result.reason, "issue-closed");
  const item = await store.getItem("item-1");
  assert.equal(item.fields.claimedBy, "");
  assert.equal(item.fields.leaseUntil, "");
  assert.deepEqual(
    gh.projectFieldEdits.filter(
      (edit) => edit.field === "status" && edit.value === "in-progress",
    ),
    [],
    "the phase-1 gate must abort before any status:in-progress write",
  );
  assert.deepEqual(
    gh.projectFieldEdits.filter(
      (edit) => edit.field === "status" && edit.value === "ready",
    ),
    [],
    "the quiet rollback must not write status:ready on the closed Issue",
  );
  assert.deepEqual(
    gh.issueEdits.filter((e) => e.flag === "--add-assignee"),
    [],
  );
});

test("releases the claim when confirmation succeeds but the Issue is already closed", async () => {
  const { store, gh } = fixture({
    items: [makeItem({ status: "ready" })],
    closeKeepingFieldsOnStatusWrite: true,
  });

  const result = await store.claimWithLease({
    itemId: "item-1",
    runner: "runner-a",
    assignee: "octocat",
    leaseUntil: FUTURE,
  });

  assert.equal(result.claimed, false);
  assert.equal(result.reason, "issue-closed");
  const item = await store.getItem("item-1");
  assert.equal(item.fields.claimedBy, "");
  assert.equal(item.fields.leaseUntil, "");
  assert.deepEqual(
    gh.projectFieldEdits.filter(
      (edit) => edit.field === "status" && edit.value === "ready",
    ),
    [],
    "the quiet rollback must not write status:ready on the closed Issue",
  );
  assert.deepEqual(
    gh.issueEdits.filter((e) => e.flag === "--add-assignee"),
    [],
  );
});

test("does not add an assignee when the Issue closes before the assignee write", async () => {
  const { store, gh } = fixture({
    items: [makeItem({ status: "ready" })],
    closeBeforeAssign: true,
  });

  const result = await store.claimWithLease({
    itemId: "item-1",
    runner: "runner-a",
    assignee: "octocat",
    leaseUntil: FUTURE,
  });

  assert.equal(result.claimed, false);
  assert.equal(result.reason, "issue-closed");
  const item = await store.getItem("item-1");
  assert.equal(item.fields.claimedBy, "");
  assert.equal(item.fields.leaseUntil, "");
  assert.deepEqual(
    gh.issueEdits.filter((e) => e.flag === "--add-assignee"),
    [],
    "the pre-add gate must abort before any --add-assignee write",
  );
  assert.deepEqual(
    gh.projectFieldEdits.filter(
      (edit) => edit.field === "status" && edit.value === "ready",
    ),
    [],
    "the quiet rollback must not write status:ready on the closed Issue",
  );
});

test("clears the just-written claim during a closed rollback even after the lease expires", async () => {
  let calls = 0;
  const now = () => {
    calls += 1;
    return calls === 1 ? NOW : new Date(NOW.getTime() + 3600_000);
  };
  const { store, gh } = fixture({
    items: [makeItem({ status: "ready" })],
    closeOnFieldEdit: true,
    now,
  });

  let result;
  await assert.doesNotReject(async () => {
    result = await store.claimWithLease({
      itemId: "item-1",
      runner: "runner-a",
      assignee: "octocat",
      leaseUntil: FUTURE,
    });
  });

  assert.equal(result.reason, "issue-closed");
  const item = await store.getItem("item-1");
  assert.equal(item.fields.claimedBy, "");
  assert.equal(item.fields.leaseUntil, "");
  assert.deepEqual(
    gh.projectFieldEdits.filter(
      (edit) => edit.field === "status" && edit.value === "in-progress",
    ),
    [],
  );
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

test("flags human attention without disturbing triage, lease, or assignees", async () => {
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
  });

  assert.equal(result.requested, true);
  assert.match(result.item.fields.needsHumanSince, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(result.item.fields.owner, "agent");
  assert.equal(result.item.fields.status, "in-progress");
  assert.equal(result.item.fields.priority, "low");
  assert.equal(result.item.fields.claimedBy, "runner-a");
  assert.equal(result.item.fields.leaseUntil, FUTURE);
  assert.deepEqual(gh.issueEdits, []);
});

test("refuses to flag attention for a task another runner holds", async () => {
  const { store } = fixture({
    items: [
      makeItem({
        owner: "agent",
        status: "in-progress",
        claimedBy: "runner-b",
        leaseUntil: FUTURE,
      }),
    ],
  });

  const result = await store.requestHumanAttention({
    itemId: "item-1",
    runner: "runner-a",
  });

  assert.equal(result.requested, false);
  assert.equal(result.reason, "not-owner");
  const item = await store.getItem("item-1");
  assert.equal(item.fields.needsHumanSince, "");
});

test("resolves human attention idempotently and leaves the lease intact", async () => {
  const { store, gh } = fixture({
    items: [
      makeItem({
        owner: "agent",
        status: "in-progress",
        priority: "low",
        claimedBy: "runner-a",
        leaseUntil: FUTURE,
        needsHumanSince: "2026-07-20T16:00:00Z",
      }),
    ],
  });

  await store.resolveHumanAttention({ itemId: "item-1", runner: "runner-a" });
  const result = await store.resolveHumanAttention({
    itemId: "item-1",
    runner: "runner-a",
  });

  assert.equal(result.resolved, true);
  assert.equal(result.item.fields.needsHumanSince, "");
  assert.equal(result.item.fields.status, "in-progress");
  assert.equal(result.item.fields.priority, "low");
  assert.equal(result.item.fields.claimedBy, "runner-a");
  assert.equal(result.item.fields.leaseUntil, FUTURE);
  assert.deepEqual(gh.issueEdits, []);
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

test("live classification registers every missing Issue without reopening closed work", async () => {
  const existing = makeItem({
    status: "in-progress",
    claimedBy: "runner-a",
    leaseUntil: FUTURE,
  });
  const issues = [
    repositoryIssue(1, "open"),
    repositoryIssue(2, "open"),
    repositoryIssue(3, "closed"),
  ];
  const { store, gh } = fixture({
    items: [existing],
    openIssues: issues,
  });

  const classified = await store.classify();

  assert.deepEqual(
    classified.map(({ issue, type, valid }) => ({
      number: issue.number,
      type,
      valid,
    })),
    [
      { number: 1, type: "task", valid: true },
      { number: 2, type: "task", valid: true },
      { number: 3, type: "task", valid: true },
    ],
  );
  assert.equal((await store.getItem("item-2")).fields.status, "untriaged");
  assert.equal((await store.getItem("item-3")).fields.status, "untriaged");
  const unchanged = await store.getItem("item-1");
  assert.equal(unchanged.fields.status, "in-progress");
  assert.equal(unchanged.fields.claimedBy, "runner-a");
  assert.equal(unchanged.fields.leaseUntil, FUTURE);
  assert.deepEqual(gh.issueStateEdits, []);
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
  workstreamStore,
  closeOnFieldEdit = false,
  mismatchAndCloseOnFieldEdit = false,
  closeOnAssign = false,
  stealClaimOnClose = false,
  failReleaseConfirmOnClose = false,
  closeKeepingFieldsOnStatusWrite = false,
  closeBeforeAssign = false,
  now = () => NOW,
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
    closeOnFieldEdit,
    mismatchAndCloseOnFieldEdit,
    closeOnAssign,
    stealClaimOnClose,
    failReleaseConfirmOnClose,
    closeKeepingFieldsOnStatusWrite,
    closeBeforeAssign,
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
      now,
      sleep: async () => {},
      workstreamStore,
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
      closeOnFieldEdit = false,
      mismatchAndCloseOnFieldEdit = false,
      closeOnAssign = false,
      stealClaimOnClose = false,
      failReleaseConfirmOnClose = false,
      closeKeepingFieldsOnStatusWrite = false,
      closeBeforeAssign = false,
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
    this.closeOnFieldEdit = closeOnFieldEdit;
    this.mismatchAndCloseOnFieldEdit = mismatchAndCloseOnFieldEdit;
    this.closeOnAssign = closeOnAssign;
    this.stealClaimOnClose = stealClaimOnClose;
    this.failReleaseConfirmOnClose = failReleaseConfirmOnClose;
    this.closeKeepingFieldsOnStatusWrite = closeKeepingFieldsOnStatusWrite;
    this.closeBeforeAssign = closeBeforeAssign;
    this.sawInProgressRead = false;
    this.issueCreates = [];
    this.issueEdits = [];
    this.issueStateEdits = [];
    this.issueComments = [];
    this.projectFieldEdits = [];
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
      const isClear = args.includes("--clear");
      const fieldId = valueAfter(args, "--field-id");
      const targetField = MANIFEST.fields.find(
        (candidate) => `field-${candidate.key}` === fieldId,
      );
      if (
        this.failReleaseConfirmOnClose &&
        isClear &&
        targetField?.key === "claimedBy"
      ) {
        // Sabotage ONLY the rollback release's clear of the runner-owned
        // claimed-by field: skip the actual clear so the value stays "runner-a"
        // and the release's own confirmation mismatches, yielding
        // release-not-confirmed (a non-not-owner failure the quiet rollback
        // must surface by throwing).
        this.projectEdits += 1;
        return "";
      }
      this.projectEdits += 1;
      this.#editProjectItem(args);
      if (this.closeOnFieldEdit) {
        const edited = this.items.find(
          (candidate) => candidate.id === valueAfter(args, "--id"),
        );
        if (edited?.content) {
          edited.content.state = "CLOSED";
        }
      }
      if (this.failReleaseConfirmOnClose) {
        const edited = this.items.find(
          (candidate) => candidate.id === valueAfter(args, "--id"),
        );
        if (edited?.content) {
          edited.content.state = "CLOSED";
        }
      }
      if (this.stealClaimOnClose) {
        const edited = this.items.find(
          (candidate) => candidate.id === valueAfter(args, "--id"),
        );
        if (edited) {
          edited["claimed-by"] = "runner-thief";
          if (edited.content) {
            edited.content.state = "CLOSED";
          }
        }
      }
      if (this.mismatchAndCloseOnFieldEdit) {
        const edited = this.items.find(
          (candidate) => candidate.id === valueAfter(args, "--id"),
        );
        if (edited?.Status === "in-progress") {
          edited.Status = "blocked";
          if (edited.content) {
            edited.content.state = "CLOSED";
          }
        }
      }
      if (this.closeKeepingFieldsOnStatusWrite) {
        // Close the Issue exactly when the Status field reaches "in-progress"
        // (the phase-2 write) but LEAVE Status = "in-progress" so #confirmFields
        // still matches every expected field and returns a confirmed item whose
        // .state is closed -- exercising the confirmed-but-closed guard.
        const edited = this.items.find(
          (candidate) => candidate.id === valueAfter(args, "--id"),
        );
        if (edited?.Status === "in-progress" && edited.content) {
          edited.content.state = "CLOSED";
        }
      }
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
      if (this.closeOnAssign && flag === "--add-assignee") {
        const closing = this.items.find(
          (candidate) => candidate.content?.number === Number(args[2]),
        );
        if (closing?.content) {
          closing.content.state = "CLOSED";
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
      if (
        this.closeBeforeAssign &&
        item &&
        item.Status === "in-progress" &&
        item["claimed-by"] &&
        this.issueEdits.every((edit) => edit.flag !== "--add-assignee")
      ) {
        // Let the phase-2 confirmation read observe the item OPEN, then close it
        // on the NEXT read of that item (the pre-add #requireItem), before any
        // --add-assignee write is recorded. This exercises the pre-add gate.
        if (!this.sawInProgressRead) {
          this.sawInProgressRead = true;
        } else if (item.content) {
          item.content.state = "CLOSED";
        }
      }
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
    // Record every field write together with whether the Issue was already
    // closed at the moment of the write, so tests can assert that no status (or
    // other) field write ever lands on a closed Issue during a rollback.
    const closedAtEdit = item.content?.state === "CLOSED";
    if (args.includes("--clear")) {
      this.projectFieldEdits.push({
        id: item.id,
        field: field.key,
        value: "",
        closedAtEdit,
      });
      item[field.name] = "";
      return;
    }
    if (field.type === "single_select") {
      const optionId = valueAfter(args, "--single-select-option-id");
      const value = field.options.find(
        (option) => `${field.key}-${option}` === optionId,
      );
      this.projectFieldEdits.push({
        id: item.id,
        field: field.key,
        value,
        closedAtEdit,
      });
      item[field.name] = value;
      return;
    }
    const value = valueAfter(args, "--text");
    this.projectFieldEdits.push({
      id: item.id,
      field: field.key,
      value,
      closedAtEdit,
    });
    item[field.name] = value;
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
  needsHumanSince = "",
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
    "needs-human-since": needsHumanSince,
    "lease-until": leaseUntil,
    "claimed-by": claimedBy,
    workstream,
  };
}

function repositoryIssue(number, state) {
  return {
    number,
    title: `Issue ${number}`,
    body: "",
    url: `https://github.com/AmoebaChant/pan-work/issues/${number}`,
    state,
    labels: [],
    createdAt: "2026-07-17T18:00:00Z",
    updatedAt: "2026-07-17T19:00:00Z",
    closedAt: state === "closed" ? "2026-07-17T19:00:00Z" : null,
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
