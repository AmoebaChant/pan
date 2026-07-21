import assert from "node:assert/strict";
import test from "node:test";

import { RunnerDaemon } from "../src/index.js";

test("claims matching work and advances a completed task to in-review", async () => {
  const item = makeItem();
  const store = new FakeStore([item]);
  const handle = new FakeHandle({
    status: "completed",
    summary: "Added the requested documentation.",
  });
  const daemon = new RunnerDaemon({
    store,
    profile: makeProfile(),
    executor: new FakeExecutor(handle),
    logger: silentLogger,
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

test("records a needs-human locator and blocks an incomplete task", async () => {
  const item = makeItem();
  const store = new FakeStore([item]);
  const handle = new FakeHandle({
    status: "blocked",
    summary: "A product decision is required.",
  });
  const daemon = new RunnerDaemon({
    store,
    profile: makeProfile(),
    executor: new FakeExecutor(handle),
    logger: silentLogger,
  });

  await daemon.runOnce();

  assert.match(store.comments.at(-1), /A product decision is required/);
  assert.match(store.comments.at(-1), /machine-a/);
  assert.equal(store.releases[0].status, "blocked");
});

test("does not complete a task after losing its lease", async () => {
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
  assert.equal(store.releases[0].status, "blocked");
  assert.match(store.comments.at(-1), /Lease lost/);
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

test("releases failed work even when its needs-human comment fails", async () => {
  const item = makeItem();
  const store = new FakeStore([item], { commentFailures: 1 });
  const daemon = new RunnerDaemon({
    store,
    profile: makeProfile(),
    executor: new FailingExecutor(),
    logger: silentLogger,
  });

  await daemon.runOnce();

  assert.equal(store.releases[0].status, "blocked");
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
  assert.equal(store.releases[0].status, "blocked");

  daemon.executor = new FakeExecutor(new FakeHandle());
  await daemon.runOnce();

  assert.equal(store.claims.length, 2);
  assert.equal(store.releases.at(-1).status, "in-review");
});

class FakeStore {
  constructor(
    items,
    {
      heartbeat = { renewed: true },
      commentFailures = 0,
      issueComments = [],
      claimFailure,
    } = {},
  ) {
    this.items = items;
    this.heartbeatResult = heartbeat;
    this.commentFailures = commentFailures;
    this.issueComments = issueComments;
    this.claimFailure = claimFailure;
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
  }

  async listComments() {
    return this.issueComments;
  }

  async release(release) {
    this.releases.push(release);
    return { released: true };
  }

  async heartbeat() {
    return this.heartbeatResult;
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
  ) {
    this.result = result;
    this.completed = false;
  }

  async wait() {
    return this.result;
  }

  async complete() {
    this.completed = true;
    return { prUrl: "https://github.com/example/tool/pull/42" };
  }

  locator() {
    return {
      machine: "machine-a",
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
