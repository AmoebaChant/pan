import assert from "node:assert/strict";
import test from "node:test";

import { formatNeedsHuman, PanDaemon } from "../src/index.js";

test("heartbeats the leader lease during a long poll", async () => {
  let heartbeats = 0;
  const daemon = new PanDaemon({
    store: {
      async syncOpenIssues() {
        await new Promise((resolve) => setTimeout(resolve, 15));
        return [];
      },
    },
    profileSource: { load: async () => [] },
    leaderLease: {
      acquire: async () => ({ acquired: true }),
      heartbeat: async () => {
        heartbeats += 1;
        return { renewed: true };
      },
      release: async () => ({ released: true }),
    },
    leaderHeartbeatSeconds: 0.001,
  });

  await daemon.runOnce();

  assert.ok(heartbeats > 0);
});

test("triages a complete agent item to ready", async () => {
  const item = makeItem({
    body: "Implement it.\nworkstream: orchestration/pan\nrepo:example/tool",
  });
  const store = new FakeStore([item]);
  const daemon = makeDaemon(store, [matchingProfile()]);

  const result = await daemon.tick();

  assert.equal(item.fields.owner, "agent");
  assert.equal(item.fields.autonomy, "full-auto");
  assert.equal(item.fields.status, "ready");
  assert.equal(result.triaged, 2);
  assert.equal(store.comments.length, 0);
});

test("blocks unmatchable work with one needs-human record", async () => {
  const item = makeItem({
    owner: "agent",
    status: "ready",
    requirements: ["repo:example/tool", "tool:missing"],
    workstream: "orchestration/pan",
  });
  const store = new FakeStore([item]);
  const daemon = makeDaemon(store, [matchingProfile()]);

  await daemon.tick();
  await daemon.tick();

  assert.equal(item.fields.status, "blocked");
  assert.equal(store.comments.length, 1);
  assert.match(store.comments[0].body, /unmatchable-requirements/);
});

test("requeues only PAN-created requirement blocks when a runner appears", async () => {
  const item = makeItem({
    owner: "agent",
    status: "blocked",
    requirements: ["repo:example/tool"],
    workstream: "orchestration/pan",
  });
  const panBlock = formatNeedsHuman({
    kind: "question",
    prompt: "No runner.",
    source: "pan",
    reason: "unmatchable-requirements",
    locator: { issue: item.url },
  });
  const store = new FakeStore([item], {
    comments: new Map([[item.id, [{ body: panBlock }]]]),
  });

  await makeDaemon(store, [matchingProfile()]).tick();

  assert.equal(item.fields.status, "ready");
  assert.match(store.comments.at(-1).body, /Attention resolved/);

  const runnerBlocked = makeItem({
    id: "item-2",
    number: 2,
    owner: "agent",
    status: "blocked",
    requirements: ["repo:example/tool"],
    workstream: "orchestration/pan",
  });
  const runnerQuestion = formatNeedsHuman({
    kind: "question",
    prompt: "Choose an API.",
    locator: { machine: "machine-a" },
  });
  const runnerStore = new FakeStore([runnerBlocked], {
    comments: new Map([[runnerBlocked.id, [{ body: runnerQuestion }]]]),
  });

  await makeDaemon(runnerStore, [matchingProfile()]).tick();

  assert.equal(runnerBlocked.fields.status, "blocked");
});

test("recovers a stale requirement question after resolution comment failure", async () => {
  const item = makeItem({
    owner: "agent",
    status: "blocked",
    requirements: ["repo:example/tool"],
    workstream: "orchestration/pan",
  });
  const panBlock = formatNeedsHuman({
    kind: "question",
    prompt: "No runner.",
    source: "pan",
    reason: "unmatchable-requirements",
    locator: { issue: item.url },
  });
  const store = new FakeStore([item], {
    comments: new Map([[item.id, [{ body: panBlock }]]]),
    commentFailures: 1,
  });
  const daemon = makeDaemon(store, [matchingProfile()]);

  await assert.rejects(daemon.tick(), /comment failed/);
  assert.equal(item.fields.status, "ready");
  await daemon.tick();

  assert.match(store.comments.at(-1).body, /Attention resolved/);
});

test("does not change status when another worker wins the item lease", async () => {
  const item = makeItem({
    owner: "agent",
    status: "ready",
    requirements: ["repo:example/tool", "tool:missing"],
    workstream: "orchestration/pan",
  });
  const store = new FakeStore([item], { denyClaims: true });

  await makeDaemon(store, [matchingProfile()]).tick();

  assert.equal(item.fields.status, "ready");
});

class FakeStore {
  constructor(
    items,
    { comments = new Map(), commentFailures = 0, denyClaims = false } = {},
  ) {
    this.items = items;
    this.commentMap = comments;
    this.commentFailures = commentFailures;
    this.denyClaims = denyClaims;
    this.comments = [];
    this.orders = [];
  }

  async syncOpenIssues() {
    return this.items;
  }

  async listComments(item) {
    return this.commentMap.get(item.id) ?? [];
  }

  async getItem(itemId) {
    return this.items.find((item) => item.id === itemId);
  }

  async setFields(itemId, fields) {
    const item = this.items.find((candidate) => candidate.id === itemId);
    for (const [key, value] of Object.entries(fields)) {
      item.fields[key] = Array.isArray(value) ? value.join("\n") : value ?? "";
      if (key === "requirements") {
        item.requirements = value;
      }
    }
  }

  async claimWithLease({ itemId, runner, leaseUntil, status }) {
    const item = await this.getItem(itemId);
    if (this.denyClaims || item.fields.claimedBy) {
      return { claimed: false, reason: "leased", item };
    }
    item.fields.claimedBy = runner;
    item.fields.leaseUntil = leaseUntil;
    item.fields.status = status;
    return { claimed: true, item };
  }

  async release({ itemId, runner }) {
    const item = await this.getItem(itemId);
    if (item.fields.claimedBy !== runner) {
      return { released: false, reason: "not-owner", item };
    }
    item.fields.claimedBy = "";
    item.fields.leaseUntil = "";
    return { released: true, item };
  }

  async addComment(item, body) {
    if (this.commentFailures > 0) {
      this.commentFailures -= 1;
      throw new Error("comment failed");
    }
    const comment = { body };
    this.comments.push(comment);
    const existing = this.commentMap.get(item.id) ?? [];
    existing.push(comment);
    this.commentMap.set(item.id, existing);
  }

  async reorderItems(ids) {
    this.orders.push(ids);
  }
}

function makeDaemon(store, profiles) {
  return new PanDaemon({
    store,
    profileSource: { load: async () => profiles },
    leaderLease: {},
  });
}

function matchingProfile() {
  return {
    id: "machine-a",
    online: true,
    capabilities: ["repo:example/tool", "env:local"],
  };
}

function makeItem({
  id = "item-1",
  number = 1,
  body = "Do the task.",
  owner = "unassigned",
  status = "untriaged",
  priority = "normal",
  requirements = [],
  autonomy = "manual",
  workstream = "",
} = {}) {
  return {
    id,
    number,
    body,
    title: "Task",
    url: `https://github.com/example/data/issues/${number}`,
    state: "open",
    requirements,
    fields: {
      owner,
      status,
      priority,
      requirements: requirements.join("\n"),
      autonomy,
      workstream,
      claimedBy: "",
      leaseUntil: "",
    },
  };
}
