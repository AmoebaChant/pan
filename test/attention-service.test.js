import assert from "node:assert/strict";
import test from "node:test";

import { AttentionService, latestNeedsHuman } from "../src/index.js";

test("requests urgent human attention once with resumable prior state", async () => {
  const item = makeItem();
  const store = new FakeStore(item);
  const service = new AttentionService({
    store,
    humanAssignee: "octocat",
  });
  const record = {
    kind: "question",
    prompt: "Which API should this use?",
    locator: { machine: "machine-a" },
  };
  const options = {
    runner: item.fields.claimedBy,
    runnerAssignee: "runner-bot",
    resumeAffinity: "resume:machine-a/pan-development",
  };

  await service.request(item, record, options);
  await service.request(item, record, options);

  assert.equal(store.comments.length, 1);
  assert.equal(item.fields.status, "blocked");
  assert.equal(item.fields.owner, "human");
  assert.equal(item.fields.priority, "urgent");
  assert.equal(store.humanAssignee, "octocat");
  assert.equal(
    latestNeedsHuman(store.comments).resume.affinity,
    "resume:machine-a/pan-development",
  );
});

class FakeStore {
  constructor(item) {
    this.item = item;
    this.comments = [];
  }

  async listComments() {
    return this.comments;
  }

  async addComment(_item, body) {
    this.comments.push({ body });
  }

  async requestHumanAttention({ humanAssignee }) {
    Object.assign(this.item.fields, {
      claimedBy: "",
      leaseUntil: "",
      status: "blocked",
      owner: "human",
      priority: "urgent",
    });
    this.humanAssignee = humanAssignee;
    return { requested: true, item: this.item };
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
      claimedBy: "machine-a/pan-development/slot-1",
      leaseUntil: "2026-07-20T16:30:00Z",
    },
  };
}
