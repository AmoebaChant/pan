import assert from "node:assert/strict";
import test from "node:test";

import { AttentionService, RunnerDaemon } from "../src/index.js";

test("claims matching work and advances a completed task to in-review", async () => {
  const item = makeItem();
  const store = new FakeStore([item]);
  const handle = new FakeHandle({
    status: "completed",
    summary: "Added the requested documentation.",
  });
  const messages = [];
  const daemon = new RunnerDaemon({
    store,
    profile: makeProfile(),
    executor: new FakeExecutor(handle),
    logger: {
      ...silentLogger,
      info: (message) => messages.push(message),
    },
  });

  await daemon.runOnce();

  assert.equal(store.claims.length, 1);
  assert.equal(store.claims[0].runner, "machine-a/slot-1");
  assert.equal(handle.completed, true);
  assert.deepEqual(store.releases, [
    {
      itemId: "item-1",
      runner: "machine-a/slot-1",
      assignee: "octocat",
      status: "in-review",
    },
  ]);
  assert.match(store.comments.at(-1), /pull\/42/);
  assert.ok(messages.some((message) => message.includes("Claimed task #1")));
  assert.ok(messages.some((message) => message.includes("pull-request")));
});

test("marks direct delivery done and records its commit", async () => {
  const store = new FakeStore([makeItem()]);
  const handle = new FakeHandle(undefined, {
    mode: "direct",
    commit: "0123456789abcdef0123456789abcdef01234567",
    url: "https://github.com/example/tool/commit/0123456789abcdef0123456789abcdef01234567",
  });
  const profile = makePlaybookProfile({
    maximum: 1,
    panCapacity: 1,
  });
  profile.playbooks = [profile.playbooks[0]];
  profile.playbooks[0].delivery = "direct";
  const executor = new FakeExecutor(handle);
  const daemon = new RunnerDaemon({
    store,
    profile,
    executor,
    logger: silentLogger,
  });

  await daemon.runOnce();

  assert.equal(executor.started.playbook.delivery, "direct");
  assert.equal(store.releases[0].status, "done");
  assert.match(store.comments.at(-1), /Commit:/);
  assert.match(store.comments.at(-1), /\/commit\//);
});

test("requeues direct finalization when its commit audit cannot be recorded", async () => {
  const store = new FakeStore([makeItem()], { commentFailures: 3 });
  const handle = new FakeHandle(undefined, {
    mode: "direct",
    commit: "0123456789abcdef0123456789abcdef01234567",
    url: "https://github.com/example/tool/commit/0123456789abcdef0123456789abcdef01234567",
  });
  const profile = makePlaybookProfile({
    maximum: 1,
    panCapacity: 1,
  });
  profile.playbooks = [profile.playbooks[0]];
  profile.playbooks[0].delivery = "direct";
  const daemon = new RunnerDaemon({
    store,
    profile,
    executor: new FakeExecutor(handle),
    logger: silentLogger,
  });

  await daemon.runOnce();

  assert.equal(store.releases[0].status, "ready");
});

test("requeues direct work when closing its completed Issue fails", async () => {
  const store = new FakeStore([makeItem()], {
    releaseFailures: { done: 3 },
  });
  const handle = new FakeHandle(undefined, {
    mode: "direct",
    commit: "0123456789abcdef0123456789abcdef01234567",
    url: "https://github.com/example/tool/commit/0123456789abcdef0123456789abcdef01234567",
  });
  const profile = makePlaybookProfile({
    maximum: 1,
    panCapacity: 1,
  });
  profile.playbooks = [profile.playbooks[0]];
  profile.playbooks[0].delivery = "direct";
  const daemon = new RunnerDaemon({
    store,
    profile,
    executor: new FakeExecutor(handle),
    logger: silentLogger,
  });

  await daemon.runOnce();

  assert.deepEqual(
    store.releases.map((release) => release.status),
    ["done", "done", "done", "ready"],
  );
  assert.match(store.comments.at(-1), /Issue closure failed/);
});

test("does not claim work with unsupported requirements", async () => {
  const item = makeItem({
    requirements: ["repo:example/tool", "tool:unavailable"],
  });
  const store = new FakeStore([item]);
  const daemon = new RunnerDaemon({
    store,
    profile: makeProfile(),
    executor: new FakeExecutor(new FakeHandle()),
    logger: silentLogger,
  });

  await daemon.runOnce();

  assert.equal(store.claims.length, 0);
});

test("passes Issue comments to the task executor", async () => {
  const item = makeItem();
  const store = new FakeStore([item], {
    issueComments: [{ body: "<!-- pan:answer -->\n### Answer\n\nUse option A." }],
  });
  const executor = new FakeExecutor(new FakeHandle());
  const daemon = new RunnerDaemon({
    store,
    profile: makeProfile(),
    executor,
    logger: silentLogger,
  });

  await daemon.runOnce();

  assert.match(executor.started.item.comments[0].body, /Use option A/);
});

test("records durable resume information when an agent starts", async () => {
  const store = new FakeStore([makeItem()]);
  const daemon = new RunnerDaemon({
    store,
    profile: makeProfile(),
    executor: new ResumeAwareExecutor(new FakeHandle()),
    logger: silentLogger,
  });

  await daemon.runOnce();

  assert.match(store.comments[0], /### Agent started/);
  assert.match(store.comments[0], /"machine": "machine-a"/);
  assert.match(store.comments[0], /"branch": "pan\/issue-1"/);
  assert.match(store.comments[0], /"worktree": "C:\\\\worktrees\\\\issue-1"/);
});

test("records a needs-human locator and blocks an incomplete task", async () => {
  const item = makeItem();
  const store = new FakeStore([item]);
  const handle = new FakeHandle({
    status: "blocked",
    summary: "A product decision is required.",
  }, undefined, {
    kind: "question",
    prompt: "Should the implementation use option A or option B?",
  });
  const daemon = new RunnerDaemon({
    store,
    profile: makeProfile(),
    executor: new FakeExecutor(handle),
    attention: new AttentionService({
      store,
      humanAssignee: "octocat",
    }),
    logger: silentLogger,
  });

  await daemon.runOnce();

  assert.match(store.comments.at(-1), /option A or option B/);
  assert.match(store.comments.at(-1), /machine-a/);
  assert.equal(store.releases[0].status, "blocked");
  assert.equal(store.releases[0].owner, "human");
  assert.equal(store.releases[0].priority, "urgent");
});

test("does not mutate a task after losing its lease", async () => {
  const item = makeItem();
  const store = new FakeStore([item], {
    heartbeat: { renewed: false, reason: "not-owner" },
  });
  const handle = new FakeHandle({
    status: "completed",
    summary: "Completed locally.",
  });
  const daemon = new RunnerDaemon({
    store,
    profile: makeProfile(),
    executor: new FakeExecutor(handle),
    logger: silentLogger,
  });

  await daemon.runOnce();

  assert.equal(handle.completed, false);
  assert.equal(store.releases.length, 0);
  assert.equal(store.comments.length, 0);
});

test("does not release completed work after a final lease check fails", async () => {
  const store = new FakeStore([makeItem()], {
    heartbeat: [
      { renewed: true },
      { renewed: false, reason: "lease-expired" },
    ],
  });
  const handle = new FakeHandle();
  const daemon = new RunnerDaemon({
    store,
    profile: makeProfile(),
    executor: new FakeExecutor(handle),
    logger: silentLogger,
  });

  await daemon.runOnce();

  assert.equal(handle.completed, true);
  assert.equal(store.releases.length, 0);
  assert.equal(store.comments.length, 0);
});

test("records a direct commit before a post-delivery lease loss", async () => {
  const store = new FakeStore([makeItem()], {
    heartbeat: [
      { renewed: true },
      { renewed: false, reason: "lease-expired" },
    ],
  });
  const handle = new FakeHandle(undefined, {
    mode: "direct",
    commit: "0123456789abcdef0123456789abcdef01234567",
    url: "https://github.com/example/tool/commit/0123456789abcdef0123456789abcdef01234567",
  });
  const profile = makePlaybookProfile({
    maximum: 1,
    panCapacity: 1,
  });
  profile.playbooks = [profile.playbooks[0]];
  profile.playbooks[0].delivery = "direct";
  const daemon = new RunnerDaemon({
    store,
    profile,
    executor: new FakeExecutor(handle),
    logger: silentLogger,
  });

  await daemon.runOnce();

  assert.equal(store.releases.length, 0);
  assert.match(store.comments.at(-1), /Commit:/);
});

test("stops an unlimited worker when its lease is lost", async () => {
  const item = makeItem();
  const store = new FakeStore([item], {
    heartbeat: { renewed: false, reason: "not-owner" },
  });
  const handle = new DeferredHandle();
  const profile = makeProfile();
  profile.heartbeatSeconds = 0.001;
  profile.taskBudget = {};
  const daemon = new RunnerDaemon({
    store,
    profile,
    executor: new FakeExecutor(handle),
    logger: silentLogger,
  });

  await daemon.runOnce();

  assert.match(handle.cancelled, /Lease lost/);
  assert.equal(store.releases.length, 0);
});

test("stops unlimited workers during runner shutdown", async () => {
  const item = makeItem();
  const store = new FakeStore([item]);
  const handle = new DeferredHandle();
  const executor = new FakeExecutor(handle);
  const profile = makeProfile();
  profile.pollIntervalSeconds = 30;
  profile.taskBudget = {};
  const controller = new AbortController();
  const daemon = new RunnerDaemon({
    store,
    profile,
    executor,
    logger: silentLogger,
  });

  const running = daemon.run({ signal: controller.signal });
  while (!executor.started) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  controller.abort(new Error("Ctrl+C"));
  await running;

  assert.match(handle.interrupted, /Runner stopped: Ctrl\+C/);
  assert.equal(store.releases[0].status, "ready");
  assert.match(store.comments.at(-1), /### Agent stopped/);
  assert.match(store.comments.at(-1), /Runner stopped: Ctrl\\u002bC|Runner stopped: Ctrl\+C/);
});

test("stops unlimited workers when a one-shot run is interrupted", async () => {
  const store = new FakeStore([makeItem()]);
  const handle = new DeferredHandle();
  const executor = new FakeExecutor(handle);
  const profile = makeProfile();
  profile.taskBudget = {};
  const controller = new AbortController();
  const daemon = new RunnerDaemon({
    store,
    profile,
    executor,
    logger: silentLogger,
  });

  const running = daemon.runOnce({ signal: controller.signal });
  while (!executor.started) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  controller.abort(new Error("Ctrl+C"));
  await running;

  assert.match(handle.interrupted, /Runner stopped: Ctrl\+C/);
  assert.equal(store.releases[0].status, "ready");
  assert.match(store.comments.at(-1), /### Agent stopped/);
});

test("preserves pending resume recovery when requeue release fails", async () => {
  const store = new FakeStore([makeItem()], {
    releaseFailures: { ready: 3 },
  });
  const handle = new FakeHandle({
    status: "failed",
    summary: "Worker process crashed.",
  });
  const daemon = new RunnerDaemon({
    store,
    profile: makeProfile(),
    executor: new FakeExecutor(handle),
    logger: silentLogger,
  });

  await daemon.runOnce();

  assert.equal(handle.pendingRequeue, true);
  assert.notEqual(handle.requeued, true);
});

test("blocks budget exhaustion for approval instead of retrying indefinitely", async () => {
  const store = new FakeStore([makeItem()]);
  const handle = new FakeHandle({
    status: "failed",
    summary: "Copilot exceeded the task wall-clock budget.",
    budgetExceeded: true,
  });
  const daemon = new RunnerDaemon({
    store,
    profile: makeProfile(),
    executor: new FakeExecutor(handle),
    attention: new AttentionService({
      store,
      humanAssignee: "octocat",
    }),
    logger: silentLogger,
  });

  await daemon.runOnce();

  assert.equal(store.releases[0].status, "blocked");
  assert.match(store.comments.at(-1), /"kind": "approval"/);
});

test("stops an active worker before requeueing an unexpected runner error", async () => {
  const store = new FakeStore([makeItem()]);
  const handle = new ThrowingHandle();
  const daemon = new RunnerDaemon({
    store,
    profile: makeProfile(),
    executor: new FakeExecutor(handle),
    logger: silentLogger,
  });

  await daemon.runOnce();

  assert.match(handle.interrupted, /Runner failure: unexpected wait failure/);
  assert.equal(store.releases[0].status, "ready");
});

test("moves completed work to in-review even when its audit comment fails", async () => {
  const item = makeItem();
  const store = new FakeStore([item], { commentFailures: 3 });
  const handle = new FakeHandle({
    status: "completed",
    summary: "Completed locally.",
  });
  const daemon = new RunnerDaemon({
    store,
    profile: makeProfile(),
    executor: new FakeExecutor(handle),
    logger: silentLogger,
  });

  await daemon.runOnce();

  assert.equal(store.releases[0].status, "in-review");
  assert.equal(handle.completed, true);
});

test("requeues failed launches even when their event comment fails", async () => {
  const item = makeItem();
  const store = new FakeStore([item], { commentFailures: 3 });
  const daemon = new RunnerDaemon({
    store,
    profile: makeProfile(),
    executor: new FailingExecutor(),
    logger: silentLogger,
  });

  await daemon.runOnce();

  assert.equal(store.releases[0].status, "ready");
  assert.doesNotMatch(store.comments.join("\n"), /pan:needs-human/);
});

test("surfaces claim rate limits to the polling loop", async () => {
  const store = new FakeStore([makeItem()], {
    claimFailure: new Error("API rate limit exceeded for user"),
  });
  const daemon = new RunnerDaemon({
    store,
    profile: makeProfile(),
    executor: new FakeExecutor(new FakeHandle()),
    logger: silentLogger,
  });

  await assert.rejects(daemon.runOnce(), /rate limit exceeded/i);
});

test("enforces per-playbook capacity without sharing slots between playbooks", async () => {
  const items = [
    makeItem({
      id: "docs-1",
      number: 1,
      requirements: ["repo:example/tool", "tool:docs"],
    }),
    ...Array.from({ length: 6 }, (_, index) =>
      makeItem({
        id: `pan-${index + 1}`,
        number: index + 2,
        requirements: ["repo:example/tool", "tool:node22"],
      }),
    ),
  ];
  const handles = Array.from(
    { length: 6 },
    () => new DeferredHandle(),
  );
  const store = new FakeStore(items);
  const daemon = new RunnerDaemon({
    store,
    profile: makePlaybookProfile(),
    executor: new SequencedExecutor(handles),
    logger: silentLogger,
  });

  const started = await daemon.tick();

  assert.equal(started, 6);
  assert.equal(store.claims.length, 6);
  assert.equal(
    store.claims.filter((claim) => claim.runner.includes("pan-development"))
      .length,
    5,
  );
  assert.equal(
    store.claims.filter((claim) => claim.runner.includes("documentation"))
      .length,
    1,
  );
  for (const handle of handles) {
    handle.resolve();
  }
  await Promise.all([...daemon.active.values()].map((entry) => entry.promise));
});

test("releases playbook capacity after a failed launch so work can retry", async () => {
  const item = makeItem({
    requirements: ["repo:example/tool", "tool:node22"],
  });
  const store = new FakeStore([item]);
  const daemon = new RunnerDaemon({
    store,
    profile: makePlaybookProfile({ maximum: 1, panCapacity: 1 }),
    executor: new FailingExecutor(),
    logger: silentLogger,
  });

  await daemon.runOnce();
  assert.equal(daemon.active.size, 0);
  assert.equal(store.releases[0].status, "ready");

  daemon.executor = new FakeExecutor(new FakeHandle());
  await daemon.runOnce();

  assert.equal(store.claims.length, 2);
  assert.equal(store.releases.at(-1).status, "in-review");
});

test("treats the pan-work#9 terminal shutdown false positive as operational", async () => {
  const item = makeItem({ number: 9 });
  const store = new FakeStore([item]);
  const handle = new FakeHandle({
    status: "failed",
    summary: "Copilot exited without a task result (code 1, signal none).",
  });
  const daemon = new RunnerDaemon({
    store,
    profile: makeProfile(),
    executor: new FakeExecutor(handle),
    logger: silentLogger,
  });

  await daemon.runOnce();

  assert.equal(store.releases[0].status, "ready");
  assert.equal(store.releases[0].resumeAffinity, "resume:machine-a");
  assert.doesNotMatch(store.comments.join("\n"), /pan:needs-human/);
  assert.match(store.comments.at(-1), /Agent stopped/i);
});

class FakeStore {
  constructor(
    items,
    {
      heartbeat = { renewed: true },
      commentFailures = 0,
      issueComments = [],
      claimFailure,
      releaseFailures = {},
    } = {},
  ) {
    this.items = items;
    this.heartbeatResults = Array.isArray(heartbeat)
      ? [...heartbeat]
      : [heartbeat];
    this.commentFailures = commentFailures;
    this.issueComments = issueComments;
    this.claimFailure = claimFailure;
    this.releaseFailures = { ...releaseFailures };
    this.claims = [];
    this.comments = [];
    this.releases = [];
  }

  async listByFilter() {
    return this.items;
  }

  async claimWithLease(claim) {
    this.claims.push(claim);
    if (this.claimFailure) {
      throw this.claimFailure;
    }
    return {
      claimed: true,
      item: this.items.find((item) => item.id === claim.itemId),
    };
  }

  async addComment(_item, body) {
    if (this.commentFailures > 0) {
      this.commentFailures -= 1;
      throw new Error("comment failed");
    }
    this.comments.push(body);
    this.issueComments.push({ body });
  }

  async listComments() {
    return this.issueComments;
  }

  async release(release) {
    this.releases.push(release);
    if ((this.releaseFailures[release.status] ?? 0) > 0) {
      this.releaseFailures[release.status] -= 1;
      throw new Error("Issue closure failed");
    }
    return { released: true };
  }

  async requestHumanAttention({
    itemId,
    humanAssignee,
  }) {
    const item = this.items.find((candidate) => candidate.id === itemId);
    Object.assign(item.fields, {
      claimedBy: "",
      leaseUntil: "",
      status: "blocked",
      owner: "human",
      priority: "urgent",
    });
    this.releases.push({
      itemId,
      status: "blocked",
      owner: "human",
      priority: "urgent",
      assignee: humanAssignee,
    });
    return { requested: true, item };
  }

  async heartbeat() {
    if (this.heartbeatResults.length > 1) {
      return this.heartbeatResults.shift();
    }
    return this.heartbeatResults[0];
  }
}

class FakeExecutor {
  constructor(handle) {
    this.handle = handle;
  }

  async start(context) {
    this.started = context;
    return this.handle;
  }
}

class ResumeAwareExecutor extends FakeExecutor {
  async start(context) {
    await context.onResume({
      machine: "machine-a",
      runner: "machine-a/slot-1",
      playbook: "pan-development",
      repository: "example/tool",
      branch: "pan/issue-1",
      worktreePath: "C:\\worktrees\\issue-1",
      terminalTitle: "PAN #1 - Task",
      resumed: false,
    });
    return super.start(context);
  }
}

class FailingExecutor {
  async start() {
    throw new Error("worker launch failed");
  }
}

class SequencedExecutor {
  constructor(handles) {
    this.handles = [...handles];
  }

  async start() {
    return this.handles.shift();
  }
}

class FakeHandle {
  constructor(
    result = {
      status: "completed",
      summary: "Completed.",
    },
    delivery = {
      mode: "pull-request",
      url: "https://github.com/example/tool/pull/42",
    },
    needsHuman,
  ) {
    this.result = result;
    this.delivery = delivery;
    this.completed = false;
    this.needsHuman = needsHuman;
  }

  async wait({ onNeedsHuman } = {}) {
    if (this.needsHuman) {
      await onNeedsHuman?.({
        ...this.needsHuman,
        locator: this.locator(),
      });
    }
    return this.result;
  }

  async complete() {
    this.completed = true;
    return this.delivery;
  }

  async setResumeAffinity(value) {
    this.resumeAffinity = value;
  }

  async markPendingRequeue() {
    this.pendingRequeue = true;
  }

  async markRequeued() {
    this.pendingRequeue = false;
    this.requeued = true;
  }

  async interrupt(summary) {
    this.interrupted = summary;
  }

  locator() {
    return {
      machine: "machine-a",
      runner: "machine-a/slot-1",
      branch: "pan/issue-1",
      worktree: "C:\\worktrees\\issue-1",
      terminalTitle: "PAN #1 - Task",
    };
  }
}

class DeferredHandle extends FakeHandle {
  constructor() {
    super();
    this.waitPromise = new Promise((resolve) => {
      this.resolveWait = resolve;
    });
  }

  async wait() {
    return this.waitPromise;
  }

  resolve() {
    this.resolveWait(this.result);
  }

  async cancel(summary) {
    this.cancelled = summary;
    this.resolveWait({
      status: "failed",
      summary,
    });
  }

  async interrupt(summary) {
    this.interrupted = summary;
    this.resolveWait({
      status: "interrupted",
      summary,
    });
  }
}

class ThrowingHandle extends FakeHandle {
  async wait() {
    throw new Error("unexpected wait failure");
  }

  async interrupt(summary) {
    this.interrupted = summary;
  }
}

function makeItem({
  id = "item-1",
  number = 1,
  requirements = ["repo:example/tool", "env:local"],
} = {}) {
  return {
    id,
    number,
    title: "Task",
    body: "Do the task.",
    url: "https://github.com/example/data/issues/1",
    repository: "example/data",
    requirements,
    fields: {
      autonomy: "full-auto",
      priority: "normal",
      workstream: "example",
      owner: "agent",
      status: "ready",
      claimedBy: "",
      leaseUntil: "",
    },
  };
}

function makePlaybookProfile({
  maximum = 6,
  panCapacity = 5,
} = {}) {
  return {
    ...makeProfile(),
    maxConcurrentDaemons: maximum,
    capabilities: [
      "repo:example/tool",
      "env:local",
      "tool:node22",
      "tool:docs",
    ],
    playbooks: [
      {
        id: "pan-development",
        capacity: panCapacity,
        capabilities: [
          "repo:example/tool",
          "env:local",
          "tool:node22",
        ],
        repositories: ["example/tool"],
        instructions: [],
      },
      {
        id: "documentation",
        capacity: 1,
        capabilities: ["repo:example/tool", "tool:docs"],
        repositories: ["example/tool"],
        instructions: [],
      },
    ],
  };
}

function makeProfile() {
  return {
    id: "machine-a",
    machine: "machine-a",
    online: true,
    maxConcurrentDaemons: 1,
    capabilities: ["repo:example/tool", "env:local"],
    repositories: {
      "example/tool": {
        path: "C:\\example\\tool",
        defaultBranch: "main",
      },
    },
    githubAssignee: "octocat",
    leaseSeconds: 600,
    heartbeatSeconds: 120,
    taskBudget: {
      wallClockMinutes: 60,
    },
  };
}

const silentLogger = {
  error() {},
};
