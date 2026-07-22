import assert from "node:assert/strict";
import test from "node:test";

import {
  waitForTaskResult,
  waitForTaskWorkerOutcome,
} from "../src/task-result-watcher.js";

test("returns a task result as soon as it becomes available", async () => {
  const expected = {
    status: "completed",
    summary: "Implemented the task.",
  };
  let reads = 0;
  let sleeps = 0;

  const result = await waitForTaskResult(
    async () => {
      reads += 1;
      return reads === 2 ? expected : undefined;
    },
    {
      sleep: async () => {
        sleeps += 1;
      },
    },
  );

  assert.equal(result, expected);
  assert.equal(reads, 2);
  assert.equal(sleeps, 1);
});

test("stops waiting when result monitoring is cancelled", async () => {
  const controller = new AbortController();
  let reads = 0;

  const result = await waitForTaskResult(
    async () => {
      reads += 1;
      controller.abort();
      return undefined;
    },
    {
      signal: controller.signal,
      sleep: async () => {
        assert.fail("cancelled result monitoring must not sleep again");
      },
    },
  );

  assert.equal(result, undefined);
  assert.equal(reads, 1);
});

test("stops the worker process when the agent reports completion", async () => {
  const expected = {
    status: "completed",
    summary: "Implemented the task.",
  };
  let resolveExit;
  let stops = 0;
  const childExit = new Promise((resolve) => {
    resolveExit = resolve;
  });

  const outcome = await waitForTaskWorkerOutcome({
    childExit,
    readResult: async () => expected,
    stopChild: async () => {
      stops += 1;
      resolveExit({ code: null, signal: "SIGTERM" });
    },
  });

  assert.equal(stops, 1);
  assert.deepEqual(outcome, {
    exit: { code: null, signal: "SIGTERM" },
    result: expected,
  });
});

test("does not stop a worker that exits before reporting a result", async () => {
  let stops = 0;

  const outcome = await waitForTaskWorkerOutcome({
    childExit: Promise.resolve({ code: 0, signal: null }),
    readResult: async () => undefined,
    stopChild: async () => {
      stops += 1;
    },
  });

  assert.equal(stops, 0);
  assert.deepEqual(outcome, {
    exit: { code: 0, signal: null },
  });
});
