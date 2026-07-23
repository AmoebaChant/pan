import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  buildOnboardingCopilotArgs,
  startPanOnboarding,
} from "../src/index.js";

test("installs assets and starts the dedicated conversational setup agent", async () => {
  const child = new EventEmitter();
  const calls = [];
  const promise = startPanOnboarding({
    cwd: "C:\\work",
    env: { PAN_COPILOT_EXECUTABLE: "copilot-test" },
    assetService: {
      install: async () => ({ status: "current" }),
    },
    commands: {
      async run(executable, args) {
        calls.push({ executable, args });
        return "--agent --add-dir --model --no-auto-update --interactive";
      },
    },
    spawnProcess(executable, args, options) {
      calls.push({ executable, args, options });
      queueMicrotask(() => child.emit("exit", 0, null));
      return child;
    },
  });

  const result = await promise;

  assert.equal(result.status, "completed");
  assert.deepEqual(calls[0], {
    executable: "copilot-test",
    args: ["--help"],
  });
  assert.equal(calls[1].executable, "copilot-test");
  assert.deepEqual(calls[1].args, buildOnboardingCopilotArgs());
  assert.equal(calls[1].options.cwd, "C:\\work");
  assert.match(calls[1].args.at(-1), /Welcome me in Pan's voice/i);
  assert.match(calls[1].args.at(-1), /navigate my workloads and manage agents/i);
});
