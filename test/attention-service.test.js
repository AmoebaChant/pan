import assert from "node:assert/strict";
import test from "node:test";

import {
  AttentionService,
  formatNeedsHuman,
  latestNeedsHuman,
} from "../src/index.js";

test("lists unresolved attention and in-review work with locators", async () => {
  const blocked = makeItem({ status: "blocked" });
  const review = makeItem({ id: "item-2", number: 2, status: "in-review" });
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
  store.commentMap.set(review.id, [
    {
      body: [
        "<!-- pan:runner-result -->",
        "Pull request: https://github.com/example/tool/pull/42",
      ].join("\n"),
    },
  ]);

  const entries = await new AttentionService({ store }).inbox();
  const blockedEntry = entries.find((entry) => entry.id === 1);
  const reviewEntry = entries.find((entry) => entry.id === 2);

  assert.equal(entries.length, 2);
  assert.equal(blockedEntry.locator.localUrl, "http://localhost:3000");
  assert.equal(
    reviewEntry.pullRequestUrl,
    "https://github.com/example/tool/pull/42",
  );
});

test("answers pending attention and returns blocked work to triage", async () => {
  const item = makeItem({ status: "blocked" });
  const store = new FakeStore([item]);
  store.commentMap.set(item.id, [
    {
      body: formatNeedsHuman({
        kind: "question",
        prompt: "Choose an option.",
        locator: { machine: "machine-a" },
      }),
    },
  ]);

  await new AttentionService({ store }).answer(item.number, "Use option A.");

  assert.equal(item.fields.status, "untriaged");
  assert.equal(
    latestNeedsHuman(store.commentMap.get(item.id)),
    undefined,
  );
  assert.match(store.commentMap.get(item.id).at(-1).body, /Use option A/);
});

test("retries the field transition after an answer comment already landed", async () => {
  const item = makeItem({ status: "blocked" });
  const store = new FakeStore([item]);
  store.commentMap.set(item.id, [
    {
      body: formatNeedsHuman({
        kind: "question",
        prompt: "Choose an option.",
        locator: { machine: "machine-a" },
      }),
    },
    { body: "<!-- pan:answer -->\n### Answer\n\nUse option A." },
  ]);

  await new AttentionService({ store }).answer(item.number, "Use option A.");

  assert.equal(item.fields.status, "untriaged");
  assert.equal(store.commentMap.get(item.id).length, 2);
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
} = {}) {
  return {
    id,
    number,
    title: `Task ${number}`,
    body: "Do it.",
    url: `https://github.com/example/data/issues/${number}`,
    state: "open",
    requirements,
    fields: {
      status,
      owner,
      priority,
      requirements: requirements.join("\n"),
      autonomy,
      workstream,
    },
  };
}
