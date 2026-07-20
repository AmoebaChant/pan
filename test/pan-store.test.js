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
      options: ["untriaged", "ready", "in-progress"],
    },
    {
      key: "priority",
      name: "priority",
      type: "single_select",
      options: ["normal", "high"],
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
} = {}) {
  const gh = new FakeGh(items, {
    failAssignee,
    failProjectEdit,
    openIssues,
  });
  return {
    gh,
    store: new PanStore({
      repository: "AmoebaChant/pan-work",
      projectOwner: "AmoebaChant",
      projectNumber: 2,
      gh,
      manifest: MANIFEST,
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
    } = {},
  ) {
    this.items = structuredClone(items);
    this.failAssignee = failAssignee;
    this.failProjectEdit = failProjectEdit;
    this.openIssues = structuredClone(openIssues);
    this.issueCreates = [];
    this.issueEdits = [];
    this.issueComments = [];
    this.commentsByIssue = new Map();
    this.projectOrders = [];
    this.deletedIssues = [];
    this.projectEdits = 0;
    this.nextIssue = 2;
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
      if (this.failAssignee && flag === "--add-assignee") {
        throw new Error("assignment failed");
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
    if (args[0] === "project" && args[1] === "view") {
      return { id: "project-id", number: 2 };
    }
    if (args[0] === "project" && args[1] === "field-list") {
      return {
        fields: MANIFEST.fields.map((field) => ({
          id: `field-${field.key}`,
          name: field.name,
          type:
            field.type === "single_select"
              ? "ProjectV2SingleSelectField"
              : "ProjectV2Field",
          options: (field.options ?? []).map((option) => ({
            id: `${field.key}-${option}`,
            name: option,
          })),
        })),
      };
    }
    if (args[0] === "project" && args[1] === "item-list") {
      return { items: structuredClone(this.items) };
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
} = {}) {
  return {
    id,
    content: {
      number,
      title,
      body,
      state: "OPEN",
      url: `https://github.com/AmoebaChant/pan-work/issues/${number}`,
    },
    repository: "AmoebaChant/pan-work",
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
