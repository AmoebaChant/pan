import assert from "node:assert/strict";
import test from "node:test";

import {
  buildTaskCopilotArgs,
  UNATTENDED_AUTOPILOT_CONTINUES,
} from "../src/index.js";

test("omits AI credit limits and uses a long-running autopilot ceiling", () => {
  const args = buildTaskCopilotArgs(makeTask(), "Do the task.");

  assert.ok(!args.includes("--max-ai-credits"));
  assert.equal(
    args[args.indexOf("--max-autopilot-continues") + 1],
    String(UNATTENDED_AUTOPILOT_CONTINUES),
  );
  assert.deepEqual(args.slice(-2), ["--model", "gpt-5.6-sol"]);
});

test("preserves explicit optional task limits", () => {
  const task = makeTask();
  task.copilot.maxAiCredits = 50;
  task.copilot.maxAutopilotContinues = 20;
  const args = buildTaskCopilotArgs(task, "Do the task.");

  assert.equal(args[args.indexOf("--max-ai-credits") + 1], "50");
  assert.equal(
    args[args.indexOf("--max-autopilot-continues") + 1],
    "20",
  );
});

function makeTask() {
  return {
    target: { worktreePath: "C:\\worktree" },
    paths: { statePath: "C:\\state" },
    copilot: { model: "gpt-5.6-sol" },
  };
}

