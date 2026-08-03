import assert from "node:assert/strict";
import test from "node:test";

import {
  buildTaskCopilotArgs,
  buildTaskCopilotSpawnOptions,
} from "../src/index.js";

test("keeps Copilot attached to the worker terminal", () => {
  const env = { PAN_TASK_RESULT: "C:\\state\\agent-result.json" };

  assert.deepEqual(buildTaskCopilotSpawnOptions(makeTask(), env), {
    cwd: "C:\\worktree",
    env,
    stdio: "inherit",
    windowsHide: false,
  });
});

test("opens an interactive Copilot shell with the initial task", () => {
  const prompt = "Do the task.";
  const args = buildTaskCopilotArgs(makeTask(), prompt);

  assert.ok(!args.includes("--max-ai-credits"));
  assert.ok(!args.includes("-p"));
  assert.ok(!args.includes("--autopilot"));
  assert.ok(!args.includes("--allow-all-tools"));
  assert.ok(!args.includes("--no-ask-user"));
  assert.ok(!args.includes("--max-autopilot-continues"));
  assert.ok(!args.includes("--deny-tool=shell(git:*)"));
  assert.ok(!args.includes("--deny-tool=shell(gh:*)"));
  assert.equal(
    args[args.indexOf("--session-id") + 1],
    "00000000-0000-4000-8000-000000000001",
  );
  assert.equal(
    args[args.indexOf("--name") + 1],
    "Pan #34 pan-life: Fix the bird.txt typo",
  );
  assert.deepEqual(args.slice(-4), [
    "--model",
    "gpt-5.6-sol",
    "-i",
    prompt,
  ]);
});

test("auto-approves all tools only when the runner opts in", () => {
  const task = makeTask();
  task.copilot.approvalMode = "allow-all";

  const args = buildTaskCopilotArgs(task, "Do the task.");

  assert.ok(args.includes("--allow-all-tools"));
});

test("resumes an interrupted task's Copilot session", () => {
  const task = makeTask();
  task.copilot.resume = true;
  const args = buildTaskCopilotArgs(task, "Continue the task.");

  assert.ok(
    args.includes("--resume=00000000-0000-4000-8000-000000000001"),
  );
  assert.ok(!args.includes("--session-id"));
  assert.ok(!args.includes("--name"));
});

test("preserves supported optional task limits without enabling autopilot", () => {
  const task = makeTask();
  task.copilot.maxAiCredits = 50;
  task.copilot.maxAutopilotContinues = 20;
  const args = buildTaskCopilotArgs(task, "Do the task.");

  assert.equal(args[args.indexOf("--max-ai-credits") + 1], "50");
  assert.ok(!args.includes("--max-autopilot-continues"));
});

test("runs an agent-managed task in its playbook working directory", () => {
  const task = {
    target: { repository: "MeetingStage", workingDirectory: "C:\\Skype" },
    paths: { statePath: "C:\\state" },
    copilot: {
      model: "gpt-5.6-sol",
      sessionId: "00000000-0000-4000-8000-000000000001",
    },
  };
  const env = {};

  assert.equal(
    buildTaskCopilotSpawnOptions(task, env).cwd,
    "C:\\Skype",
    "the worker process must start in the playbook working directory",
  );
  const args = buildTaskCopilotArgs(task, "Do the task.");
  assert.equal(
    args[args.indexOf("-C") + 1],
    "C:\\Skype",
    "an agent-managed target has no worktreePath, so -C must not be undefined",
  );
});

test("refuses a task target that names no directory to run in", () => {
  const task = {
    target: { repository: "MeetingStage" },
    paths: { statePath: "C:\\state" },
    copilot: { model: "gpt-5.6-sol" },
  };

  assert.throws(
    () => buildTaskCopilotArgs(task, "Do the task."),
    /task target must have a workingDirectory or a worktreePath/,
  );
});

function makeTask() {
  return {
    target: { worktreePath: "C:\\worktree" },
    paths: { statePath: "C:\\state" },
    issue: {
      number: 34,
      title: "Fix the bird.txt typo",
      repository: "amoebachant/pan-life",
    },
    copilot: {
      model: "gpt-5.6-sol",
      sessionId: "00000000-0000-4000-8000-000000000001",
    },
  };
}
