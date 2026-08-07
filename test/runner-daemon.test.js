import assert from "node:assert/strict";
import test from "node:test";

import { AttentionService, RunnerDaemon } from "../src/index.js";
import { formatNeedsHuman } from "../src/needs-human.js";

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
  assert.ok(messages.some((message) => message.includes("needs-review")));
});

test("claims and completes an eligible ready task that has no workstream", async () => {
  const item = makeItem();
  item.fields.workstream = "";
  const store = new FakeStore([item]);
  const handle = new FakeHandle({
    status: "completed",
    summary: "Completed without a workstream.",
  });
  const executor = new FakeExecutor(handle);

  const daemon = new RunnerDaemon({
    store,
    profile: makeProfile(),
    executor,
    logger: silentLogger,
  });

  await daemon.runOnce();

  assert.equal(store.claims.length, 1);
  assert.equal(store.claims[0].runner, "machine-a/slot-1");
  assert.equal(handle.completed, true);
  assert.equal(executor.started.item.number, 1);
  assert.equal(store.attentionRequests.length, 0);
  assert.deepEqual(store.releases, [
    {
      itemId: "item-1",
      runner: "machine-a/slot-1",
      assignee: "octocat",
      status: "in-review",
    },
  ]);
});

test("sets a task-specific terminal title while working and reverts when done", async () => {
  const item = makeItem({ number: 34 });
  const store = new FakeStore([item]);
  const handle = new FakeHandle({
    status: "completed",
    summary: "Done.",
  });
  const titles = [];
  const daemon = new RunnerDaemon({
    store,
    profile: makeProfile(),
    executor: new FakeExecutor(handle),
    logger: silentLogger,
    setWindowTitle: (title) => titles.push(title),
  });

  assert.equal(titles[0], "Pan Runner");

  await daemon.runOnce();

  assert.ok(titles.includes("Pan Runner: Task 34"));
  assert.equal(titles.at(-1), "Pan Runner");
});

test("adopts a live worker before polling and prevents a double dispatch", async () => {
  const adopted = makeItem({
    id: "item-adopted",
    number: 56,
    requirements: ["repo:example/tool", "tool:node22"],
  });
  adopted.fields.status = "in-progress";
  adopted.fields.claimedBy = "machine-a/pan-development/slot-1";
  adopted.fields.leaseUntil = "2026-07-31T12:00:00Z";
  const ready = makeItem({
    id: "item-ready",
    number: 57,
    requirements: ["repo:example/tool", "tool:node22"],
  });
  const handle = new DeferredHandle();
  const executor = new StartupRecoveryExecutor(
    [
      {
        itemId: adopted.id,
        issueNumber: adopted.number,
        runner: adopted.fields.claimedBy,
        playbookId: "pan-development",
        resumeAffinity: "resume:machine-a/pan-development",
        workerState: "live",
        requeue: false,
      },
    ],
    handle,
  );
  const store = new RecoveryStore([adopted, ready]);
  const daemon = new RunnerDaemon({
    store,
    profile: makePlaybookProfile({ maximum: 1, panCapacity: 1 }),
    executor,
    logger: silentLogger,
  });

  const started = await daemon.tick();

  assert.equal(started, 0);
  assert.equal(executor.adopted.item.id, adopted.id);
  assert.equal(store.claims.length, 1);
  assert.equal(store.claims[0].itemId, adopted.id);
  assert.equal(daemon.active.size, 1);

  handle.resolve();
  await daemon.active.get(adopted.fields.claimedBy).promise;
  assert.ok(store.heartbeats.length > 0);
  assert.equal(store.releases.at(-1).status, "in-review");
});

test("reconciles a dead worker to resumable ready state", async () => {
  const item = makeItem({ number: 56 });
  item.fields.status = "in-progress";
  item.fields.claimedBy = "machine-a/slot-1";
  const task = {
    itemId: item.id,
    issueNumber: item.number,
    runner: item.fields.claimedBy,
    playbookId: "legacy",
    resumeAffinity: "resume:machine-a",
    workerState: "gone",
    requeue: false,
  };
  const executor = new StartupRecoveryExecutor([task], new FakeHandle());
  const store = new RecoveryStore([item]);
  const daemon = new RunnerDaemon({
    store,
    profile: makeProfile(),
    executor,
    logger: silentLogger,
  });

  await daemon.tick();

  assert.equal(store.releases[0].status, "ready");
  assert.equal(store.releases[0].allowExpired, true);
  assert.equal(store.releases[0].resumeAffinity, "resume:machine-a");
  assert.equal(executor.requeued, task);
});

test("marks agent-reported done work done and records its delivery", async () => {
  const store = new FakeStore([makeItem()]);
  const handle = new FakeHandle(undefined, {
    outcome: "done",
    details: "Committed to main.",
    url: "https://github.com/example/tool/commit/0123456789abcdef0123456789abcdef01234567",
  });
  const profile = makePlaybookProfile({
    maximum: 1,
    panCapacity: 1,
  });
  profile.playbooks = [profile.playbooks[0]];
  const executor = new FakeExecutor(handle);
  const daemon = new RunnerDaemon({
    store,
    profile,
    executor,
    logger: silentLogger,
  });

  await daemon.runOnce();

  assert.equal(store.releases[0].status, "done");
  assert.match(store.comments.at(-1), /Committed to main\./);
  assert.match(store.comments.at(-1), /\/commit\//);
});

test("still finishes completed work when its audit comment cannot be recorded", async () => {
  const store = new FakeStore([makeItem()], { commentFailures: 3 });
  const handle = new FakeHandle(undefined, {
    outcome: "done",
    details: "Committed to main.",
    url: "https://github.com/example/tool/commit/0123456789abcdef0123456789abcdef01234567",
  });
  const profile = makePlaybookProfile({
    maximum: 1,
    panCapacity: 1,
  });
  profile.playbooks = [profile.playbooks[0]];
  const daemon = new RunnerDaemon({
    store,
    profile,
    executor: new FakeExecutor(handle),
    logger: silentLogger,
  });

  await daemon.runOnce();

  assert.equal(store.releases[0].status, "done");
});

test("requeues completed work when closing its Issue fails", async () => {
  const store = new FakeStore([makeItem()], {
    releaseFailures: { done: 3 },
  });
  const handle = new FakeHandle(undefined, {
    outcome: "done",
    details: "Committed to main.",
    url: "https://github.com/example/tool/commit/0123456789abcdef0123456789abcdef01234567",
  });
  const profile = makePlaybookProfile({
    maximum: 1,
    panCapacity: 1,
  });
  profile.playbooks = [profile.playbooks[0]];
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

test("claims higher-priority work first and preserves Project order for ties", async () => {
  const store = new FakeStore([
    makeItem({ id: "item-low", number: 1, priority: "low" }),
    makeItem({ id: "item-high-first", number: 2, priority: "high" }),
    makeItem({ id: "item-high-second", number: 3, priority: "high" }),
    makeItem({ id: "item-normal", number: 4, priority: "normal" }),
  ]);
  const daemon = new RunnerDaemon({
    store,
    profile: makeProfile(),
    executor: new FakeExecutor(new FakeHandle()),
    logger: silentLogger,
  });

  await daemon.runOnce();

  assert.equal(store.claims.length, 1);
  assert.equal(store.claims[0].itemId, "item-high-first");
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
  assert.match(store.comments[0], /"playbook": "pan-development"/);
  assert.match(
    store.comments[0],
    /"sessionId": "00000000-0000-4000-8000-000000000001"/,
  );
  assert.match(store.comments[0], /"branch": "pan\/issue-1"/);
  assert.match(store.comments[0], /"worktree": "C:\\\\worktrees\\\\issue-1"/);
});

test("clears stale attention when a task restarts from the beginning", async () => {
  const item = makeItem();
  item.fields.needsHumanSince = "2026-07-20T16:00:00Z";
  const store = new FakeStore([item], {
    issueComments: [
      {
        body: formatNeedsHuman({
          kind: "question",
          prompt: "Option A or option B?",
          machine: "machine-a",
          runner: "machine-a/slot-1",
          worktreePath: "C:\\worktrees\\issue-1",
          terminalTitle: "Pan #1 - Task",
        }),
      },
    ],
  });
  const daemon = new RunnerDaemon({
    store,
    profile: makeProfile(),
    executor: new ResumeAwareExecutor(new FakeHandle()),
    attention: new AttentionService({ store }),
    logger: silentLogger,
  });

  await daemon.runOnce();

  assert.deepEqual(store.attentionResolutions, ["item-1"]);
  assert.equal(item.fields.needsHumanSince, "");
  assert.match(store.comments.join("\n"), /restarted from the beginning/);
});

test("keeps the lease and the worker alive while a question is outstanding", async () => {
  const item = makeItem();
  const store = new FakeStore([item]);
  const handle = new FakeHandle(
    {
      status: "completed",
      summary: "Finished after the answer.",
    },
    { outcome: "done", details: "Committed to main." },
    {
      kind: "question",
      prompt: "Should the implementation use option A or option B?",
    },
    true,
  );
  const daemon = new RunnerDaemon({
    store,
    profile: makeProfile(),
    executor: new FakeExecutor(handle),
    attention: new AttentionService({ store }),
    logger: silentLogger,
  });

  await daemon.runOnce();

  const log = store.comments.join("\n");
  assert.match(log, /option A or option B/);
  assert.match(log, /machine-a/);
  assert.match(log, /Attention resolved/);
  assert.deepEqual(store.attentionRequests, ["item-1"]);
  assert.deepEqual(store.attentionResolutions, ["item-1"]);
  assert.equal(item.fields.needsHumanSince, "");
  assert.equal(handle.interrupted, undefined);
  assert.equal(handle.completed, true);
  assert.equal(store.releases[0].status, "done");
});

test("blocks a task that is waiting on something outside the human's control", async () => {
  const item = makeItem();
  const store = new FakeStore([item]);
  const handle = new FakeHandle({
    status: "blocked",
    summary: "Waiting on an upstream release.",
  });
  const daemon = new RunnerDaemon({
    store,
    profile: makeProfile(),
    executor: new FakeExecutor(handle),
    attention: new AttentionService({ store }),
    logger: silentLogger,
  });

  await daemon.runOnce();

  assert.equal(store.releases[0].status, "blocked");
  assert.deepEqual(store.attentionRequests, []);
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
  assert.match(store.comments.at(-1), /Agent completed/);
});

test("records the delivery before a post-delivery lease loss", async () => {
  const store = new FakeStore([makeItem()], {
    heartbeat: [
      { renewed: true },
      { renewed: false, reason: "lease-expired" },
    ],
  });
  const handle = new FakeHandle(undefined, {
    outcome: "done",
    details: "Committed to main.",
    url: "https://github.com/example/tool/commit/0123456789abcdef0123456789abcdef01234567",
  });
  const profile = makePlaybookProfile({
    maximum: 1,
    panCapacity: 1,
  });
  profile.playbooks = [profile.playbooks[0]];
  const daemon = new RunnerDaemon({
    store,
    profile,
    executor: new FakeExecutor(handle),
    logger: silentLogger,
  });

  await daemon.runOnce();

  assert.equal(store.releases.length, 0);
  assert.match(store.comments.at(-1), /Committed to main\./);
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
    attention: new AttentionService({ store }),
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

test("never claims or writes to a closed Issue whose Project fields still look ready", async () => {
  const item = makeItem();
  item.state = "closed";
  const store = new FakeStore([item]);
  const executor = new FakeExecutor(new FakeHandle());
  const daemon = new RunnerDaemon({
    store,
    profile: makeProfile(),
    executor,
    logger: silentLogger,
  });

  await daemon.runOnce();

  assert.equal(store.claims.length, 0);
  assert.equal(executor.started, undefined);
  assert.equal(store.comments.length, 0);
  assert.equal(store.attentionRequests.length, 0);
  assert.equal(store.releases.length, 0);
});

test("aborts the claim when an Issue closes between poll and claim without any GitHub write", async () => {
  // Under test: the DAEMON's reaction to a not-claimed (issue-closed) claim
  // result. The item is OPEN during selection (so it passes the open filter and
  // dispatchBlocker and claimWithLease is actually reached), and the store
  // returns an injected issue-closed result. The daemon must abort cleanly
  // without starting execution, commenting, requesting attention, or releasing.
  const item = makeItem();
  item.state = "open";
  const store = new FakeStore([item], {
    claimResults: [{ claimed: false, reason: "issue-closed", item }],
  });
  const executor = new FakeExecutor(new FakeHandle());
  const daemon = new RunnerDaemon({
    store,
    profile: makeProfile(),
    executor,
    logger: silentLogger,
  });

  await daemon.runOnce();

  assert.equal(store.claims.length, 0);
  assert.equal(executor.started, undefined);
  assert.equal(store.comments.length, 0);
  assert.equal(store.attentionRequests.length, 0);
  assert.equal(store.releases.length, 0);
});

test("still selects an open Issue with the same ready fields", async () => {
  const item = makeItem();
  item.state = "open";
  const store = new FakeStore([item]);
  const executor = new FakeExecutor(new FakeHandle());
  const daemon = new RunnerDaemon({
    store,
    profile: makeProfile(),
    executor,
    logger: silentLogger,
  });

  await daemon.runOnce();

  assert.equal(store.claims.length, 1);
  assert.equal(executor.started.item.number, 1);
  assert.equal(store.releases.at(-1).status, "in-review");
});

test("logs a closed-Issue skip at most once across repeated polls", async () => {
  const item = makeItem();
  item.state = "closed";
  const store = new FakeStore([item]);
  const messages = [];
  const daemon = new RunnerDaemon({
    store,
    profile: makeProfile(),
    executor: new FakeExecutor(new FakeHandle()),
    logger: {
      ...silentLogger,
      info: (message) => messages.push(message),
    },
  });

  await daemon.tick();
  await daemon.tick();
  await daemon.tick();

  const closedSkips = messages.filter((message) =>
    /Skipping task #1: its Issue is closed\./.test(message),
  );
  assert.equal(closedSkips.length, 1);
});

test("skips legacy runner-stopped recovery for a closed Issue without any GitHub write", async () => {
  const item = makeItem();
  item.state = "closed";
  item.fields.status = "blocked";
  const store = new FakeStore([item], {
    issueComments: [
      {
        body: formatNeedsHuman({
          kind: "approval",
          prompt: "Runner failure: Runner stopped",
        }),
      },
    ],
  });
  const daemon = new RunnerDaemon({
    store,
    profile: makeProfile(),
    executor: new FakeExecutor(new FakeHandle()),
    logger: silentLogger,
  });

  await daemon.tick();

  assert.equal(store.claims.length, 0);
  assert.equal(store.releases.length, 0);
  assert.equal(store.comments.length, 0);
  assert.equal(store.attentionResolutions.length, 0);
  assert.equal(
    store.listCommentsCalls.length,
    0,
    "legacy recovery must short-circuit on the closed Issue before reading its comments",
  );
});

test("tick poll query filters to open items so closed Issues are excluded before dispatch", async () => {
  const item = makeItem();
  const store = new FakeStore([item]);
  const daemon = new RunnerDaemon({
    store,
    profile: makeProfile(),
    executor: new FakeExecutor(new FakeHandle()),
    logger: silentLogger,
  });

  await daemon.tick();

  const tickQuery = store.filterCalls.find(
    (filters) => filters.owner === "agent" && filters.status === "ready",
  );
  assert.ok(tickQuery, "tick must issue a ready-work poll query");
  assert.deepEqual(tickQuery, {
    owner: "agent",
    status: "ready",
    claimable: true,
    open: true,
  });
  assert.equal(
    tickQuery.open,
    true,
    "tick poll query must include open:true so closed Issues are never fetched for dispatch",
  );
});

test("legacy runner-stopped recovery query filters to open items so closed Issues are excluded", async () => {
  const item = makeItem();
  item.fields.status = "blocked";
  const store = new FakeStore([item], {
    issueComments: [
      {
        body: formatNeedsHuman({
          kind: "approval",
          prompt: "Runner failure: Runner stopped",
        }),
      },
    ],
  });
  const daemon = new RunnerDaemon({
    store,
    profile: makeProfile(),
    executor: new FakeExecutor(new FakeHandle()),
    logger: silentLogger,
  });

  await daemon.tick();

  const legacyQuery = store.filterCalls.find(
    (filters) => filters.owner === "agent" && filters.status === "blocked",
  );
  assert.ok(legacyQuery, "legacy recovery must issue a blocked-work query");
  assert.deepEqual(legacyQuery, {
    owner: "agent",
    status: "blocked",
    unclaimed: true,
    open: true,
  });
  assert.equal(
    legacyQuery.open,
    true,
    "legacy recovery query must include open:true so closed Issues are never recovered",
  );
});

test("discards a resume task whose Project item is closed without adopting or dispatching it", async () => {
  const item = makeItem();
  item.state = "closed";
  const task = {
    itemId: item.id,
    issueNumber: item.number,
    runner: "machine-a/pan-development/slot-1",
    playbookId: "pan-development",
    resumeAffinity: "resume:machine-a",
    workerState: "gone",
    requeue: true,
  };
  const executor = new ClosedResumeExecutor([task], new FakeHandle());
  const store = new FakeStore([item]);
  const daemon = new RunnerDaemon({
    store,
    profile: makeProfile(),
    executor,
    logger: silentLogger,
  });

  await daemon.tick();

  assert.ok(executor.discarded, "the closed resume task must be discarded");
  assert.equal(executor.discarded.task, task);
  assert.equal(executor.started, undefined);
  assert.equal(store.claims.length, 0);
  assert.equal(store.releases.length, 0);
});

class ClosedResumeExecutor {
  constructor(tasks, handle) {
    this.tasks = tasks;
    this.handle = handle;
  }

  async start(context) {
    this.started = context;
    return this.handle;
  }

  async listResumeTasks() {
    const tasks = this.tasks;
    this.tasks = [];
    return tasks;
  }

  async discardResumeTask(task, reason) {
    this.discarded = { task, reason };
  }
}

class FakeStore {
  constructor(
    items,
    {
      heartbeat = { renewed: true },
      commentFailures = 0,
      issueComments = [],
      claimFailure,
      releaseFailures = {},
      claimResults = [],
    } = {},
  ) {
    this.items = items;
    this.attentionRequests = [];
    this.attentionResolutions = [];
    this.heartbeatResults = Array.isArray(heartbeat)
      ? [...heartbeat]
      : [heartbeat];
    this.commentFailures = commentFailures;
    this.issueComments = issueComments;
    this.claimFailure = claimFailure;
    this.releaseFailures = { ...releaseFailures };
    this.claimResults = Array.isArray(claimResults) ? [...claimResults] : [];
    this.claims = [];
    this.comments = [];
    this.releases = [];
    this.heartbeats = [];
    this.listCommentsCalls = [];
    this.filterCalls = [];
  }

  async listByFilter(filters = {}) {
    this.filterCalls.push(filters);
    return this.items;
  }

  async getItem(itemId) {
    return this.items.find((item) => item.id === itemId);
  }

  async claimWithLease(claim) {
    const current = this.items.find((item) => item.id === claim.itemId);
    if (this.claimResults.length > 0) {
      const forced = this.claimResults.shift();
      if (!forced.claimed) {
        // An injected non-claimed result short-circuits before recording a
        // claim, so store.claims stays empty exactly as production aborts.
        return forced;
      }
      this.claims.push(claim);
      return forced;
    }
    this.claims.push(claim);
    if (this.claimFailure) {
      throw this.claimFailure;
    }
    return {
      claimed: true,
      item: current,
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

  async listComments(item) {
    this.listCommentsCalls.push(item);
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

  async requestHumanAttention({ itemId }) {
    const item = this.items.find((candidate) => candidate.id === itemId);
    item.fields.needsHumanSince = "2026-07-20T16:00:00Z";
    this.attentionRequests.push(itemId);
    return { requested: true, item };
  }

  async resolveHumanAttention({ itemId }) {
    const item = this.items.find((candidate) => candidate.id === itemId);
    item.fields.needsHumanSince = "";
    this.attentionResolutions.push(itemId);
    return { resolved: true, item };
  }

  async heartbeat(heartbeat) {
    this.heartbeats.push(heartbeat);
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
      sessionId: "00000000-0000-4000-8000-000000000001",
      repository: "example/tool",
      branch: "pan/issue-1",
      worktreePath: "C:\\worktrees\\issue-1",
      terminalTitle: "Pan #1 - Task",
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

class StartupRecoveryExecutor extends FakeExecutor {
  constructor(tasks, handle) {
    super(handle);
    this.tasks = tasks;
  }

  async listResumeTasks() {
    const tasks = this.tasks;
    this.tasks = [];
    return tasks;
  }

  async adoptTask(task, item) {
    this.adopted = { task, item };
    return this.handle;
  }

  async markInterruptedRequeued(task) {
    this.requeued = task;
  }
}

class RecoveryStore extends FakeStore {
  async listByFilter(filters = {}) {
    return this.items.filter(
      (item) =>
        (!filters.owner || item.fields.owner === filters.owner) &&
        (!filters.status || item.fields.status === filters.status),
    );
  }

  async claimWithLease(claim) {
    const result = await super.claimWithLease(claim);
    result.item.fields.status = claim.status;
    result.item.fields.claimedBy = claim.runner;
    result.item.fields.leaseUntil = claim.leaseUntil;
    return result;
  }

  async release(release) {
    const result = await super.release(release);
    const item = this.items.find((candidate) => candidate.id === release.itemId);
    item.fields.status = release.status;
    item.fields.claimedBy = release.resumeAffinity ?? "";
    item.fields.leaseUntil = "";
    return { ...result, item };
  }
}

class FakeHandle {
  constructor(
    result = {
      status: "completed",
      summary: "Completed.",
    },
    outcome = {
      outcome: "needs-review",
      url: "https://github.com/example/tool/pull/42",
    },
    needsHuman,
    answeredAtTerminal = false,
  ) {
    this.result = result;
    this.outcome = outcome;
    this.completed = false;
    this.needsHuman = needsHuman;
    this.answeredAtTerminal = answeredAtTerminal;
  }

  async wait({ onNeedsHuman, onAttentionCleared } = {}) {
    if (this.needsHuman) {
      await onNeedsHuman?.({
        ...this.needsHuman,
        locator: this.locator(),
      });
      if (this.answeredAtTerminal) {
        await onAttentionCleared?.();
      }
    }
    return this.result;
  }

  async complete() {
    this.completed = true;
    return this.outcome;
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
      terminalTitle: "Pan #1 - Task",
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

test("flags a permanently unsatisfiable requirement instead of skipping it forever", async () => {
  const store = new FakeStore([
    makeItem({
      requirements: ["repo:example/tool", "env:local", "delivery:pull-request"],
    }),
  ]);
  const warnings = [];
  const daemon = new RunnerDaemon({
    store,
    profile: makeProfile(),
    executor: new FakeExecutor(new FakeHandle({ status: "completed" })),
    logger: { ...silentLogger, warn: (message) => warnings.push(message) },
  });

  await daemon.runOnce();
  await daemon.runOnce();
  await daemon.runOnce();

  assert.equal(store.claims.length, 0);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /delivery:pull-request/);
  assert.deepEqual(store.attentionRequests, ["item-1"]);
});

test("leaves a satisfiable requirement unflagged so it can still be claimed", async () => {
  const store = new FakeStore([makeItem()]);
  const warnings = [];
  const daemon = new RunnerDaemon({
    store,
    profile: makeProfile(),
    executor: new FakeExecutor(
      new FakeHandle({ status: "completed", summary: "Done." }),
    ),
    logger: { ...silentLogger, warn: (message) => warnings.push(message) },
  });

  await daemon.runOnce();

  assert.equal(store.claims.length, 1);
  assert.deepEqual(store.attentionRequests, []);
  assert.deepEqual(warnings, []);
});

function makeItem({
  id = "item-1",
  number = 1,
  requirements = ["repo:example/tool", "env:local"],
  priority = "normal",
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
      priority,
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
