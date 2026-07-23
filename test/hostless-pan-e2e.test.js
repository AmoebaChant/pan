import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";

const node = process.execPath;

test("accepts foreground session lifecycle and scheduling", async () => {
  await runAcceptance([
    "test/pan-session.test.js",
    "test/copilot-invocation-contract.test.js",
  ]);
});

test("accepts the independent schema-driven runner", async () => {
  await runAcceptance([
    "test/runner-daemon.test.js",
    "test/runner-profile.test.js",
    "test/local-task-executor.test.js",
    "test/pan-store.test.js",
  ]);
});

test("accepts one hostless package and CLI surface", async () => {
  await runAcceptance([
    "test/hostless-runtime-retirement.test.js",
    "test/package-surface.test.js",
    "test/pan-cli.test.js",
    "test/pan-cli-integration.test.js",
  ]);
});

async function runAcceptance(files) {
  const result = await new Promise((resolve, reject) => {
    const child = spawn(node, ["--test", ...files], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });

  assert.equal(
    result.code,
    0,
    `Hostless acceptance failed (${files.join(", ")}; signal ${result.signal ?? "none"}):\n${result.stdout}${result.stderr}`,
  );
}
