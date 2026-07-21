import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import {
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { once } from "node:events";

import { terminateProcessTree } from "./process-tree.js";
import { buildTaskCopilotArgs } from "./task-command.js";
import { buildTaskPrompt } from "./task-prompt.js";

const contextPath = parseContextPath(process.argv.slice(2));
const context = JSON.parse(await readFile(contextPath, "utf8"));
const prompt = buildTaskPrompt(contextPath, context);
const args = buildTaskCopilotArgs(context, prompt);
const workerEnv = { ...process.env };
for (const name of [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "SSH_AUTH_SOCK",
  "GIT_ASKPASS",
]) {
  delete workerEnv[name];
}
workerEnv.GIT_TERMINAL_PROMPT = "0";
workerEnv.PAN_TASK_RESULT = context.paths.agentResult;
workerEnv.PAN_NEEDS_HUMAN = context.paths.needsHuman;
const log = createWriteStream(context.paths.log, { flags: "a" });
console.log(
  `[PAN worker] Starting task #${context.issue.number}; model=${context.copilot.model ?? "auto"}, wall-clock=${context.copilot.deadline ? "bounded" : "unlimited"}, AI credits=${context.copilot.maxAiCredits ?? "unlimited"}.`,
);
console.log(`[PAN worker] Activity log: ${context.paths.log}`);
await writeJsonAtomic(context.paths.worker, {
  pid: process.pid,
  startedAt: new Date().toISOString(),
});
const cancellation = await readAgentResult(context.paths.cancel);
if (cancellation) {
  throw new Error(cancellation.summary);
}

const child = spawn(context.copilot.executable, args, {
  cwd: context.target.worktreePath,
  env: workerEnv,
  stdio: ["inherit", "pipe", "pipe"],
  windowsHide: false,
});
let termination;
const stopChild = () => {
  termination ??= terminateReliably(child);
  return termination;
};
process.once("SIGTERM", () => {
  void stopChild().finally(() => process.exit(0));
});
child.stdout.on("data", (chunk) => {
  process.stdout.write(chunk);
  log.write(chunk);
});
child.stderr.on("data", (chunk) => {
  process.stderr.write(chunk);
  log.write(chunk);
});

let timedOut = false;
const timeout = context.copilot.deadline
  ? setTimeout(
      () => {
        timedOut = true;
        void stopChild();
      },
      Math.max(1, context.copilot.deadline - Date.now()),
    )
  : undefined;
let runtimeError;
const exit = await new Promise((resolve) => {
  child.once("error", (error) => {
    runtimeError = error;
    resolve({ code: undefined, signal: undefined });
  });
  child.once("close", (code, signal) => resolve({ code, signal }));
});
clearTimeout(timeout);
await termination;
log.end();
await once(log, "finish");

let result = runtimeError
  ? {
      status: "failed",
      summary: `Unable to start Copilot: ${runtimeError.message}`,
    }
  : await readAgentResult(context.paths.agentResult);
if (!result) {
  result = {
    status: "failed",
    summary: timedOut
      ? "Copilot exceeded the task wall-clock budget."
      : `Copilot exited without a task result (code ${exit.code}, signal ${exit.signal ?? "none"}).`,
    ...(timedOut ? { budgetExceeded: true } : {}),
  };
}
await writeJsonAtomic(context.paths.result, result);

if (result.status === "blocked") {
  console.log("");
  console.log("This PAN task needs human attention.");
  console.log(result.summary);
  console.log("Close this terminal after reviewing the context above.");
  await new Promise(() => {});
}

function parseContextPath(args) {
  const index = args.indexOf("--context");
  if (index === -1 || !args[index + 1]) {
    throw new TypeError("--context is required");
  }
  return path.resolve(args[index + 1]);
}

async function readAgentResult(filePath) {
  try {
    const value = JSON.parse(await readFile(filePath, "utf8"));
    if (
      !value ||
      !["completed", "blocked", "failed"].includes(value.status) ||
      typeof value.summary !== "string"
    ) {
      return undefined;
    }
    return value;
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) {
      return undefined;
    }
    throw error;
  }
}

async function writeJsonAtomic(filePath, value) {
  const temporary = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporary, filePath);
}

async function terminateReliably(child) {
  while (true) {
    try {
      await terminateProcessTree(child);
      return;
    } catch (error) {
      console.error(
        `[PAN worker] Unable to stop Copilot process ${child.pid}; retrying.`,
        error,
      );
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
  }
}
