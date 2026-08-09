import assert from "node:assert/strict";
import test from "node:test";

import { PanStore } from "../src/index.js";

const NOW = new Date("2026-07-17T20:00:00Z");
const FUTURE = "2026-07-17T20:10:00Z";
const THIEF_LEASE = "2099-12-31T23:59:59Z";
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

test("a closed rollback does not disturb a lease another runner legitimately holds", async () => {
  // The steal fires during runner-a's phase-1 runner-owned write: it flips
  // claimed-by to runner-thief, installs the thief's LIVE future lease, and
  // closes the Issue -- all BEFORE claimWithLease re-reads the Issue and drives
  // #quietClaimRollback. By the time the rollback runs, the item is owned by
  // runner-thief, so the rollback's release() hits its not-owner guard and
  // leaves the thief's fields completely untouched (no dead-lease machinery
  // is involved).
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
  // not-owner is tolerated exactly as before -- no throw.
  assert.deepEqual(
    { claimed: result.claimed, reason: result.reason },
    { claimed: false, reason: "issue-closed" },
  );
  const item = await store.getItem("item-1");
  // The thief's live claim is completely undisturbed by our rollback.
  assert.equal(item.fields.claimedBy, "runner-thief");
  assert.equal(item.fields.leaseUntil, THIEF_LEASE);
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

test("a mid-claim closed rollback whose release cannot be confirmed leaves a stranded (non-claimable) blank-lease claim on the closed Issue", async () => {
  // failReleaseConfirmOnClose makes the rollback release's claimed-by clear a
  // silent no-op (claimed-by stays runner-a) while its lease-until clear
  // succeeds (lease-until -> ""), and closes the Issue. release() then reports
  // release-not-confirmed, which #quietClaimRollback surfaces as a thrown
  // "Claim rollback failed". The resulting end-state is claimed-by=runner-a
  // with a BLANK lease on a CLOSED item. Under main semantics isExpired("") is
  // false, so this is NOT claimable -- it is a stranded runner-owned residual.
  // That is harmless debris rather than a live claim: a closed item is excluded
  // from every dispatch/claim/recovery path by the open filter and a mid-claim
  // failure leaves no resume pointer, so nothing ever acts on it while the
  // Issue stays closed; the real-world resume-pointer variant is reconciled by
  // the force-based closed reconciliation in #recoverResumeTasks.
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
  const item = await store.getItem("item-1");
  assert.equal(item.fields.claimedBy, "runner-a");
  assert.equal(item.fields.leaseUntil, "");
  // Documented residual: the stranded blank-lease claim is NOT claimable under
  // main semantics. We prove that through the claimable filter, which no longer
  // treats a blank lease as expired.
  assert.ok(
    !(await store.listByFilter({ claimable: true }))
      .map((entry) => entry.id)
      .includes("item-1"),
    "a stranded blank-lease claim on a closed Issue must not be claimable",
  );
});

test("a mid-claim closed rollback whose release THROWS leaves an unclaimed (claimable) item, not an immortal claim", async () => {
  // GAP 1: the reviewer required the mid-claim-closed rollback-semantics test to
  // cover BOTH failure modes. The failReleaseConfirmOnClose tests above cover
  // mode (a) -- release returns {released:false, reason:"release-not-confirmed"}.
  // This covers mode (b) -- the rollback release() THROWS. throwRollbackClear
  // closes the Issue on the phase-1 write (via closeOnFieldEdit) and then makes
  // the rollback release's lease-until clear throw. Because release() writes
  // claimed-by BEFORE lease-until, the claimed-by clear has already landed when
  // the throw fires, so the end state is claimed-by="" (UNCLAIMED). It is
  // claimable because it is unclaimed (the !claimedBy short-circuit in the
  // claimable filter), never an immortal claimed-by-set-with-live-lease. The
  // post-phase-1 site has no try/catch around #quietClaimRollback, so the throw
  // propagates and the claim call rejects.
  const { store } = fixture({
    items: [makeItem({ status: "ready" })],
    closeOnFieldEdit: true,
    throwRollbackClear: true,
  });
  await assert.rejects(
    store.claimWithLease({
      itemId: "item-1",
      runner: "runner-a",
      assignee: "octocat",
      leaseUntil: FUTURE,
    }),
    /rollback release write failed/,
  );
  const item = await store.getItem("item-1");
  // The end state is NOT an immortal claim: claimed-by was cleared before the
  // throw, so the item is UNCLAIMED and therefore claimable via the !claimedBy
  // short-circuit -- not because a blank lease is treated as expired.
  assert.equal(item.fields.claimedBy, "");
  assert.ok(
    (await store.listByFilter({ claimable: true }))
      .map((entry) => entry.id)
      .includes("item-1"),
    "an item left unclaimed by a thrown rollback must be claimable",
  );
});

// GAP 2: kill the {released:false} throw-guard AND the swallow-thrown-rollback
// mutation at each of the six #quietClaimRollback call sites in claimWithLease.
// Each site is reached by its own close-timing flag; failRollbackClear forces
// the rollback release to return {released:false} (mode a) and throwRollbackClear
// forces it to throw (mode b). The post-phase-1 site's mode (a) is already
// covered by "throws when the closed rollback release cannot be confirmed"
// (failReleaseConfirmOnClose) and its mode (b) by the GAP 1 test above.

test("site2 not-confirmed-closed guard throws when the rollback release is not confirmed", async () => {
  const { store } = fixture({
    items: [makeItem({ status: "ready" })],
    mismatchAndCloseOnFieldEdit: true,
    failRollbackClear: true,
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

test("site2 not-confirmed-closed guard propagates a thrown rollback release", async () => {
  const { store } = fixture({
    items: [makeItem({ status: "ready" })],
    mismatchAndCloseOnFieldEdit: true,
    throwRollbackClear: true,
  });
  await assert.rejects(
    store.claimWithLease({
      itemId: "item-1",
      runner: "runner-a",
      assignee: "octocat",
      leaseUntil: FUTURE,
    }),
    /rollback release write failed/,
  );
});

test("site3 confirmed-but-closed guard throws when the rollback release is not confirmed", async () => {
  const { store } = fixture({
    items: [makeItem({ status: "ready" })],
    closeKeepingFieldsOnStatusWrite: true,
    failRollbackClear: true,
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

test("site3 confirmed-but-closed guard propagates a thrown rollback release", async () => {
  const { store } = fixture({
    items: [makeItem({ status: "ready" })],
    closeKeepingFieldsOnStatusWrite: true,
    throwRollbackClear: true,
  });
  await assert.rejects(
    store.claimWithLease({
      itemId: "item-1",
      runner: "runner-a",
      assignee: "octocat",
      leaseUntil: FUTURE,
    }),
    /rollback release write failed/,
  );
});

test("site4 pre-assign-closed guard throws when the rollback release is not confirmed", async () => {
  const { store } = fixture({
    items: [makeItem({ status: "ready" })],
    closeBeforeAssign: true,
    failRollbackClear: true,
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

test("site4 pre-assign-closed guard propagates a thrown rollback release", async () => {
  const { store } = fixture({
    items: [makeItem({ status: "ready" })],
    closeBeforeAssign: true,
    throwRollbackClear: true,
  });
  await assert.rejects(
    store.claimWithLease({
      itemId: "item-1",
      runner: "runner-a",
      assignee: "octocat",
      leaseUntil: FUTURE,
    }),
    /rollback release write failed/,
  );
});

test("site5 assignment-failure-closed guard throws an AggregateError when the rollback is not confirmed", async () => {
  const { store } = fixture({
    items: [makeItem({ status: "ready" })],
    closeAndFailAssign: true,
    failRollbackClear: true,
  });
  await assert.rejects(
    store.claimWithLease({
      itemId: "item-1",
      runner: "runner-a",
      assignee: "octocat",
      leaseUntil: FUTURE,
    }),
    (err) =>
      err instanceof AggregateError && /after claiming the item/.test(err.message),
  );
});

test("site5 assignment-failure-closed try/catch wraps a thrown rollback in an AggregateError", async () => {
  const { store } = fixture({
    items: [makeItem({ status: "ready" })],
    closeAndFailAssign: true,
    throwRollbackClear: true,
  });
  await assert.rejects(
    store.claimWithLease({
      itemId: "item-1",
      runner: "runner-a",
      assignee: "octocat",
      leaseUntil: FUTURE,
    }),
    (err) =>
      err instanceof AggregateError && /rollback errored/.test(err.message),
  );
});

test("site6 final-read-closed guard throws when the rollback release is not confirmed", async () => {
  const { store } = fixture({
    items: [makeItem({ status: "ready" })],
    closeOnAssign: true,
    failRollbackClear: true,
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

test("site6 final-read-closed guard propagates a thrown rollback release", async () => {
  const { store } = fixture({
    items: [makeItem({ status: "ready" })],
    closeOnAssign: true,
    throwRollbackClear: true,
  });
  await assert.rejects(
    store.claimWithLease({
      itemId: "item-1",
      runner: "runner-a",
      assignee: "octocat",
      leaseUntil: FUTURE,
    }),
    /rollback release write failed/,
  );
});

test("a claimed item with any lease (blank or future) stays leased against a different runner", async () => {
  // Under main semantics isExpired("") is false, so a claimed item with a
  // blank lease is treated as LEASED, exactly like one with a future lease: a
  // DIFFERENT runner is blocked on both. This is the behavior that closes the
  // duplicate-claim window during the transient claimed-by=runner-a,
  // leaseUntil="" state of a healthy phase-1 claim.
  const { store } = fixture({
    items: [
      makeItem({ id: "blank", number: 1, claimedBy: "runner-a", leaseUntil: "" }),
      makeItem({
        id: "future",
        number: 2,
        claimedBy: "runner-a",
        leaseUntil: FUTURE,
      }),
    ],
  });
  const blankResult = await store.claimWithLease({
    itemId: "blank",
    runner: "runner-b",
    leaseUntil: FUTURE,
  });
  assert.deepEqual(
    { claimed: blankResult.claimed, reason: blankResult.reason },
    { claimed: false, reason: "leased" },
  );
  const futureResult = await store.claimWithLease({
    itemId: "future",
    runner: "runner-b",
    leaseUntil: LATER,
  });
  assert.deepEqual(
    { claimed: futureResult.claimed, reason: futureResult.reason },
    { claimed: false, reason: "leased" },
  );
});

test("two runners cannot both claim an OPEN task when the first has written claimedBy but not yet leaseUntil (duplicate-claim guard)", async () => {
  // T1 -- the mutation guard for reverting isExpired's blank branch. setFields
  // writes fields sequentially, claimedBy BEFORE leaseUntil (see
  // src/pan-store.js setFields / claimWithLease phase-1), so a healthy claim
  // passes through a transient claimed-by=runner-a, leaseUntil="" window on an
  // OPEN item. The onClaimedByWrite hook fires exactly in that window and drives
  // runner-b's claim attempt before runner-a's leaseUntil write lands. Under
  // main semantics isExpired("") is false, so runner-b sees the half-written
  // claim as LEASED and is blocked; exactly one runner ends up holding the
  // claim. If isExpired's blank branch is mutated back to `return true`,
  // runner-b would treat the transient state as claimable and BOTH runners
  // could return {claimed:true} -- duplicate execution. This test fails under
  // that mutation.
  const { store, gh } = fixture({
    items: [makeItem({ status: "ready" })],
  });
  let runnerBResult;
  gh.onClaimedByWrite = async (id) => {
    if (id !== "item-1") {
      return;
    }
    runnerBResult = await store.claimWithLease({
      itemId: "item-1",
      runner: "runner-b",
      assignee: "octocat",
      leaseUntil: LATER,
    });
  };
  const runnerAResult = await store.claimWithLease({
    itemId: "item-1",
    runner: "runner-a",
    assignee: "octocat",
    leaseUntil: FUTURE,
  });
  assert.equal(runnerAResult.claimed, true);
  assert.deepEqual(
    { claimed: runnerBResult.claimed, reason: runnerBResult.reason },
    { claimed: false, reason: "leased" },
  );
  const item = await store.getItem("item-1");
  assert.equal(item.fields.claimedBy, "runner-a");
  assert.equal(item.fields.leaseUntil, FUTURE);
});

test("release on a claimed blank-lease item succeeds under the owner check because a blank lease is not expired", async () => {
  // Under main semantics isExpired("") is false, so release() on a claimed item
  // whose claimed-by matches the caller passes the not-owner check and is NOT
  // treated as expired -> the guarded release succeeds without allowExpired.
  const { store } = fixture({
    items: [
      makeItem({
        id: "item-1",
        number: 1,
        claimedBy: "runner-a",
        leaseUntil: "",
        status: "in-progress",
      }),
    ],
  });
  const guarded = await store.release({ itemId: "item-1", runner: "runner-a" });
  assert.equal(guarded.released, true);
});

test("release()'s not-owner guard leaves a foreign claim untouched when ownership changed BEFORE release's read (pre-read steal)", async () => {
  // Documentation/pin test, no new production code. This covers ONLY the
  // PRE-READ steal: the stealClaimOnClose hook flips ownership to runner-thief
  // during runner-a's phase-1 write, i.e. BEFORE the subsequent
  // #quietClaimRollback release() reads the item. release() then reads the
  // already-stolen item and its not-owner guard fires, leaving the thief's live
  // claim completely untouched. This is byte-identical to origin/main.
  //
  // The POST-READ window -- ownership changing AFTER release() reads the item
  // but BEFORE it writes -- is the irreducible, pre-existing check-then-act
  // race inside release(). That race is byte-identical to origin/main and is
  // OUT OF SCOPE for this branch: this test does NOT exercise or fix it, and
  // must not be read as claiming to.
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
  const item = await store.getItem("item-1");
  assert.equal(item.fields.claimedBy, "runner-thief");
  assert.equal(item.fields.leaseUntil, THIEF_LEASE);
});

test("the claimable filter treats only an unclaimed item as claimable, not a blank-lease or future-lease claim", async () => {
  // Under main semantics a claim with any lease (blank or future) is NOT
  // claimable; only a genuinely unclaimed item (claimed-by="") is.
  const { store } = fixture({
    items: [
      makeItem({ id: "unclaimed", number: 1, owner: "agent", claimedBy: "" }),
      makeItem({
        id: "blank",
        number: 2,
        owner: "agent",
        claimedBy: "runner-a",
        leaseUntil: "",
      }),
      makeItem({
        id: "future",
        number: 3,
        owner: "agent",
        claimedBy: "runner-a",
        leaseUntil: FUTURE,
      }),
    ],
  });
  assert.deepEqual(
    (await store.listByFilter({ claimable: true })).map((entry) => entry.id),
    ["unclaimed"],
  );
});

test("heartbeat with a future lease still renews", async () => {
  const { store } = fixture({
    items: [
      makeItem({
        id: "item-1",
        number: 1,
        claimedBy: "runner-a",
        leaseUntil: FUTURE,
        status: "in-progress",
      }),
    ],
  });
  const result = await store.heartbeat({
    itemId: "item-1",
    runner: "runner-a",
    leaseUntil: LATER,
  });
  assert.equal(result.renewed, true);
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
  // assignee on the closed Issue; the stray assignee is deliberately left in
  // place (no remove-assignee write against a closed Issue, and closed-item
  // recovery passes no assignee) and is inert because the item is excluded
  // everywhere by the open filter.
  assert.deepEqual(
    gh.projectFieldEdits.filter(
      (edit) => edit.field === "status" && edit.value === "ready",
    ),
    [],
    "the quiet rollback must not write status:ready on the closed Issue",
  );
  assert.deepEqual(
    gh.projectFieldEdits.filter(
      (edit) => edit.field === "status" && edit.closedAtEdit,
    ),
    [],
    "no status field write may land on the Issue after it closed",
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

test("releases the claim when the Issue is observed closed only at the confirmation read", async () => {
  const { store, gh } = fixture({
    items: [makeItem({ status: "ready" })],
    closeOnlyAtConfirm: true,
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
    "the confirmed-but-closed gate must abort before any --add-assignee write",
  );
});

test("clears the just-written claim on the not-confirmed-closed path even after the lease expires", async () => {
  let calls = 0;
  const now = () => {
    calls += 1;
    return calls === 1 ? NOW : new Date(NOW.getTime() + 3600_000);
  };
  const { store } = fixture({
    items: [makeItem({ status: "ready" })],
    mismatchAndCloseOnFieldEdit: true,
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

  assert.deepEqual(
    { claimed: result.claimed, reason: result.reason },
    { claimed: false, reason: "issue-closed" },
  );
  const item = await store.getItem("item-1");
  assert.equal(item.fields.claimedBy, "");
  assert.equal(item.fields.leaseUntil, "");
});

test("clears the just-written claim on the confirmed-but-closed path even after the lease expires", async () => {
  let calls = 0;
  const now = () => {
    calls += 1;
    return calls === 1 ? NOW : new Date(NOW.getTime() + 3600_000);
  };
  const { store } = fixture({
    items: [makeItem({ status: "ready" })],
    closeOnlyAtConfirm: true,
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

  assert.deepEqual(
    { claimed: result.claimed, reason: result.reason },
    { claimed: false, reason: "issue-closed" },
  );
  const item = await store.getItem("item-1");
  assert.equal(item.fields.claimedBy, "");
  assert.equal(item.fields.leaseUntil, "");
});

test("clears the just-written claim on the pre-assign-closed path even after the lease expires", async () => {
  let calls = 0;
  const now = () => {
    calls += 1;
    return calls === 1 ? NOW : new Date(NOW.getTime() + 3600_000);
  };
  const { store } = fixture({
    items: [makeItem({ status: "ready" })],
    closeBeforeAssign: true,
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

  assert.deepEqual(
    { claimed: result.claimed, reason: result.reason },
    { claimed: false, reason: "issue-closed" },
  );
  const item = await store.getItem("item-1");
  assert.equal(item.fields.claimedBy, "");
  assert.equal(item.fields.leaseUntil, "");
});

test("clears the just-written claim on the final-read-closed path even after the lease expires", async () => {
  let calls = 0;
  const now = () => {
    calls += 1;
    return calls === 1 ? NOW : new Date(NOW.getTime() + 3600_000);
  };
  const { store } = fixture({
    items: [makeItem({ status: "ready" })],
    closeOnAssign: true,
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

  assert.deepEqual(
    { claimed: result.claimed, reason: result.reason },
    { claimed: false, reason: "issue-closed" },
  );
  const item = await store.getItem("item-1");
  assert.equal(item.fields.claimedBy, "");
  assert.equal(item.fields.leaseUntil, "");
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

test("quietly clears runner-owned fields when assignment fails on a now-closed Issue", async () => {
  const { store, gh } = fixture({
    items: [makeItem({ status: "ready" })],
    closeAndFailAssign: true,
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
  // Runner-owned fields are cleared, but the closed-Issue rollback must NOT
  // write status:ready back onto the closed Issue.
  assert.equal(item.fields.claimedBy, "");
  assert.equal(item.fields.leaseUntil, "");
  assert.deepEqual(
    gh.projectFieldEdits.filter(
      (edit) => edit.field === "status" && edit.value === "ready",
    ),
    [],
    "the assignment-failure rollback must not write status:ready on the closed Issue",
  );
});

test("clears the just-written claim when assignment fails on a closed Issue even after the lease expires", async () => {
  let calls = 0;
  const now = () => {
    calls += 1;
    return calls === 1 ? NOW : new Date(NOW.getTime() + 3600_000);
  };
  const { store } = fixture({
    items: [makeItem({ status: "ready" })],
    closeAndFailAssign: true,
    now,
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
  assert.equal(item.fields.claimedBy, "");
  assert.equal(item.fields.leaseUntil, "");
});

test("runs beforeWrite and reauthorizes during the claim's assignee-failure rollback", async () => {
  // The rollback that a failed assignee edit triggers performs its own
  // independent Project field mutations, so it must forward the caller's
  // beforeWrite hook and reauthorize per field like any other mutation.
  // beforeWrite fires three times for the claim field writes and once for the
  // assignee edit (four calls), then again for the rollback field writes.
  // Revoking the declaration on the fifth call — the rollback's first field
  // write — proves the rollback both ran beforeWrite and reauthorized: the
  // refusal aborts the rollback, so the item stays claimed. Without the hook
  // forwarded, beforeWrite would never reach a fifth call, the rollback would
  // proceed on stale authorization, and the failure would surface as the bare
  // assignment error instead.
  const workstreamStore = revocableWorkstreamStore();
  let beforeWriteCalls = 0;
  const beforeWrite = () => {
    beforeWriteCalls += 1;
    if (beforeWriteCalls === 5) {
      workstreamStore.revoke();
    }
  };
  const { store, gh } = fixture({
    items: [
      makeItem({
        id: "item-Wirder-10",
        number: 10,
        repository: WIRDER,
        workstream: "wirder",
        status: "ready",
      }),
    ],
    failAssignee: true,
    workstreamStore,
  });

  await assert.rejects(
    store.claimWithLease({
      itemId: "item-Wirder-10",
      runner: "runner-a",
      assignee: "octocat",
      leaseUntil: FUTURE,
      beforeWrite,
    }),
    /rollback/,
  );

  // The hook reached the rollback field writes (a fifth invocation), proving it
  // was forwarded into release.
  assert.equal(beforeWriteCalls, 5);
  // The three claim field writes reached the Project, but the rollback's first
  // field write was refused by the reauthorization and never did.
  assert.equal(gh.projectEdits, 3);
  // Because the rollback was refused, the item stays claimed rather than reset.
  const item = await store.getItem("item-Wirder-10");
  assert.equal(item.fields.claimedBy, "runner-a");
  assert.equal(item.fields.leaseUntil, FUTURE);
});

test("reauthorizes before assigning an external Issue when scope changes mid-claim", async () => {
  // Scope is derived from live workstream declarations. It authorizes the field
  // write, but a workstream change then revokes the declaration before the
  // separate assignee edit. That edit must reauthorize and be refused, so it
  // never reaches the external repository.
  const workstreamStore = scopeRevokingWorkstreamStore();
  const { store, gh } = fixture({
    items: [
      makeItem({
        id: "item-Wirder-10",
        number: 10,
        repository: WIRDER,
        workstream: "wirder",
        status: "ready",
      }),
    ],
    workstreamStore,
  });

  await assert.rejects(
    store.claimWithLease({
      itemId: "item-Wirder-10",
      runner: "runner-a",
      assignee: "octocat",
      leaseUntil: FUTURE,
    }),
    /Refusing to mutate|rollback/,
  );

  assert.equal(gh.issueEdits.length, 0);
});

test("reauthorizes before closing an external Issue when scope changes mid-release", async () => {
  // Closure is a distinct mutation from the field write that precedes it. If the
  // workstream declaration is revoked in between, the closure must reauthorize
  // and be refused, so the external Issue is never closed.
  const workstreamStore = scopeRevokingWorkstreamStore();
  const { store, gh } = fixture({
    items: [
      makeItem({
        id: "item-Wirder-10",
        number: 10,
        repository: WIRDER,
        workstream: "wirder",
        status: "in-progress",
        claimedBy: "runner-a",
        leaseUntil: FUTURE,
      }),
    ],
    workstreamStore,
  });

  await assert.rejects(
    store.release({
      itemId: "item-Wirder-10",
      runner: "runner-a",
      status: "done",
    }),
    /Refusing to mutate|could not be restored/,
  );

  assert.equal(gh.issueStateEdits.length, 0);
});

test("refuses a field write when beforeWrite revokes the declaration", async () => {
  // Scope is resolved immediately before the write, after beforeWrite runs. A
  // hook that drops the workstream declaration must therefore abort the field
  // edit before any Project mutation.
  const workstreamStore = revocableWorkstreamStore();
  const { store, gh } = fixture({
    items: [
      makeItem({
        id: "item-Wirder-10",
        number: 10,
        repository: WIRDER,
        workstream: "wirder",
        status: "ready",
      }),
    ],
    workstreamStore,
  });

  await assert.rejects(
    store.setFields(
      "item-Wirder-10",
      { status: "in-progress" },
      { beforeWrite: () => workstreamStore.revoke() },
    ),
    /Refusing to mutate/,
  );

  assert.equal(gh.projectEdits, 0);
});

test("authorizes each field write independently when scope is revoked mid-batch", async () => {
  // A multi-field write performs one Project mutation per field, and scope is
  // re-read live before each one. scopeRevokingWorkstreamStore declares WIRDER
  // on the first list() call (the first field's authorization) and nothing
  // afterward (the second field's authorization), so the first field is written
  // but the second must be refused rather than proceeding on the now-stale
  // authorization.
  const workstreamStore = scopeRevokingWorkstreamStore();
  const { store, gh } = fixture({
    items: [
      makeItem({
        id: "item-Wirder-10",
        number: 10,
        repository: WIRDER,
        workstream: "wirder",
        status: "untriaged",
        priority: "normal",
      }),
    ],
    workstreamStore,
  });

  await assert.rejects(
    store.setFields("item-Wirder-10", { status: "ready", priority: "high" }),
    /Refusing to mutate/,
  );

  // Exactly the first field was written; the second was refused after scope was
  // revoked, proving per-write authorization rather than one batch-wide check.
  assert.equal(gh.projectEdits, 1);
});

test("reauthorizes after beforeWrite before the assignee edit in a claim", async () => {
  // #editAssignee is a distinct mutation from the preceding field writes and
  // must run beforeWrite and reauthorize itself. beforeWrite fires once per
  // mutation: three times for the field writes, then a fourth time for the
  // assignee edit. Revoking the declaration on that fourth call leaves the field
  // writes authorized but forces the assignee edit to be refused, proving the
  // edit honored beforeWrite and re-checked scope.
  const workstreamStore = revocableWorkstreamStore();
  let beforeWriteCalls = 0;
  const beforeWrite = () => {
    beforeWriteCalls += 1;
    if (beforeWriteCalls === 4) {
      workstreamStore.revoke();
    }
  };
  const { store, gh } = fixture({
    items: [
      makeItem({
        id: "item-Wirder-10",
        number: 10,
        repository: WIRDER,
        workstream: "wirder",
        status: "ready",
      }),
    ],
    workstreamStore,
  });

  await assert.rejects(
    store.claimWithLease({
      itemId: "item-Wirder-10",
      runner: "runner-a",
      assignee: "octocat",
      leaseUntil: FUTURE,
      beforeWrite,
    }),
    /Refusing to mutate|rollback/,
  );

  // The three claim field writes succeeded, but the assignee edit never reached
  // the external repository.
  assert.equal(gh.projectEdits, 3);
  assert.equal(gh.issueEdits.length, 0);
});

test("reauthorizes after beforeWrite before closing the Issue in a release", async () => {
  // #closeIssue is a distinct mutation from the release field writes and must run
  // beforeWrite and reauthorize itself. beforeWrite fires three times for the
  // field writes, then a fourth time for the closure; revoking on that fourth
  // call leaves the fields written but forces the closure to be refused, so the
  // external Issue is never closed.
  const workstreamStore = revocableWorkstreamStore();
  let beforeWriteCalls = 0;
  const beforeWrite = () => {
    beforeWriteCalls += 1;
    if (beforeWriteCalls === 4) {
      workstreamStore.revoke();
    }
  };
  const { store, gh } = fixture({
    items: [
      makeItem({
        id: "item-Wirder-10",
        number: 10,
        repository: WIRDER,
        workstream: "wirder",
        status: "in-progress",
        claimedBy: "runner-a",
        leaseUntil: FUTURE,
      }),
    ],
    workstreamStore,
  });

  await assert.rejects(
    store.release({
      itemId: "item-Wirder-10",
      runner: "runner-a",
      status: "done",
      beforeWrite,
    }),
    /Refusing to mutate|could not be restored/,
  );

  assert.equal(gh.issueStateEdits.length, 0);
});

test("refuses a comment when beforeWrite revokes the declaration", async () => {
  const workstreamStore = revocableWorkstreamStore();
  const { store, gh } = fixture({
    items: [
      makeItem({
        id: "item-Wirder-10",
        number: 10,
        repository: WIRDER,
        workstream: "wirder",
      }),
    ],
    workstreamStore,
  });
  const item = await store.getItem("item-Wirder-10");

  await assert.rejects(
    store.addComment(item, "External update", {
      beforeWrite: () => workstreamStore.revoke(),
    }),
    /Refusing to mutate/,
  );

  assert.equal(gh.issueComments.length, 0);
});

test("refuses to add an Issue when beforeWrite revokes the declaration", async () => {
  const workstreamStore = revocableWorkstreamStore();
  const { store, gh } = fixture({
    items: [],
    workstreamStore,
  });

  await assert.rejects(
    store.addIssueToProject(externalIssue(WIRDER, 10, "open"), {
      beforeWrite: () => workstreamStore.revoke(),
    }),
    /Refusing to mutate/,
  );

  assert.equal(gh.projectEdits, 0);
  assert.equal(
    gh.jsonCalls.some(
      (args) => args[0] === "project" && args[1] === "item-add",
    ),
    false,
  );
});

test("refuses to remove an Issue when beforeWrite revokes the declaration", async () => {
  const workstreamStore = revocableWorkstreamStore();
  const { store, gh } = fixture({
    items: [
      makeItem({
        id: "item-Wirder-10",
        number: 10,
        repository: WIRDER,
        workstream: "wirder",
      }),
    ],
    workstreamStore,
  });

  await assert.rejects(
    store.removeItem("item-Wirder-10", {
      beforeWrite: () => workstreamStore.revoke(),
    }),
    /Refusing to mutate/,
  );

  assert.ok(gh.items.some((item) => item.id === "item-Wirder-10"));
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
      { number: 3, type: "closed", valid: false },
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

const WIRDER = "AmoebaChant/Wirder";
const BACKLOG_README = `# Wirder\n\n## Backlog repositories\n\n- ${WIRDER}\n`;

test("registers missing external backlog Issues as untriaged with the declaring workstream", async () => {
  const { store } = fixture({
    items: [],
    openIssues: [],
    workstreams: { wirder: BACKLOG_README },
    externalIssues: {
      [WIRDER]: [externalIssue(WIRDER, 10, "open"), externalIssue(WIRDER, 11, "closed")],
    },
  });

  const result = await store.registerMissingIssues();

  assert.deepEqual(
    result.map((item) => ({
      number: item.number,
      repository: item.repository,
      status: item.fields.status,
      workstream: item.fields.workstream,
    })),
    [
      { number: 10, repository: WIRDER, status: "untriaged", workstream: "wirder" },
      { number: 11, repository: WIRDER, status: "untriaged", workstream: "wirder" },
    ],
  );
  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(result.workstreamConflicts, []);
});

test("fails an external registration when its workstream declaration moves before the add", async () => {
  // The declaring workstream is resolved up front, but a beforeWrite hook moves
  // WIRDER from "wirder" to "gadgets" before the add. The live re-check must
  // reject the registration rather than add the item under the stale "wirder"
  // ownership: no Project item is added and no field is written.
  const workstreamStore = movingWorkstreamStore();
  const { store, gh } = fixture({
    items: [],
    workstreamStore,
    externalIssues: { [WIRDER]: [externalIssue(WIRDER, 10, "open")] },
  });

  await assert.rejects(
    store.registerMissingIssues({ beforeWrite: () => workstreamStore.move() }),
    /no longer maps uniquely/,
  );

  assert.equal(gh.projectEdits, 0);
  assert.equal(
    gh.items.some((item) => item.repository === WIRDER),
    false,
  );
  assert.equal(
    gh.jsonCalls.some(
      (args) => args[0] === "project" && args[1] === "item-add",
    ),
    false,
  );
});

test("leaves existing external backlog Project items unchanged", async () => {
  const existing = makeItem({
    id: "item-Wirder-10",
    number: 10,
    repository: WIRDER,
    workstream: "wirder",
  });
  const { store, gh } = fixture({
    items: [existing],
    workstreams: { wirder: BACKLOG_README },
    externalIssues: { [WIRDER]: [externalIssue(WIRDER, 10, "open")] },
  });

  const result = await store.registerMissingIssues();

  assert.deepEqual([...result], []);
  assert.deepEqual(result.workstreamConflicts, []);
  assert.equal(gh.projectEdits, 0);
  assert.equal((await store.getItem("item-Wirder-10")).fields.workstream, "wirder");
});

test("reports a conflicting external workstream without reassigning it", async () => {
  const existing = makeItem({
    id: "item-Wirder-10",
    number: 10,
    repository: WIRDER,
    workstream: "other-stream",
  });
  const { store, gh } = fixture({
    items: [existing],
    workstreams: { wirder: BACKLOG_README },
    externalIssues: { [WIRDER]: [externalIssue(WIRDER, 10, "open")] },
  });

  const result = await store.registerMissingIssues();

  assert.deepEqual([...result], []);
  assert.deepEqual(result.workstreamConflicts, [
    {
      url: `https://github.com/${WIRDER}/issues/10`,
      repository: WIRDER,
      expected: "wirder",
      actual: "other-stream",
    },
  ]);
  assert.equal(gh.projectEdits, 0);
  assert.equal(
    (await store.getItem("item-Wirder-10")).fields.workstream,
    "other-stream",
  );
});

test("diagnoses duplicate declarations of one repository and writes nothing for it", async () => {
  const { store, gh } = fixture({
    items: [],
    workstreams: {
      wirder: BACKLOG_README,
      gadgets: `# Gadgets\n\n## Backlog repositories\n\n- ${WIRDER}\n`,
    },
    externalIssues: { [WIRDER]: [externalIssue(WIRDER, 10, "open")] },
  });

  const result = await store.registerMissingIssues();

  assert.deepEqual([...result], []);
  assert.deepEqual(result.conflicts, [
    {
      repository: WIRDER,
      workstreams: ["gadgets", "wirder"],
      reason: "declared-by-multiple-workstreams",
    },
  ]);
  assert.equal(gh.projectEdits, 0);
});

test("does not treat undeclared Project repositories as domain backlog", async () => {
  const foreign = makeItem({
    id: "item-foreign",
    number: 7,
    repository: "other/repo",
    workstream: "",
  });
  const { store, gh } = fixture({
    items: [foreign],
    workstreams: { wirder: BACKLOG_README },
    externalIssues: {
      [WIRDER]: [externalIssue(WIRDER, 10, "open")],
      "other/repo": [externalIssue("other/repo", 7, "open")],
    },
  });

  const result = await store.registerMissingIssues();

  assert.deepEqual(
    result.map((item) => `${item.repository}#${item.number}`),
    [`${WIRDER}#10`],
  );
  assert.equal(gh.issueLists.includes("other/repo"), false);
  assert.equal((await store.getItem("item-foreign")).fields.workstream, "");
});

test("routes external backlog Issue mutations to the owning repository", async () => {
  const existing = makeItem({
    id: "item-Wirder-10",
    number: 10,
    repository: WIRDER,
    workstream: "wirder",
  });
  const { store, gh } = fixture({
    items: [existing],
    workstreams: { wirder: BACKLOG_README },
    externalIssues: { [WIRDER]: [externalIssue(WIRDER, 10, "open")] },
  });

  await store.addComment(await store.getItem("item-Wirder-10"), "External update");

  assert.deepEqual(gh.issueComments, [
    { number: 10, repository: WIRDER, body: "External update" },
  ]);
});

test("fails closed with no writes when a later repository inventory truncates", async () => {
  // The domain repository is inventoried before the declared external one. If
  // the external fetch hits the truncation safety limit, registration must make
  // zero writes rather than registering the domain Issues first and leaving the
  // external repository partially reconciled.
  const { store, gh } = fixture({
    items: [],
    openIssues: [repositoryIssue(3, "open")],
    workstreams: { wirder: BACKLOG_README },
    externalIssues: {
      [WIRDER]: [
        externalIssue(WIRDER, 10, "open"),
        externalIssue(WIRDER, 11, "open"),
      ],
    },
    projectItemSafetyLimit: 2,
  });

  await assert.rejects(store.registerMissingIssues(), /safety limit/);

  assert.equal(gh.projectEdits, 0);
  assert.equal(
    gh.items.some((item) => item.id === "item-3"),
    false,
  );
});

test("fails closed when the no-pagination fallback reaches a safety cap below 1000", async () => {
  // Without pagination support the fallback requests up to min(1000, safety
  // limit) Issues. Reaching that cap means the list may be truncated, so it must
  // fail closed. Here the safety limit (3) is the cap and the repository returns
  // exactly 3 once the mock honors --limit.
  const { store } = fixture({
    items: [],
    externalIssues: {
      [WIRDER]: [
        externalIssue(WIRDER, 10, "open"),
        externalIssue(WIRDER, 11, "open"),
        externalIssue(WIRDER, 12, "open"),
        externalIssue(WIRDER, 13, "open"),
      ],
    },
    projectItemSafetyLimit: 3,
    respectIssueListLimit: true,
  });

  await assert.rejects(
    store.listRepositoryIssues({ repository: WIRDER }),
    /safety limit/,
  );
});

test("succeeds when the no-pagination fallback stays below the safety cap", async () => {
  const { store } = fixture({
    items: [],
    externalIssues: {
      [WIRDER]: [
        externalIssue(WIRDER, 10, "open"),
        externalIssue(WIRDER, 11, "open"),
      ],
    },
    projectItemSafetyLimit: 3,
    respectIssueListLimit: true,
  });

  const issues = await store.listRepositoryIssues({ repository: WIRDER });

  assert.deepEqual(
    issues.map((issue) => issue.number),
    [10, 11],
  );
});

test("fails closed when the no-pagination fallback reaches the 1000-entry request cap", async () => {
  // The core regression: with a safety limit above 1000 (2000) the fallback caps
  // its request at 1000. A repository with more than 1000 Issues returns exactly
  // 1000 (the request cap), which must be treated as possible truncation and
  // fail closed even though 1000 is well below the 2000 safety limit.
  const many = Array.from({ length: 1500 }, (_unused, index) =>
    externalIssue(WIRDER, index + 1, "open"),
  );
  const { store } = fixture({
    items: [],
    externalIssues: { [WIRDER]: many },
    projectItemSafetyLimit: 2000,
    respectIssueListLimit: true,
  });

  await assert.rejects(
    store.listRepositoryIssues({ repository: WIRDER }),
    /safety limit/,
  );
});

test("fails closed when a workstream README is unreadable during discovery", async () => {
  const workstreamStore = {
    async list() {
      return {
        revision: "rev",
        complete: true,
        workstreams: [
          { path: "wirder", parent: undefined, children: [], sourcePath: "workstreams/wirder/README.md" },
          { path: "gadgets", parent: undefined, children: [], sourcePath: "workstreams/gadgets/README.md" },
        ],
        errors: [],
      };
    },
    async read(path) {
      if (path === "wirder") {
        return { path, content: BACKLOG_README };
      }
      throw new Error("network blip reading README");
    },
    async validate(path) {
      return { path };
    },
  };
  const { store, gh } = fixture({
    items: [],
    externalIssues: { [WIRDER]: [externalIssue(WIRDER, 10, "open")] },
    workstreamStore,
  });

  const result = await store.registerMissingIssues();

  assert.deepEqual([...result], []);
  assert.equal(gh.projectEdits, 0);
  assert.equal(gh.issueLists.includes(WIRDER), false);
  assert.ok(
    result.diagnostics.some((entry) => entry.code === "workstream-readme-unreadable"),
  );
});

test("fails closed when workstream discovery is incomplete", async () => {
  const workstreamStore = {
    async list() {
      return {
        revision: "rev",
        complete: false,
        workstreams: [
          { path: "wirder", parent: undefined, children: [], sourcePath: "workstreams/wirder/README.md" },
        ],
        errors: [{ path: "broken", reason: "Parent workstream broken has no README.md" }],
      };
    },
    async read(path) {
      return { path, content: BACKLOG_README };
    },
    async validate(path) {
      return { path };
    },
  };
  const { store, gh } = fixture({
    items: [],
    externalIssues: { [WIRDER]: [externalIssue(WIRDER, 10, "open")] },
    workstreamStore,
  });

  const result = await store.registerMissingIssues();

  assert.deepEqual([...result], []);
  assert.equal(gh.projectEdits, 0);
  assert.equal(gh.issueLists.includes(WIRDER), false);
  assert.ok(
    result.diagnostics.some((entry) => entry.code === "workstream-discovery-incomplete"),
  );
});

test("refuses to triage an undeclared Project item", async () => {
  const foreign = makeItem({
    id: "item-foreign",
    number: 7,
    repository: "other/repo",
    workstream: "",
  });
  const { store, gh } = fixture({
    items: [foreign],
    workstreams: { wirder: BACKLOG_README },
  });

  await assert.rejects(
    store.setFields("item-foreign", { status: "ready" }),
    /not the configured domain repository or a declared backlog repository/,
  );
  assert.equal(gh.projectEdits, 0);
});

test("refuses to claim an undeclared Project item", async () => {
  const foreign = makeItem({
    id: "item-foreign",
    number: 7,
    repository: "other/repo",
    workstream: "",
  });
  const { store, gh } = fixture({
    items: [foreign],
    workstreams: { wirder: BACKLOG_README },
  });

  await assert.rejects(
    store.claimWithLease({
      itemId: "item-foreign",
      runner: "runner-a",
      leaseUntil: FUTURE,
    }),
    /not the configured domain repository or a declared backlog repository/,
  );
  assert.equal(gh.projectEdits, 0);
});

test("classifies declared external tasks and flags undeclared Project items", async () => {
  const foreign = makeItem({
    id: "item-foreign",
    number: 7,
    repository: "other/repo",
    workstream: "",
  });
  const { store } = fixture({
    items: [foreign],
    workstreams: { wirder: BACKLOG_README },
    externalIssues: { [WIRDER]: [externalIssue(WIRDER, 10, "open")] },
  });

  const classified = await store.classify();

  const externalTask = classified.find(
    (entry) => entry.issue.repository === WIRDER,
  );
  assert.ok(externalTask, "declared external Issue should classify as a task");
  assert.equal(externalTask.type, "task");
  assert.equal(externalTask.valid, true);

  const undeclared = classified.find(
    (entry) => entry.code === "undeclared-project-item",
  );
  assert.ok(undeclared, "undeclared Project item should surface as a diagnostic");
  assert.equal(undeclared.valid, false);
  assert.equal(undeclared.issue.repository, "other/repo");

  assert.equal(
    classified.some(
      (entry) => entry.valid && entry.issue.repository === "other/repo",
    ),
    false,
  );
  assert.ok(Array.isArray(classified.diagnostics));
});

test("classifies a declared external closed Issue as non-actionable without reopening it", async () => {
  const { store, gh } = fixture({
    items: [],
    workstreams: { wirder: BACKLOG_README },
    externalIssues: {
      [WIRDER]: [
        externalIssue(WIRDER, 10, "open"),
        externalIssue(WIRDER, 11, "closed"),
      ],
    },
  });

  const classified = await store.classify();

  const openTask = classified.find(
    (entry) => entry.issue.repository === WIRDER && entry.issue.number === 10,
  );
  assert.ok(openTask, "open external Issue should classify");
  assert.equal(openTask.type, "task");
  assert.equal(openTask.valid, true);

  const closedTask = classified.find(
    (entry) => entry.issue.repository === WIRDER && entry.issue.number === 11,
  );
  assert.ok(closedTask, "closed external Issue should classify");
  assert.equal(closedTask.type, "closed");
  assert.equal(closedTask.valid, false);

  assert.deepEqual(gh.issueStateEdits, []);
});

test("refuses to register an Issue whose repository disagrees with its URL", async () => {
  const { store, gh } = fixture({
    items: [],
    workstreams: { wirder: BACKLOG_README },
  });

  await assert.rejects(
    store.addIssueToProject({
      number: 5,
      repository: WIRDER,
      url: "https://github.com/other/repo/issues/5",
      state: "open",
    }),
    /does not match its URL/,
  );
  assert.equal(gh.projectEdits, 0);
});

test("refuses to add an Issue outside the domain scope", async () => {
  const { store, gh } = fixture({
    items: [],
    workstreams: { wirder: BACKLOG_README },
  });

  await assert.rejects(
    store.addIssueToProject({
      number: 5,
      url: "https://github.com/other/repo/issues/5",
      state: "open",
    }),
    /not the configured domain repository or a declared backlog repository/,
  );
  assert.equal(gh.projectEdits, 0);
});

test("refuses to remove an undeclared Project item", async () => {
  const foreign = makeItem({
    id: "item-foreign",
    number: 7,
    repository: "other/repo",
    workstream: "",
  });
  const { store } = fixture({
    items: [foreign],
    workstreams: { wirder: BACKLOG_README },
  });

  await assert.rejects(
    store.removeItem("item-foreign"),
    /not the configured domain repository or a declared backlog repository/,
  );
});

test("refuses to remove a DraftIssue Project item", async () => {
  const draft = makeItem({
    id: "draft-1",
    contentType: "DraftIssue",
    repository: "other/repo",
  });
  const { store, gh } = fixture({ items: [draft] });

  await assert.rejects(
    store.removeItem("draft-1"),
    /only a configured-domain or declared backlog Issue item can be removed/,
  );
  assert.ok(gh.items.some((item) => item.id === "draft-1"));
});

test("refuses to remove a PullRequest Project item", async () => {
  const pull = makeItem({
    id: "pr-1",
    contentType: "PullRequest",
    repository: "other/repo",
  });
  const { store, gh } = fixture({ items: [pull] });

  await assert.rejects(
    store.removeItem("pr-1"),
    /only a configured-domain or declared backlog Issue item can be removed/,
  );
  assert.ok(gh.items.some((item) => item.id === "pr-1"));
});

test("refuses to remove an unreadable Project item", async () => {
  const unreadable = makeItem({ id: "opaque-1", contentType: null });
  const { store, gh } = fixture({ items: [unreadable] });

  await assert.rejects(
    store.removeItem("opaque-1"),
    /only a configured-domain or declared backlog Issue item can be removed/,
  );
  assert.ok(gh.items.some((item) => item.id === "opaque-1"));
});

test("removes a domain Issue Project item", async () => {
  const domain = makeItem({ id: "item-domain", number: 12, workstream: "" });
  const { store, gh } = fixture({ items: [domain] });

  const result = await store.removeItem("item-domain");

  assert.deepEqual(result, {
    removed: true,
    itemId: "item-domain",
    projectId: "project-id",
  });
  assert.equal(
    gh.items.some((item) => item.id === "item-domain"),
    false,
  );
});

function fixture({
  items = [makeItem()],
  failAssignee = false,
  failProjectEdit = false,
  openIssues = [],
  externalIssues = {},
  workstreams,
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
  respectIssueListLimit = false,
  closeOnFieldEdit = false,
  mismatchAndCloseOnFieldEdit = false,
  closeOnAssign = false,
  stealClaimOnClose = false,
  failReleaseConfirmOnClose = false,
  closeKeepingFieldsOnStatusWrite = false,
  closeBeforeAssign = false,
  closeOnlyAtConfirm = false,
  closeAndFailAssign = false,
  failRollbackClear = false,
  throwRollbackClear = false,
  now = () => NOW,
} = {}) {
  const gh = new FakeGh(items, {
    failAssignee,
    failProjectEdit,
    openIssues,
    externalIssues,
    truncatedFieldValues,
    truncatedAssignees,
    truncatedLabels,
    truncatedComments,
    failSchemaOnce,
    failProjectRead,
    failIssueClose,
    projectPageSize,
    respectIssueListLimit,
    closeOnFieldEdit,
    mismatchAndCloseOnFieldEdit,
    closeOnAssign,
    stealClaimOnClose,
    failReleaseConfirmOnClose,
    closeKeepingFieldsOnStatusWrite,
    closeBeforeAssign,
    closeOnlyAtConfirm,
    closeAndFailAssign,
    failRollbackClear,
    throwRollbackClear,
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
      workstreamStore: workstreamStore ?? makeWorkstreamStore(workstreams ?? {}),
    }),
  };
}

// A workstream store that declares WIRDER on the first discovery and nothing
// afterward, so scope authorizes an initial write but is revoked before any
// later independent mutation in the same operation.
function scopeRevokingWorkstreamStore() {
  let listCalls = 0;
  return {
    async list() {
      listCalls += 1;
      return {
        revision: "rev",
        complete: true,
        workstreams:
          listCalls === 1
            ? [
                {
                  path: "wirder",
                  parent: undefined,
                  children: [],
                  sourcePath: "workstreams/wirder/README.md",
                },
              ]
            : [],
        errors: [],
      };
    },
    async read(path) {
      return { path, content: BACKLOG_README };
    },
    async validate(path) {
      return { path };
    },
  };
}

// A workstream store that declares WIRDER until revoke() is called, letting a
// beforeWrite hook drop the declaration between the authorization that a caller
// resolves up front and the actual GitHub/Project mutation.
function revocableWorkstreamStore() {
  let revoked = false;
  return {
    revoke() {
      revoked = true;
    },
    async list() {
      return {
        revision: "rev",
        complete: true,
        workstreams: revoked
          ? []
          : [
              {
                path: "wirder",
                parent: undefined,
                children: [],
                sourcePath: "workstreams/wirder/README.md",
              },
            ],
        errors: [],
      };
    },
    async read(path) {
      return { path, content: BACKLOG_README };
    },
    async validate(path) {
      return { path };
    },
  };
}

// A workstream store that declares WIRDER under "wirder" until move() is called,
// after which it declares WIRDER under "gadgets" instead. The scope stays
// complete throughout, so a failed registration is due to the mapping moving to
// a different workstream, not to an incomplete read.
function movingWorkstreamStore() {
  let moved = false;
  return {
    move() {
      moved = true;
    },
    async list() {
      return {
        revision: "rev",
        complete: true,
        workstreams: [
          {
            path: moved ? "gadgets" : "wirder",
            parent: undefined,
            children: [],
            sourcePath: `workstreams/${moved ? "gadgets" : "wirder"}/README.md`,
          },
        ],
        errors: [],
      };
    },
    async read(path) {
      return { path, content: BACKLOG_README };
    },
    async validate(path) {
      return { path };
    },
  };
}

function makeWorkstreamStore(readmes) {  const entries = Object.entries(readmes);
  return {
    async list() {
      return {
        revision: "rev",
        complete: true,
        workstreams: entries.map(([path]) => ({
          path,
          parent: path.includes("/")
            ? path.slice(0, path.lastIndexOf("/"))
            : undefined,
          children: [],
          sourcePath: `workstreams/${path}/README.md`,
        })),
        errors: [],
      };
    },
    async read(path) {
      if (!(path in readmes)) {
        throw new Error(`workstream ${path} not found`);
      }
      return {
        path,
        sourcePath: `workstreams/${path}/README.md`,
        content: readmes[path],
      };
    },
    async validate(path) {
      return { path };
    },
  };
}

class FakeGh {
  constructor(
    items,
    {
      failAssignee = false,
      failProjectEdit = false,
      openIssues = [],
      externalIssues = {},
      truncatedFieldValues = false,
      truncatedAssignees = false,
      truncatedLabels = false,
      truncatedComments = false,
      failSchemaOnce = false,
      failProjectRead = false,
      projectPageSize,
      failIssueClose = false,
      respectIssueListLimit = false,
      closeOnFieldEdit = false,
      mismatchAndCloseOnFieldEdit = false,
      closeOnAssign = false,
      stealClaimOnClose = false,
      failReleaseConfirmOnClose = false,
      closeKeepingFieldsOnStatusWrite = false,
      closeBeforeAssign = false,
      closeOnlyAtConfirm = false,
      closeAndFailAssign = false,
      failRollbackClear = false,
      throwRollbackClear = false,
    } = {},
  ) {
    this.items = structuredClone(items);
    this.failAssignee = failAssignee;
    this.failProjectEdit = failProjectEdit;
    this.openIssues = structuredClone(openIssues);
    this.externalIssues = structuredClone(externalIssues);
    this.truncatedFieldValues = truncatedFieldValues;
    this.truncatedAssignees = truncatedAssignees;
    this.truncatedLabels = truncatedLabels;
    this.truncatedComments = truncatedComments;
    this.schemaFailures = failSchemaOnce ? 1 : 0;
    this.failProjectRead = failProjectRead;
    this.projectPageSize = projectPageSize;
    this.failIssueClose = failIssueClose;
    this.respectIssueListLimit = respectIssueListLimit;
    this.closeOnFieldEdit = closeOnFieldEdit;
    this.mismatchAndCloseOnFieldEdit = mismatchAndCloseOnFieldEdit;
    this.closeOnAssign = closeOnAssign;
    this.stealClaimOnClose = stealClaimOnClose;
    this.failReleaseConfirmOnClose = failReleaseConfirmOnClose;
    this.closeKeepingFieldsOnStatusWrite = closeKeepingFieldsOnStatusWrite;
    this.closeBeforeAssign = closeBeforeAssign;
    this.closeOnlyAtConfirm = closeOnlyAtConfirm;
    this.closeAndFailAssign = closeAndFailAssign;
    this.failRollbackClear = failRollbackClear;
    this.throwRollbackClear = throwRollbackClear;
    this.confirmCloseFired = false;
    this.sawInProgressRead = false;
    this.issueCreates = [];
    this.issueEdits = [];
    this.issueLists = [];
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
      const editTarget = this.items.find(
        (candidate) => candidate.id === valueAfter(args, "--id"),
      );
      const editTargetClosed = editTarget?.content?.state === "CLOSED";
      if (
        this.failRollbackClear &&
        isClear &&
        targetField?.key === "claimedBy" &&
        editTargetClosed
      ) {
        // Generic rollback-release-fails hook: skip ONLY the rollback release's
        // claimed-by clear once the Issue is CLOSED (the rollback runs only on a
        // closed Issue). The lease-until clear still succeeds, so the release's
        // own confirmation mismatches -> release-not-confirmed ({released:false},
        // reason !== "not-owner"), which each call site's throw-guard must
        // surface. Unlike failReleaseConfirmOnClose this does not itself close
        // the Issue, so it composes with any close-timing flag to reach any of
        // the six #quietClaimRollback call sites.
        this.projectEdits += 1;
        return "";
      }
      if (
        this.throwRollbackClear &&
        isClear &&
        targetField?.key === "leaseUntil" &&
        editTargetClosed
      ) {
        // Generic rollback-release-fails hook: make the rollback release's
        // lease-until clear THROW on a closed Issue. release() writes claimed-by
        // BEFORE lease-until, so by the time this throws the claimed-by clear has
        // already landed (claimed-by=""); the throw leaves lease-until untouched.
        // The end state is therefore claimed-by="" (unclaimed => claimable),
        // never an immortal claim. Composes with any close-timing flag to make
        // any of the six call sites observe a THROWN rollback.
        this.projectEdits += 1;
        throw new Error("rollback release write failed");
      }
      this.projectEdits += 1;
      this.#editProjectItem(args);
      if (
        this.onClaimedByWrite &&
        !isClear &&
        targetField?.key === "claimedBy"
      ) {
        // Interleaving hook for the duplicate-claim guard (T1): fire exactly
        // when runner-a's phase-1 claimed-by write has landed but its
        // lease-until write has NOT yet (setFields writes claimedBy before
        // leaseUntil, so the store is observably claimed-by=runner-a,
        // lease-until="" at this instant). The test drives runner-b's claim
        // from inside this callback to model the true race.
        const hook = this.onClaimedByWrite;
        this.onClaimedByWrite = null;
        await hook(valueAfter(args, "--id"));
      }
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
        // One-shot: steal + close only on the phase-1 lease-until write while
        // the Issue is still open. Firing on the lease-until write (which runs
        // AFTER #editProjectItem set lease-until to runner-a's value) lets the
        // thief's own distinct live lease survive phase-1. Guarding on "still
        // open" means later edits (e.g. the rollback's own writes) never
        // re-establish the thief, so a stomp of the thief's lease during
        // rollback stays observable instead of being masked by a re-steal.
        if (
          edited &&
          targetField?.key === "leaseUntil" &&
          edited.content?.state !== "CLOSED"
        ) {
          edited["claimed-by"] = "runner-thief";
          // The thief holds a concrete LIVE (future) lease, distinct from
          // runner-a's phase-1 lease value, so a rollback that wrongly stomped
          // the thief's lease would be observable in tests.
          edited["lease-until"] = THIEF_LEASE;
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
      if (this.closeAndFailAssign && flag === "--add-assignee") {
        // Close the Issue during the --add-assignee attempt and then fail the
        // write, so the assignment-failure catch reads a CLOSED Issue and must
        // take the quiet runner-owned-clear path (never status:ready).
        const closing = this.items.find(
          (candidate) => candidate.content?.number === Number(args[2]),
        );
        if (closing?.content) {
          closing.content.state = "CLOSED";
        }
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
      const repository = valueAfter(args, "--repo");
      this.issueLists.push(repository);
      const all =
        repository === "AmoebaChant/pan-work"
          ? structuredClone(this.openIssues)
          : structuredClone(this.externalIssues[repository] ?? []);
      // Opt-in: emulate `gh issue list --limit N` truncating the result set, so
      // tests can drive the no-pagination fallback to its request cap. Off by
      // default so existing tests keep receiving the full array.
      if (this.respectIssueListLimit) {
        const limit = Number(valueAfter(args, "--limit"));
        if (Number.isInteger(limit) && limit >= 0) {
          return all.slice(0, limit);
        }
      }
      return all;
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
      const match = issueUrl.match(
        /github\.com\/([^/]+\/[^/]+)\/issues\/(\d+)/,
      );
      const repository = match[1];
      const number = Number(match[2]);
      if (repository === "AmoebaChant/pan-work") {
        const created = this.issueCreates.find(
          (_issue, index) => index + 2 === number,
        );
        const openIssue = this.openIssues.find(
          (issue) => issue.number === number,
        );
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
      const externalIssue = (this.externalIssues[repository] ?? []).find(
        (issue) => issue.number === number,
      );
      const item = makeItem({
        id: `item-${repository.replace("/", "-")}-${number}`,
        number,
        title: externalIssue?.title,
        body: externalIssue?.body,
        repository,
        state: externalIssue?.state === "closed" ? "CLOSED" : "OPEN",
        workstream: "",
      });
      this.items.push(item);
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
      if (
        this.closeOnlyAtConfirm &&
        item &&
        item.Status === "in-progress" &&
        item["claimed-by"]
      ) {
        // Make the item observed CLOSED ONLY at the #confirmFields read (the
        // first item read after the phase-2 status write), then reopen it on
        // every subsequent read (pre-assign / final). This isolates the
        // confirmed-but-closed guard (path 3) as the sole closure observer.
        if (!this.confirmCloseFired) {
          this.confirmCloseFired = true;
          if (item.content) {
            item.content.state = "CLOSED";
          }
        } else if (item.content && item.content.state === "CLOSED") {
          item.content.state = "OPEN";
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

function externalIssue(repository, number, state) {
  return {
    number,
    title: `Issue ${number}`,
    body: "",
    url: `https://github.com/${repository}/issues/${number}`,
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
