import assert from "node:assert/strict";
import test from "node:test";

import {
  readProcessIdentity,
  terminateProcessByPid,
  terminateProcessTree,
} from "../src/process-tree.js";

test("reads a Windows process command line and creation time", async () => {
  const identity = await readProcessIdentity(4321, {
    platform: "win32",
    execFileImpl: (_file, _args, _options, callback) =>
      callback(
        undefined,
        JSON.stringify({
          CommandLine: "node task-worker.js --context C:\\state\\context.json",
          CreationDate: "2026-07-31T12:00:00.000Z",
        }),
      ),
  });

  assert.deepEqual(identity, {
    commandLine: "node task-worker.js --context C:\\state\\context.json",
    startedAt: "2026-07-31T12:00:00.000Z",
  });
});

test("terminates only the supplied child process tree", async () => {
  const calls = [];
  const states = [true, false];

  await terminateProcessTree(
    { pid: 4321 },
    {
      platform: "win32",
      isAlive: () => states.shift() ?? false,
      execFileImpl: (file, args, options, callback) => {
        calls.push({ file, args, options });
        callback();
      },
      sleep: async () => {},
    },
  );

  assert.deepEqual(calls, [
    {
      file: "taskkill.exe",
      args: ["/PID", "4321", "/T", "/F"],
      options: { windowsHide: true },
    },
  ]);
});

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
