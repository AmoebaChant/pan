import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";

const node = process.execPath;

test("accepts hostless session lifecycle, scheduling, and leadership recovery", async () => {
  await runAcceptance([
    "test/pan-session-integration.test.js",
    "test/leader-lease.test.js",
    "test/copilot-invocation-contract.test.js",
  ]);
});

test("accepts complete evidence, safe reconciliation, and expected-state actions", async () => {
  await runAcceptance([
    "test/stateless-helper-integration.test.js",
    "test/issue-catalog.test.js",
    "test/portfolio-snapshot.test.js",
    "test/action-service.test.js",
    "test/issue-creation-service.test.js",
    "test/reconciliation-service.test.js",
  ]);
});

test("accepts direct workstream delivery without modifying the domain checkout", async () => {
  await runAcceptance(["test/workstream-delivery-integration.test.js"]);
});

test("accepts independent runner and attention operations without a PAN session", async () => {
  await runAcceptance([
    "test/attention-commands.test.js",
    "test/runner-daemon.test.js",
    "test/runner-profile.test.js",
    "test/local-task-executor.test.js",
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
