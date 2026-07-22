import assert from "node:assert/strict";
import test from "node:test";

import {
  AttentionService,
  PanTriageService,
} from "../src/index.js";

test("triages the manual issue 35 and 36 regression scenarios idempotently", async () => {
  const question = item({
    number: 35,
    title: "Why do we have this sandbox for the Pan chat?",
  });
  const documentation = item({
    number: 36,
    title:
      "The readme has too much info about the architecture; it should focus on how to use Pan.",
  });
  const store = new FakeStore([question, documentation]);
  const service = triageService(store);

  await service.run();
  const firstCommentCount = store.commentCount();
  await service.run();

  assert.deepEqual(question.fields, {
    status: "ready",
    owner: "human",
    priority: "normal",
    requirements: "",
    autonomy: "manual",
    workstream: "pan",
    claimedBy: "",
    leaseUntil: "",
  });
  assert.deepEqual(documentation.fields, {
    status: "ready",
    owner: "agent",
    priority: "normal",
    requirements:
      "repo:AmoebaChant/pan\ndelivery:pull-request",
    autonomy: "full-auto",
    workstream: "pan",
    claimedBy: "",
    leaseUntil: "",
  });
  assert.equal(store.commentCount(), firstCommentCount);
  assert.ok(
    store
      .allComments()
      .every((comment) => /PAN triage (?:decision|applied)/.test(comment.body)),
  );
});

test("asks once, resumes from an answer, and moves the item to ready", async () => {
  const task = item({
    number: 42,
    title: "Prepare the planning notes",
  });
  const store = new FakeStore([task]);
  const attention = new AttentionService({
    store,
    humanAssignee: "octocat",
  });
  const service = triageService(store, attention);

  await service.run();
  await service.run();

  assert.equal(task.fields.status, "needs-detail");
  assert.equal(
    store
      .allComments()
      .filter((comment) => comment.body.includes("<!-- pan:needs-human -->"))
      .length,
    1,
  );

  await attention.answer(
    42,
    "workstream: pan\nowner: human",
  );
  await service.run();

  assert.equal(task.fields.status, "ready");
  assert.equal(task.fields.owner, "human");
  assert.equal(task.fields.autonomy, "manual");
  assert.equal(task.fields.workstream, "pan");
  assert.ok(
    store
      .allComments()
      .some((comment) => comment.body.includes("Attention resolved")),
  );
});

test("fails closed when Project fields change during triage", async () => {
  const task = item({
    number: 43,
    title: "Update Pan documentation",
  });
  task.fields.owner = "human";
  const store = new FakeStore([task], {
    mutateOnGet: 2,
    mutate: (current) => {
      current.fields.owner = "agent";
    },
  });

  await assert.rejects(
    triageService(store).run(),
    (error) => error.code === "PAN_TRIAGE_STALE",
  );
  assert.equal(task.fields.status, "");
});

test("guards Issue synchronization with the runtime abort signal", async () => {
  const task = item({
    number: 44,
    title: "Update Pan documentation",
  });
  const store = new FakeStore([task]);
  const controller = new AbortController();
  controller.abort(new Error("leader lease lost"));

  await assert.rejects(
    triageService(store).run({ signal: controller.signal }),
    /leader lease lost/,
  );
  assert.equal(store.syncGuardCalls, 1);
});

test("reconciles an applied audit record after comment delivery fails", async () => {
  const task = item({
    number: 45,
    title: "Update Pan documentation",
  });
  Object.assign(task.fields, {
    status: "untriaged",
    owner: "agent",
    priority: "normal",
    requirements: "repo:AmoebaChant/pan\ndelivery:pull-request",
    autonomy: "full-auto",
    workstream: "pan",
  });
  task.requirements = [
    "repo:AmoebaChant/pan",
    "delivery:pull-request",
  ];
  const store = new FakeStore([task], { failAppliedOnce: true });
  const runners = [];
  const service = triageService(store, undefined, runners);

  await assert.rejects(service.run(), /audit delivery failed/);
  assert.equal(task.fields.status, "blocked");
  assert.equal(
    store
      .allComments()
      .some((comment) => comment.body.includes("pan:triage-applied")),
    false,
  );

  runners.push(defaultRunner());
  await service.run();

  assert.equal(task.fields.status, "ready");
  assert.equal(
    store
      .allComments()
      .some((comment) => comment.body.includes("pan:triage-applied")),
    true,
  );
});

class FakeStore {
  constructor(items, { mutateOnGet, mutate, failAppliedOnce = false } = {}) {
    this.items = items;
    this.comments = new Map();
    this.mutateOnGet = mutateOnGet;
    this.mutate = mutate;
    this.getCount = 0;
    this.syncGuardCalls = 0;
    this.failAppliedOnce = failAppliedOnce;
  }

  async syncOpenIssues({ beforeMutation = async () => {} } = {}) {
    this.syncGuardCalls += 1;
    await beforeMutation();
    return this.items;
  }

  async listItems() {
    return this.items;
  }

  async getItem(itemId) {
    const current = this.items.find((item) => item.id === itemId);
    this.getCount += 1;
    if (this.getCount === this.mutateOnGet) {
      this.mutate(current);
    }
    return current;
  }

  async setFields(itemId, fields) {
    const current = await this.getItem(itemId);
    for (const [field, value] of Object.entries(fields)) {
      current.fields[field] = Array.isArray(value) ? value.join("\n") : value ?? "";
      if (field === "requirements") {
        current.requirements = Array.isArray(value)
          ? [...value]
          : String(value ?? "").split(/\r?\n/).filter(Boolean);
      }
    }
  }

  async listComments(item) {
    return this.comments.get(item.id) ?? [];
  }

  async addComment(item, body) {
    if (
      this.failAppliedOnce &&
      body.includes("<!-- pan:triage-applied:")
    ) {
      this.failAppliedOnce = false;
      throw new Error("audit delivery failed");
    }
    const comments = this.comments.get(item.id) ?? [];
    comments.push({
      id: `comment-${comments.length + 1}`,
      body,
      url: `${item.url}#issuecomment-${comments.length + 1}`,
      createdAt: "2026-07-21T20:00:00.000Z",
      updatedAt: "2026-07-21T20:00:00.000Z",
    });
    this.comments.set(item.id, comments);
  }

  commentCount() {
    return this.allComments().length;
  }

  allComments() {
    return [...this.comments.values()].flat();
  }
}

function triageService(store, attention, runners = [defaultRunner()]) {
  return new PanTriageService({
    store,
    attention,
    workstreamSource: {
      list: async () => ({
        revision: "a".repeat(40),
        complete: true,
        workstreams: [{ path: "pan" }],
        errors: [],
      }),
    },
    runnerSource: {
      loadAvailability: async () => ({
        complete: true,
        diagnostics: [],
        runners,
      }),
    },
  });
}

function defaultRunner() {
  return {
    id: "runner-a",
    online: true,
    playbooks: [
      {
        capabilities: ["repo:AmoebaChant/pan"],
        repositories: ["AmoebaChant/pan"],
        delivery: "pull-request",
      },
    ],
  };
}

function item({ number, title }) {
  return {
    id: `item-${number}`,
    number,
    title,
    body: "",
    url: `https://github.com/AmoebaChant/pan-work/issues/${number}`,
    repository: "AmoebaChant/pan-work",
    state: "open",
    comments: [],
    requirements: [],
    fields: {
      status: "",
      owner: "",
      priority: "",
      requirements: "",
      autonomy: "",
      workstream: "",
      claimedBy: "",
      leaseUntil: "",
    },
  };
}
