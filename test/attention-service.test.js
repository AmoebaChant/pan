import assert from "node:assert/strict";
import test from "node:test";

import {
  AttentionService,
  formatNeedsHuman,
  latestNeedsHuman,
} from "../src/index.js";

test("lists unresolved attention and in-review work with locators", async () => {
  const blocked = makeItem({ status: "blocked" });
  const review = makeItem({
    id: "item-2",
    number: 2,
    status: "in-review",
    linkedPullRequests: [
      {
        url: "https://github.com/example/tool/pull/42",
        state: "open",
      },
    ],
  });
  const store = new FakeStore([blocked, review]);
  store.commentMap.set(blocked.id, [
    {
      body: formatNeedsHuman({
        kind: "local-ui",
        prompt: "Inspect the preview.",
        locator: { machine: "machine-a", localUrl: "http://localhost:3000" },
      }),
    },
  ]);
  const entries = await new AttentionService({
    store,
    humanAssignee: "octocat",
  }).inbox();
  const blockedEntry = entries.find((entry) => entry.id === 1);
  const reviewEntry = entries.find((entry) => entry.id === 2);

  assert.equal(entries.length, 2);
  assert.equal(blockedEntry.locator.localUrl, "http://localhost:3000");
  assert.equal(
    reviewEntry.pullRequestUrl,
    "https://github.com/example/tool/pull/42",
  );
});

test("answers pending attention and restores agent work to ready", async () => {
  const item = makeItem({
    status: "blocked",
    owner: "human",
    priority: "urgent",
  });
  const store = new FakeStore([item]);
  store.commentMap.set(item.id, [
    {
      body: formatNeedsHuman({
        kind: "question",
        prompt: "Choose an option.",
        locator: { machine: "machine-a" },
        priorState: {
          status: "in-progress",
          owner: "agent",
          priority: "high",
        },
        resume: { affinity: "resume:machine-a/pan-development" },
      }),
    },
  ]);

  await new AttentionService({
    store,
    humanAssignee: "octocat",
  }).answer(item.number, "Use option A.");

  assert.equal(item.fields.status, "ready");
  assert.equal(item.fields.owner, "agent");
  assert.equal(item.fields.priority, "high");
  assert.equal(
    item.fields.claimedBy,
    "resume:machine-a/pan-development",
  );
  assert.equal(
    latestNeedsHuman(store.commentMap.get(item.id)),
    undefined,
  );
  assert.match(store.commentMap.get(item.id).at(-2).body, /Use option A/);
});

test("retries the attention resolution after an answer comment already landed", async () => {
  const item = makeItem({
    status: "blocked",
    owner: "human",
    priority: "urgent",
  });
  const store = new FakeStore([item]);
  store.commentMap.set(item.id, [
    {
      body: formatNeedsHuman({
        kind: "question",
        prompt: "Choose an option.",
        locator: { machine: "machine-a" },
        priorState: {
          status: "in-progress",
          owner: "agent",
          priority: "normal",
        },
      }),
    },
    { body: "<!-- pan:answer -->\n### Answer\n\nUse option A." },
  ]);

  await new AttentionService({
    store,
    humanAssignee: "octocat",
  }).answer(item.number, "Use option A.");

  assert.equal(item.fields.status, "ready");
  assert.equal(store.commentMap.get(item.id).length, 3);
});

test("requests urgent human attention once with resumable prior state", async () => {
  const item = makeItem({
    status: "in-progress",
    owner: "agent",
    priority: "low",
  });
  item.fields.claimedBy = "machine-a/pan-development/slot-1";
  const store = new FakeStore([item]);
  const service = new AttentionService({
    store,
    humanAssignee: "octocat",
  });
  const record = {
    kind: "question",
    prompt: "Which API should this use?",
    locator: { machine: "machine-a" },
  };

  await service.request(item, record, {
    runner: item.fields.claimedBy,
    runnerAssignee: "runner-bot",
    resumeAffinity: "resume:machine-a/pan-development",
  });
  await service.request(item, record, {
    runner: item.fields.claimedBy,
    runnerAssignee: "runner-bot",
    resumeAffinity: "resume:machine-a/pan-development",
  });

  assert.equal(store.commentMap.get(item.id).length, 1);
  assert.equal(item.fields.status, "blocked");
  assert.equal(item.fields.owner, "human");
  assert.equal(item.fields.priority, "urgent");
  assert.equal(store.humanAssignee, "octocat");
});

test("creates an untriaged backlog item", async () => {
  const store = new FakeStore([]);

  const item = await new AttentionService({ store }).add({
    title: "New task",
    body: "Acceptance criteria.",
    workstream: "orchestration/pan",
    requirements: ["repo:example/tool"],
  });

  assert.equal(item.fields.status, "untriaged");
  assert.deepEqual(item.requirements, ["repo:example/tool"]);
});

class FakeStore {
  constructor(items) {
    this.items = items;
    this.commentMap = new Map();
  }

  async listItems() {
    return this.items;
  }

  async listComments(item) {
    return this.commentMap.get(item.id) ?? [];
  }

  async addComment(item, body) {
    const comments = this.commentMap.get(item.id) ?? [];
    comments.push({ body });
    this.commentMap.set(item.id, comments);
  }

  async setFields(itemId, fields) {
    Object.assign(
      this.items.find((item) => item.id === itemId).fields,
      fields,
    );
  }

  async requestHumanAttention({ itemId, humanAssignee }) {
    const item = this.items.find((candidate) => candidate.id === itemId);
    Object.assign(item.fields, {
      claimedBy: "",
      leaseUntil: "",
      status: "blocked",
      owner: "human",
      priority: "urgent",
    });
    this.humanAssignee = humanAssignee;
    return { requested: true, item };
  }

  async resolveHumanAttention({
    itemId,
    priority,
    resumeAffinity,
  }) {
    const item = this.items.find((candidate) => candidate.id === itemId);
    Object.assign(item.fields, {
      claimedBy: resumeAffinity ?? "",
      leaseUntil: "",
      status: "ready",
      owner: "agent",
      priority,
    });
    return { resolved: true, item };
  }

  async createItem({ title, body, fields }) {
    const item = makeItem({
      id: "item-created",
      number: 3,
      status: fields.status,
      owner: fields.owner,
      priority: fields.priority,
      requirements: fields.requirements,
      autonomy: fields.autonomy,
      workstream: fields.workstream,
    });
    item.title = title;
    item.body = body;
    this.items.push(item);
    return item;
  }
}

function makeItem({
  id = "item-1",
  number = 1,
  status = "ready",
  owner = "agent",
  priority = "normal",
  requirements = ["repo:example/tool"],
  autonomy = "full-auto",
  workstream = "orchestration/pan",
  linkedPullRequests = [],
} = {}) {
  return {
    id,
    number,
    title: `Task ${number}`,
    body: "Do it.",
    url: `https://github.com/example/data/issues/${number}`,
    state: "open",
    linkedPullRequests,
    requirements,
    fields: {
      status,
      owner,
      priority,
      requirements: requirements.join("\n"),
      autonomy,
      workstream,
      claimedBy: "",
      leaseUntil: "",
    },
  };
}
