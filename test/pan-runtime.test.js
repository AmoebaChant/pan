import assert from "node:assert/strict";
import test from "node:test";

import { PanRuntime } from "../src/index.js";

test("runs one applied review while holding the domain lease", async () => {
  const calls = [];
  const runtime = new PanRuntime({
    reviewService: {
      run: async (options) => {
        calls.push(["review", options]);
        return { applied: true, response: { recommendation: "Do it." } };
      },
    },
    leaderLease: {
      acquire: async () => {
        calls.push(["acquire"]);
        return { acquired: true };
      },
      release: async () => {
        calls.push(["release"]);
        return { released: true };
      },
      heartbeat: async () => ({ renewed: true }),
    },
  });

  const result = await runtime.runOnce();

  assert.equal(result.leader, true);
  assert.deepEqual(calls.map(([name]) => name), [
    "acquire",
    "review",
    "release",
  ]);
  assert.equal(calls[1][1].apply, true);
  assert.equal(calls[1][1].signal.aborted, false);
});

test("aborts a reasoning turn and releases leadership when renewal fails", async () => {
  const calls = [];
  const runtime = new PanRuntime({
    heartbeatSeconds: 0.01,
    reviewService: {
      run: async ({ signal }) =>
        new Promise((resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(signal.reason),
            { once: true },
          );
          setTimeout(resolve, 1_000);
        }),
    },
    leaderLease: {
      acquire: async () => ({ acquired: true }),
      heartbeat: async () => ({ renewed: false, reason: "lost" }),
      release: async () => {
        calls.push("release");
        return { released: true };
      },
    },
  });

  await assert.rejects(runtime.runOnce(), /leader lease lost/i);
  assert.deepEqual(calls, ["release"]);
});
