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

test("allocates unique branches, worktrees, and state for concurrent tasks", async () => {
  const fixture = await createFixture();
  const commands = new FakeCommands();
  const ids = ["allocation-one", "allocation-two"];
  const executor = new LocalTaskExecutor({
    profile: fixture.profile,
    commands,
    spawnProcess: successfulSpawn,
    randomId: () => ids.shift(),
  });

  try {
    const handles = await Promise.all([
      executor.start(makeStartOptions(1)),
      executor.start(makeStartOptions(1)),
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
