import assert from "node:assert/strict";
import test from "node:test";

import {
  isRateLimitError,
  nextPollDelaySeconds,
  rateLimitBackoffSeconds,
  waitForNextPoll,
} from "../src/polling.js";

test("backs off idle polling to a bounded interval", () => {
  assert.equal(nextPollDelaySeconds(30, 0), 30);
  assert.equal(nextPollDelaySeconds(30, 1), 60);
  assert.equal(nextPollDelaySeconds(30, 4), 300);
  assert.equal(nextPollDelaySeconds(30, 20), 300);
  assert.equal(nextPollDelaySeconds(600, 20), 600);
});

test("recognizes nested GitHub rate-limit failures", () => {
  const error = new Error("command failed", {
    cause: Object.assign(new Error("GraphQL failed"), {
      stderr: "API rate limit exceeded for user",
    }),
  });

  assert.equal(isRateLimitError(error), true);
  assert.equal(
    isRateLimitError(new Error("You have exceeded a secondary rate limit.")),
    true,
  );
  assert.equal(
    isRateLimitError(
      new AggregateError([new Error("API rate limit exceeded for user")]),
    ),
    true,
  );
  assert.equal(isRateLimitError(new Error("network unavailable")), false);
  assert.equal(rateLimitBackoffSeconds(), 900);
});

test("interrupts polling sleep when the daemon stops", async () => {
  const controller = new AbortController();
  const waiting = waitForNextPoll({
    sleep: () => new Promise(() => {}),
    milliseconds: 900_000,
    signal: controller.signal,
  });

  controller.abort();
  await waiting;
});
