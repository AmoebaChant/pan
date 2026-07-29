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
import {
  buildTaskCopilotArgs,
  buildTaskCopilotSpawnOptions,
} from "../src/task-command.js";

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
    assert.equal(resumeRecords.length, 2);
    assert.equal(resumeRecords[0].machine, "machine-a");
    assert.equal(resumeRecords[0].playbook, "pan-development");
    assert.match(resumeRecords[0].branch, /^pan\/issue-1-/);
    assert.match(resumeRecords[0].worktreePath, /issue-1-/);
    assert.equal(terminalLaunches.length, 2);
    for (const [executable, args, options] of terminalLaunches) {
      assert.equal(executable, "wt");
      assert.equal(args[args.indexOf("-p") + 1], "PowerShell");
      assert.match(args[args.indexOf("--title") + 1], /^Pan #1 - /);
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

test("holds a task past its budget while a question is outstanding", async () => {
  const fixture = await createFixture();
  let now = 0;
  let tick = 0;
  let handle;
  const executor = new LocalTaskExecutor({
    profile: fixture.profile,
    commands: new FakeCommands(),
    spawnProcess: successfulSpawn,
    randomId: () => "waiting-worker",
    workerIsAlive: () => true,
    now: () => new Date(now),
    sleep: async () => {
      tick += 1;
      if (tick === 1) {
        now = 300_000;
      } else if (tick === 2) {
        await rm(handle.needsHumanPath, { force: true });
        now = 400_000;
      } else {
        await writeFile(
          handle.resultPath,
          JSON.stringify({
            status: "completed",
            summary: "Finished after the answer.",
          }),
        );
        now = 410_000;
      }
    },
  });

  try {
    handle = await executor.start({
      ...makeStartOptions(7),
      deadline: 100_000,
    });
    await writeFile(handle.workerPath, JSON.stringify({ pid: 1234 }));
    await writeFile(
      handle.needsHumanPath,
      JSON.stringify({
        kind: "question",
        prompt: "Option A or option B?",
      }),
    );

    const questions = [];
    let cleared = 0;
    const result = await handle.wait({
      onNeedsHuman: (needsHuman) => {
        questions.push(needsHuman);
      },
      onAttentionCleared: () => {
        cleared += 1;
      },
    });

    assert.equal(result.status, "completed");
    assert.equal(questions.length, 1);
    assert.match(questions[0].prompt, /Option A or option B\?/);
    assert.equal(cleared, 1);
    assert.equal(handle.attentionSince, undefined);
    assert.equal(handle.deadline, 500_000);
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

test("completes a runner-managed task without deleting its branch", async () => {
  const fixture = await createFixture();
  const commands = new CompletableCommands();
  const executor = new LocalTaskExecutor({
    profile: fixture.profile,
    commands,
    spawnProcess: successfulSpawn,
    randomId: () => "completed-task",
  });

  try {
    const handle = await executor.start({
      ...makeStartOptions(8),
      playbook: {
        id: "pan-development",
        instructions: ["Run tests."],
      },
      deadline: undefined,
    });
    commands.branch = handle.branch;

    const outcome = await handle.complete({
      status: "completed",
      outcome: "needs-review",
      summary: "Implemented and opened review.",
      details: "Opened a pull request against main.",
      url: "https://github.com/example/tool/pull/42",
    });

    assert.deepEqual(outcome, {
      outcome: "needs-review",
      details: "Opened a pull request against main.",
      url: "https://github.com/example/tool/pull/42",
    });
    assert.equal(
      commands.calls.some(({ executable }) => executable === "gh"),
      false,
      "the runner must not verify how the agent delivered",
    );
    assert.equal(
      commands.calls.some(({ args }) => args.includes("push")),
      false,
    );
    assert.ok(
      commands.calls.some(
        ({ args }) => args.includes("worktree") && args.includes("remove"),
      ),
    );
    assert.equal(
      commands.calls.some(
        ({ args }) => args.includes("branch") && args.includes("--delete"),
      ),
      false,
      "unpushed work must survive cleanup",
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("keeps a completed task isolated to its own branch and worktree", async () => {
  const fixture = await createFixture();
  const commands = new CompletableCommands();
  const executor = new LocalTaskExecutor({
    profile: fixture.profile,
    commands,
    spawnProcess: successfulSpawn,
    randomId: () => "isolation",
  });

  try {
    const handle = await executor.start({
      ...makeStartOptions(9),
      deadline: undefined,
    });

    commands.branch = "main";
    await assert.rejects(
      handle.complete({ status: "completed", summary: "Wrong branch." }),
      /changed branches/,
    );

    commands.branch = handle.branch;
    commands.dirty = " M src/index.js";
    await assert.rejects(
      handle.complete({ status: "completed", summary: "Left work behind." }),
      /uncommitted changes/,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("defaults an unreported outcome to review and rejects an unknown one", async () => {
  const fixture = await createFixture();
  const commands = new CompletableCommands();
  const executor = new LocalTaskExecutor({
    profile: fixture.profile,
    commands,
    spawnProcess: successfulSpawn,
    randomId: () => "outcome",
  });

  try {
    const handle = await executor.start({
      ...makeStartOptions(10),
      deadline: undefined,
    });
    commands.branch = handle.branch;

    assert.deepEqual(
      await handle.complete({ status: "completed", summary: "Delivered." }),
      { outcome: "needs-review" },
    );
    await assert.rejects(
      handle.complete({
        status: "completed",
        outcome: "merged",
        summary: "Delivered.",
      }),
      /outcome must be "done" or "needs-review"/,
    );
    await assert.rejects(
      handle.complete({
        status: "completed",
        outcome: "done",
        summary: "Delivered.",
        url: "not-a-url",
      }),
      /URL must be an absolute URL/,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("runs no git and launches the agent in the playbook working directory", async () => {
  const fixture = await createFixture();
  const commands = new FakeCommands();
  const terminalLaunches = [];
  const resumeRecords = [];
  const workingDirectory = path.join(fixture.root, "metarepo");
  const executor = new LocalTaskExecutor({
    profile: fixture.profile,
    commands,
    spawnProcess: (...args) => {
      terminalLaunches.push(args);
      return successfulSpawn();
    },
    randomId: () => "agent-managed",
  });

  try {
    const handle = await executor.start({
      ...makeStartOptions(7),
      playbook: {
        id: "metarepo-development",
        instructions: ["Create your own isolated workspace."],
        workingDirectory,
      },
      onResume: async (record) => resumeRecords.push(record),
    });
    const context = JSON.parse(
      await readFile(path.join(handle.statePath, "context.json"), "utf8"),
    );

    assert.deepEqual(
      commands.calls,
      [],
      "an agent-managed playbook must not run any git command in the runner",
    );
    assert.deepEqual(context.target, {
      repository: "example/tool",
      workingDirectory,
    });
    assert.equal(
      buildTaskCopilotSpawnOptions(context, {}).cwd,
      workingDirectory,
    );
    assert.equal(
      buildTaskCopilotArgs(context, "Do the task.")[1],
      workingDirectory,
      "an agent-managed target has no worktreePath, so -C must not be undefined",
    );
    assert.equal(resumeRecords[0].worktreePath, workingDirectory);
    assert.equal(resumeRecords[0].branch, undefined);
    assert.equal(terminalLaunches.length, 1);

    const outcome = await handle.complete({
      status: "completed",
      outcome: "needs-review",
      summary: "Delivered through the metarepo tooling.",
      details: "Pushed vbranch and opened review 4213.",
      url: "https://example.visualstudio.com/Repo/pullrequest/4213",
    });
    assert.deepEqual(outcome, {
      outcome: "needs-review",
      details: "Pushed vbranch and opened review 4213.",
      url: "https://example.visualstudio.com/Repo/pullrequest/4213",
    });
    assert.deepEqual(
      commands.calls,
      [],
      "an agent-managed playbook must not verify delivery with git",
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("keeps an agent-managed task resumable when the runner interrupts it", async () => {
  const fixture = await createFixture();
  const commands = new FakeCommands();
  const workingDirectory = path.join(fixture.root, "metarepo");
  const executor = new LocalTaskExecutor({
    profile: fixture.profile,
    commands,
    spawnProcess: () => successfulSpawn(),
    randomId: () => "agent-managed-interrupt",
  });

  try {
    const handle = await executor.start({
      ...makeStartOptions(8),
      playbook: {
        id: "metarepo-development",
        instructions: ["Create your own isolated workspace."],
        workingDirectory,
      },
    });

    await handle.interrupt("Runner stopped: Ctrl+C");

    const pointer = JSON.parse(await readFile(handle.resumePath, "utf8"));
    assert.equal(pointer.requeue, true);
    assert.deepEqual(
      pointer.target,
      { repository: "example/tool", workingDirectory },
      "the requeue pointer must keep the agent-managed target shape",
    );
    assert.deepEqual(
      commands.calls,
      [],
      "interrupting an agent-managed task must not run git",
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

class CompletableCommands extends FakeCommands {
  constructor() {
    super();
    this.dirty = "";
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
      return this.dirty;
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
