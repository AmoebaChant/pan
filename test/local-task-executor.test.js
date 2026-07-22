import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  LocalTaskExecutor,
  normalizeGitHubRepositoryUrl,
  resolveWorkstreamReadme,
} from "../src/local-task-executor.js";

test("confines workstream README paths to the data repository", () => {
  const store = path.resolve("private-data");

  assert.equal(
    resolveWorkstreamReadme(store, "parent/child"),
    path.join(store, "workstreams", "parent", "child", "README.md"),
  );
  assert.throws(
    () => resolveWorkstreamReadme(store, "../../outside"),
    /invalid segment/,
  );
  assert.throws(
    () => resolveWorkstreamReadme(store, "parent\\outside"),
    /using \/ separators/,
  );
});

test("normalizes supported GitHub remote URL formats", () => {
  assert.equal(
    normalizeGitHubRepositoryUrl("https://github.com/example/tool.git"),
    "example/tool",
  );
  assert.equal(
    normalizeGitHubRepositoryUrl("git@github.com:example/tool.git"),
    "example/tool",
  );
  assert.equal(
    normalizeGitHubRepositoryUrl("ssh://git@github.com/example/tool.git"),
    "example/tool",
  );
  assert.equal(
    normalizeGitHubRepositoryUrl("https://example.com/example/tool.git"),
    undefined,
  );
});

test("allocates concurrent tasks and opens their interactive worker terminals", async () => {
  const fixture = await createFixture();
  const commands = new FakeCommands();
  const ids = ["allocation-one", "allocation-two"];
  const terminalLaunches = [];
  const resumeRecords = [];
  const executor = new LocalTaskExecutor({
    profile: fixture.profile,
    commands,
    spawnProcess: (...args) => {
      terminalLaunches.push(args);
      return successfulSpawn();
    },
    randomId: () => ids.shift(),
  });

  try {
    const handles = await Promise.all([
      executor.start({
        ...makeStartOptions(1),
        onResume: async (record) => resumeRecords.push(record),
      }),
      executor.start({
        ...makeStartOptions(1),
        onResume: async (record) => resumeRecords.push(record),
      }),
    ]);
    const contexts = await Promise.all(
      handles.map((handle) =>
        readFile(path.join(handle.statePath, "context.json"), "utf8").then(JSON.parse),
      ),
    );

    assert.notEqual(handles[0].branch, handles[1].branch);
    assert.notEqual(handles[0].worktreePath, handles[1].worktreePath);
    assert.notEqual(handles[0].statePath, handles[1].statePath);
    assert.equal(contexts[0].playbook.id, "pan-development");
    assert.deepEqual(contexts[0].playbook.instructions, ["Run tests."]);
    assert.equal(contexts[0].playbook.delivery, "pull-request");
    assert.equal(resumeRecords.length, 2);
    assert.equal(resumeRecords[0].machine, "machine-a");
    assert.equal(resumeRecords[0].playbook, "pan-development");
    assert.match(resumeRecords[0].branch, /^pan\/issue-1-/);
    assert.match(resumeRecords[0].worktreePath, /issue-1-/);
    assert.equal(terminalLaunches.length, 2);
    for (const [executable, args, options] of terminalLaunches) {
      assert.equal(executable, "wt");
      assert.equal(args[args.indexOf("-p") + 1], "PowerShell");
      assert.match(args[args.indexOf("--title") + 1], /^PAN #1 - /);
      const commandIndex = args.indexOf("--suppressApplicationTitle") + 1;
      assert.equal(args[commandIndex], process.execPath);
      assert.match(args[commandIndex + 1], /src[\\/]task-worker\.js$/);
      assert.equal(args[commandIndex + 2], "--context");
      assert.match(args[commandIndex + 3], /context-[a-f0-9-]+\.json$/);
      assert.deepEqual(options, {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
    }
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("cleans a reserved worktree and state directory after launch failure", async () => {
  const fixture = await createFixture();
  const commands = new FakeCommands();
  const executor = new LocalTaskExecutor({
    profile: fixture.profile,
    commands,
    spawnProcess: failingSpawn,
    randomId: () => "failed-launch",
  });

  try {
    await assert.rejects(
      executor.start(makeStartOptions(2)),
      /terminal failed/,
    );

    assert.ok(
      commands.calls.some(
        ({ args }) =>
          args.includes("worktree") &&
          args.includes("remove") &&
          args.includes("--force"),
      ),
    );
    assert.ok(
      commands.calls.some(
        ({ args }) =>
          args.includes("branch") &&
          args.includes("--delete") &&
          args.includes("--force"),
      ),
    );
    await assert.rejects(
      readFile(
        path.join(fixture.profile.stateDirectory, "issue-2-failedlaunch"),
        "utf8",
      ),
      /ENOENT/,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("uses the Windows Terminal default profile when none is configured", async () => {
  const fixture = await createFixture();
  const commands = new FakeCommands();
  const terminalLaunches = [];
  delete fixture.profile.terminal.profile;
  const executor = new LocalTaskExecutor({
    profile: fixture.profile,
    commands,
    spawnProcess: (...args) => {
      terminalLaunches.push(args);
      return successfulSpawn();
    },
    randomId: () => "default-terminal-profile",
  });

  try {
    await executor.start(makeStartOptions(3));

    assert.equal(terminalLaunches.length, 1);
    assert.ok(!terminalLaunches[0][1].includes("-p"));
    assert.ok(terminalLaunches[0][1].includes("--suppressApplicationTitle"));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("uses a separate cleanup budget after the task deadline expires", async () => {
  const fixture = await createFixture();
  const commands = new FakeCommands();
  let now = 0;
  const executor = new LocalTaskExecutor({
    profile: fixture.profile,
    commands,
    spawnProcess: () => {
      now = 101;
      return failingSpawn();
    },
    randomId: () => "expired-launch",
    now: () => new Date(now),
  });

  try {
    await assert.rejects(
      executor.start({
        ...makeStartOptions(3),
        deadline: 100,
      }),
      /terminal failed/,
    );

    const cleanup = commands.calls.find(
      ({ args }) =>
        args.includes("worktree") &&
        args.includes("remove") &&
        args.includes("--force"),
    );
    assert.equal(cleanup.options.timeout, 30_000);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("fails unlimited tasks when their worker process disappears", async () => {
  const fixture = await createFixture();
  const executor = new LocalTaskExecutor({
    profile: fixture.profile,
    commands: new FakeCommands(),
    spawnProcess: successfulSpawn,
    randomId: () => "lost-worker",
    workerIsAlive: () => false,
  });

  try {
    const handle = await executor.start({
      ...makeStartOptions(4),
      deadline: undefined,
    });
    const context = JSON.parse(
      await readFile(path.join(handle.statePath, "context.json"), "utf8"),
    );
    await writeFile(context.paths.worker, JSON.stringify({ pid: 1234 }));

    assert.deepEqual(await handle.wait(), {
      status: "failed",
      summary: "The task worker exited without reporting a result.",
    });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("cancels an unlimited task before its worker reports a result", async () => {
  const fixture = await createFixture();
  const executor = new LocalTaskExecutor({
    profile: fixture.profile,
    commands: new FakeCommands(),
    spawnProcess: successfulSpawn,
    randomId: () => "cancelled-worker",
  });

  try {
    const handle = await executor.start({
      ...makeStartOptions(5),
      deadline: undefined,
    });
    const waiting = handle.wait();
    await handle.cancel("Runner stopped: Ctrl+C");

    assert.deepEqual(await waiting, {
      status: "failed",
      summary: "Runner stopped: Ctrl+C",
    });
    assert.deepEqual(
      JSON.parse(await readFile(handle.cancelPath, "utf8")),
      {
        status: "failed",
        summary: "Runner stopped: Ctrl+C",
      },
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("resumes an interrupted task with its saved worktree and Copilot session", async () => {
  const fixture = await createFixture();
  const commands = new FakeCommands();
  const terminalLaunches = [];
  const executor = new LocalTaskExecutor({
    profile: fixture.profile,
    commands,
    spawnProcess: (...args) => {
      terminalLaunches.push(args);
      return successfulSpawn();
    },
    randomId: () => "resumable-task",
    sessionIdFactory: () => "00000000-0000-4000-8000-000000000001",
  });

  try {
    const first = await executor.start({
      ...makeStartOptions(9),
      deadline: undefined,
    });
    const firstContext = JSON.parse(
      await readFile(path.join(first.statePath, "context.json"), "utf8"),
    );

    await first.interrupt("Runner stopped: Ctrl+C");
    const resumed = await executor.start({
      ...makeStartOptions(9),
      runner: "runner/slot-resumed",
      deadline: undefined,
    });
    const resumedContext = JSON.parse(
      await readFile(path.join(resumed.statePath, "context.json"), "utf8"),
    );

    assert.equal(resumed.statePath, first.statePath);
    assert.equal(resumed.worktreePath, first.worktreePath);
    assert.equal(resumed.branch, first.branch);
    assert.equal(firstContext.copilot.sessionId, "00000000-0000-4000-8000-000000000001");
    assert.equal(resumedContext.copilot.sessionId, firstContext.copilot.sessionId);
    assert.equal(resumedContext.copilot.resume, true);
    assert.equal(resumedContext.runner, "runner/slot-resumed");
    assert.equal(terminalLaunches.length, 2);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("cancels a worker that does not start within the grace period", async () => {
  const fixture = await createFixture();
  let now = 0;
  const executor = new LocalTaskExecutor({
    profile: fixture.profile,
    commands: new FakeCommands(),
    spawnProcess: successfulSpawn,
    randomId: () => "late-worker",
    now: () => new Date(now),
    sleep: async () => {
      now = 31_000;
    },
  });

  try {
    const handle = await executor.start({
      ...makeStartOptions(6),
      deadline: undefined,
    });

    assert.deepEqual(await handle.wait(), {
      status: "failed",
      summary: "The task worker did not start.",
    });
    assert.deepEqual(
      JSON.parse(await readFile(handle.cancelPath, "utf8")),
      {
        status: "failed",
        summary: "The task worker did not start.",
      },
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("does not finish cancellation until the worker process stops", async () => {
  const fixture = await createFixture();
  let alive = true;
  let attempts = 0;
  const errors = [];
  const executor = new LocalTaskExecutor({
    profile: fixture.profile,
    commands: new FakeCommands(),
    spawnProcess: successfulSpawn,
    randomId: () => "stubborn-worker",
    workerIsAlive: () => alive,
    terminateWorker: async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("taskkill failed");
      }
      alive = false;
    },
    sleep: async () => {},
    logger: {
      error: (...args) => errors.push(args),
    },
  });

  try {
    const handle = await executor.start({
      ...makeStartOptions(7),
      deadline: undefined,
    });
    await writeFile(handle.workerPath, JSON.stringify({ pid: 1234 }));

    await handle.cancel("Runner stopped");

    assert.equal(attempts, 2);
    assert.equal(errors.length, 1);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("validates agent-delivered commits on the default branch", async () => {
  const fixture = await createFixture();
  const commands = new DirectDeliveryCommands();
  const executor = new LocalTaskExecutor({
    profile: fixture.profile,
    commands,
    spawnProcess: successfulSpawn,
    randomId: () => "direct-delivery",
  });

  try {
    const handle = await executor.start({
      ...makeStartOptions(8),
      playbook: {
        id: "pan-development",
        instructions: ["Run tests."],
        delivery: "direct",
      },
      deadline: undefined,
    });
    commands.branch = handle.branch;

    const delivery = await handle.complete({
      status: "completed",
      summary: "Implemented directly.",
      delivery: {
        mode: "direct",
        commit: "0123456789abcdef0123456789abcdef01234567",
        url: "https://github.com/example/tool/commit/0123456789abcdef0123456789abcdef01234567",
      },
    });

    assert.deepEqual(delivery, {
      mode: "direct",
      commit: "0123456789abcdef0123456789abcdef01234567",
      url: "https://github.com/example/tool/commit/0123456789abcdef0123456789abcdef01234567",
    });
    assert.equal(
      commands.calls.some(({ args }) => args.includes("push")),
      false,
    );
    assert.equal(
      commands.calls.some(({ args }) => args.includes("rebase")),
      false,
    );
    assert.equal(
      commands.calls.some(({ executable }) => executable === "gh"),
      false,
    );
    assert.ok(
      commands.calls.some(
        ({ args }) =>
          args.includes("fetch") && args.includes("main"),
      ),
    );
    assert.ok(
      commands.calls.some(
        ({ args }) =>
          args.includes("merge-base") && args.includes("FETCH_HEAD"),
      ),
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("rejects direct delivery that produced no task commit", async () => {
  const fixture = await createFixture();
  const commands = new NoOpDeliveryCommands();
  const executor = new LocalTaskExecutor({
    profile: fixture.profile,
    commands,
    spawnProcess: successfulSpawn,
    randomId: () => "no-op-delivery",
  });

  try {
    const handle = await executor.start({
      ...makeStartOptions(10),
      playbook: {
        id: "pan-development",
        instructions: [],
        delivery: "direct",
      },
      deadline: undefined,
    });
    commands.branch = handle.branch;

    await assert.rejects(
      handle.complete({
        status: "completed",
        summary: "No change.",
        delivery: {
          mode: "direct",
          commit: "0123456789abcdef0123456789abcdef01234567",
          url: "https://github.com/example/tool/commit/0123456789abcdef0123456789abcdef01234567",
        },
      }),
      /without producing a new commit/,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("validates an agent-created pull request", async () => {
  const fixture = await createFixture();
  const commands = new PullRequestDeliveryCommands();
  const executor = new LocalTaskExecutor({
    profile: fixture.profile,
    commands,
    spawnProcess: successfulSpawn,
    randomId: () => "pull-request-delivery",
  });

  try {
    const handle = await executor.start(makeStartOptions(9));
    commands.branch = handle.branch;

    const delivery = await handle.complete({
      status: "completed",
      summary: "Implemented through review.",
      delivery: {
        mode: "pull-request",
        commit: "0123456789abcdef0123456789abcdef01234567",
        url: "https://github.com/example/tool/pull/42",
      },
    });

    assert.deepEqual(delivery, {
      mode: "pull-request",
      commit: "0123456789abcdef0123456789abcdef01234567",
      url: "https://github.com/example/tool/pull/42",
    });
    const view = commands.calls.find(
      ({ executable, args }) =>
        executable === "gh" &&
        args[0] === "pr" &&
        args[1] === "view",
    );
    assert.equal(view.args[2], "https://github.com/example/tool/pull/42");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("rejects pull requests that do not link the source Issue", async () => {
  const fixture = await createFixture();
  const commands = new PullRequestDeliveryCommands();
  commands.body = "Implements the requested change.";
  const executor = new LocalTaskExecutor({
    profile: fixture.profile,
    commands,
    spawnProcess: successfulSpawn,
    randomId: () => "unlinked-pull-request",
  });

  try {
    const handle = await executor.start(makeStartOptions(11));
    commands.branch = handle.branch;

    await assert.rejects(
      handle.complete({
        status: "completed",
        summary: "Implemented through review.",
        delivery: {
          mode: "pull-request",
          commit: "0123456789abcdef0123456789abcdef01234567",
          url: "https://github.com/example/tool/pull/42",
        },
      }),
      /does not match the task delivery/,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

class FakeCommands {
  constructor() {
    this.calls = [];
  }

  async run(executable, args, options = {}) {
    this.calls.push({ executable, args, options });
    if (args.includes("get-url")) {
      return "https://github.com/example/tool.git";
    }
    return "";
  }
}

class PullRequestDeliveryCommands extends FakeCommands {
  constructor() {
    super();
    this.headReads = 0;
    this.body = "Closes example/data#9";
  }

  async run(executable, args, options = {}) {
    this.calls.push({ executable, args, options });
    if (args.includes("get-url")) {
      return "https://github.com/example/tool.git";
    }
    if (args.includes("--show-current")) {
      return this.branch;
    }
    if (args.includes("--porcelain")) {
      return "";
    }
    if (args.includes("rev-parse") && args.includes("HEAD")) {
      this.headReads += 1;
      return this.headReads === 1
        ? "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        : "0123456789abcdef0123456789abcdef01234567";
    }
    if (executable === "gh" && args[0] === "pr" && args[1] === "view") {
      return JSON.stringify({
        url: "https://github.com/example/tool/pull/42",
        state: "OPEN",
        headRefName: this.branch,
        headRefOid: "0123456789abcdef0123456789abcdef01234567",
        baseRefName: "main",
        body: this.body,
      });
    }
    return "";
  }
}

class DirectDeliveryCommands extends FakeCommands {
  constructor() {
    super();
    this.headReads = 0;
  }

  async run(executable, args, options = {}) {
    this.calls.push({ executable, args, options });
    if (args.includes("get-url")) {
      return "https://github.com/example/tool.git";
    }
    if (args.includes("--show-current")) {
      return this.branch;
    }
    if (args.includes("--porcelain")) {
      return "";
    }
    if (args.includes("rev-parse") && args.includes("HEAD")) {
      this.headReads += 1;
      return this.headReads === 1
        ? "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        : "0123456789abcdef0123456789abcdef01234567";
    }
    return "";
  }
}

class NoOpDeliveryCommands extends DirectDeliveryCommands {
  async run(executable, args, options = {}) {
    if (args.includes("rev-parse") && args.includes("HEAD")) {
      this.calls.push({ executable, args, options });
      return "0123456789abcdef0123456789abcdef01234567";
    }
    return super.run(executable, args, options);
  }
}

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "pan-executor-"));
  const store = path.join(root, "data");
  await mkdir(path.join(store, "workstreams", "example"), {
    recursive: true,
  });
  await writeFile(
    path.join(store, "workstreams", "example", "README.md"),
    "# Example\n",
  );
  return {
    root,
    profile: {
      repositories: {
        "example/tool": {
          path: path.join(root, "tool"),
          defaultBranch: "main",
        },
      },
      workspaceRoot: path.join(root, "worktrees"),
      stateDirectory: path.join(root, "state"),
      store: { path: store },
      copilot: { executable: "copilot" },
      taskBudget: {
        wallClockMinutes: 60,
        maxAiCredits: 30,
        maxAutopilotContinues: 3,
      },
      terminal: {
        executable: "wt",
        window: "0",
        profile: "PowerShell",
      },
      machine: "machine-a",
    },
  };
}

function makeStartOptions(number) {
  return {
    item: {
      number,
      title: "Implement the task",
      body: "Acceptance criteria.",
      url: `https://github.com/example/data/issues/${number}`,
      repository: "example/data",
      comments: [],
      fields: { workstream: "example" },
    },
    repository: "example/tool",
    runner: `runner/slot-${number}`,
    playbook: {
      id: "pan-development",
      instructions: ["Run tests."],
    },
    deadline: Date.now() + 60_000,
  };
}

function successfulSpawn() {
  const child = new EventEmitter();
  child.unref = () => {};
  queueMicrotask(() => child.emit("spawn"));
  return child;
}

function failingSpawn() {
  const child = new EventEmitter();
  child.unref = () => {};
  queueMicrotask(() => child.emit("error", new Error("terminal failed")));
  return child;
}
