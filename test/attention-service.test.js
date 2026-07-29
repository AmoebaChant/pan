import assert from "node:assert/strict";
import test from "node:test";

import { AttentionService, latestNeedsHuman } from "../src/index.js";

test("asks for a human once and leaves the task with its worker", async () => {
  const item = makeItem();
  const store = new FakeStore(item);
  const service = new AttentionService({ store });
  const record = {
    kind: "question",
    prompt: "Which API should this use?",
    locator: { machine: "machine-a" },
  };
  const options = {
    runner: item.fields.claimedBy,
    resumeAffinity: "resume:machine-a/pan-development",
  };

  await service.request(item, record, options);
  await service.request(item, record, options);

  assert.equal(store.comments.length, 1);
  assert.equal(item.fields.needsHumanSince, "2026-07-20T16:00:00Z");
  assert.equal(item.fields.status, "in-progress");
  assert.equal(item.fields.owner, "agent");
  assert.equal(item.fields.priority, "low");
  assert.equal(item.fields.claimedBy, "machine-a/pan-development/slot-1");
  assert.equal(item.fields.leaseUntil, "2026-07-20T16:30:00Z");
  assert.equal(
    latestNeedsHuman(store.comments).resume.affinity,
    "resume:machine-a/pan-development",
  );
});

test("resolving clears the flag and records the answer", async () => {
  const item = makeItem();
  const store = new FakeStore(item);
  const service = new AttentionService({ store });
  await service.request(
    item,
    { kind: "question", prompt: "Which API should this use?" },
    { runner: item.fields.claimedBy },
  );

  await service.resolve(item, { runner: item.fields.claimedBy });

  assert.equal(item.fields.needsHumanSince, "");
  assert.equal(item.fields.status, "in-progress");
  assert.equal(item.fields.claimedBy, "machine-a/pan-development/slot-1");
  assert.equal(latestNeedsHuman(store.comments), undefined);
});

test("reports a refused transition as an attention failure", async () => {
  const item = makeItem();
  const store = new FakeStore(item);
  store.refuse = true;
  const service = new AttentionService({ store });

  await assert.rejects(
    service.request(
      item,
      { kind: "question", prompt: "Which API should this use?" },
      { runner: "someone-else" },
    ),
    (error) => error.code === "PAN_ATTENTION_TRANSITION_FAILED",
  );
});

class FakeStore {
  constructor(item) {
    this.item = item;
    this.comments = [];
    this.refuse = false;
  }

  async listComments() {
    return this.comments;
  }

  async addComment(_item, body) {
    this.comments.push({ body });
  }

  async requestHumanAttention() {
    if (this.refuse) {
      return { requested: false, reason: "not-owner", item: this.item };
    }
    this.item.fields.needsHumanSince = "2026-07-20T16:00:00Z";
    return { requested: true, item: this.item };
  }

  async resolveHumanAttention() {
    if (this.refuse) {
      return { resolved: false, reason: "not-owner", item: this.item };
    }
    this.item.fields.needsHumanSince = "";
    return { resolved: true, item: this.item };
  }
}

function makeItem() {
  return {
    id: "item-1",
    number: 1,
    title: "Task 1",
    url: "https://github.com/example/data/issues/1",
    fields: {
      status: "in-progress",
      owner: "agent",
      priority: "low",
      needsHumanSince: "",
      claimedBy: "machine-a/pan-development/slot-1",
      leaseUntil: "2026-07-20T16:30:00Z",
    },
  };
}
