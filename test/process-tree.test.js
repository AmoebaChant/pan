import assert from "node:assert/strict";
import test from "node:test";

import { terminateProcessByPid } from "../src/process-tree.js";

test("reports a Windows process tree that remains alive after taskkill", async () => {
  await assert.rejects(
    terminateProcessByPid(1234, {
      platform: "win32",
      isAlive: () => true,
      execFileImpl: (_file, _args, _options, callback) =>
        callback(new Error("taskkill failed")),
      sleep: async () => {},
    }),
    /Process 1234 did not stop/,
  );
});

test("accepts taskkill errors when the process is already gone", async () => {
  const states = [true, false];

  await terminateProcessByPid(1234, {
    platform: "win32",
    isAlive: () => states.shift() ?? false,
    execFileImpl: (_file, _args, _options, callback) =>
      callback(new Error("process not found")),
    sleep: async () => {},
  });
});
