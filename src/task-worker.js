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

const contextPath = parseContextPath(process.argv.slice(2));
const context = JSON.parse(await readFile(contextPath, "utf8"));
const prompt = buildPrompt(contextPath, context);
const args = buildCopilotArgs(context, prompt);
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

const child = spawn(context.copilot.executable, args, {
  cwd: context.target.worktreePath,
  env: workerEnv,
  stdio: ["inherit", "pipe", "pipe"],
  windowsHide: false,
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
let termination;
const remaining = Math.max(1, context.copilot.deadline - Date.now());
const timeout = setTimeout(
  () => {
    timedOut = true;
    termination = terminateProcessTree(child);
  },
  remaining,
);
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

function buildCopilotArgs(task, taskPrompt) {
  const args = [
    "-C",
    task.target.worktreePath,
    "-p",
    taskPrompt,
    "--autopilot",
    "--allow-all-tools",
    "--no-ask-user",
    "--disable-builtin-mcps",
    "--no-remote",
    "--no-auto-update",
    "--max-ai-credits",
    String(task.copilot.maxAiCredits),
    "--max-autopilot-continues",
    String(task.copilot.maxAutopilotContinues),
    "--add-dir",
    task.paths.statePath,
    "--deny-tool=shell(git:*)",
    "--deny-tool=shell(gh:*)",
    "--deny-tool=shell(cmd:*)",
    "--deny-tool=shell(powershell:*)",
    "--deny-tool=shell(pwsh:*)",
  ];
  if (task.copilot.model) {
    args.push("--model", task.copilot.model);
  }
  return args;
}

function buildPrompt(taskContextPath, task) {
  return [
    "You are a PAN worker daemon executing one GitHub Issue.",
    "",
    `Read the complete task context from ${taskContextPath}.`,
    "It contains the Issue, its comments and answers, target worktree, branch, and workstream README.",
    "",
    "Guardrails:",
    "- Work only in the provided worktree and remain on the provided task branch.",
    "- Never push, force-push, merge, delete branches/worktrees, or create/merge/close pull requests or Issues.",
    "- Do not modify the default branch. The runner owns commit, push, and PR creation.",
    "- Do not run git, gh, cmd, PowerShell, or other wrapper commands that bypass the denied tools.",
    "- Make only the requested change and run the smallest relevant existing tests.",
    "- Do not write credentials, tokens, local paths, runner state, or other private data into the target repository.",
    "",
    `When complete, atomically write ${task.paths.agentResult} as JSON with:`,
    '{"status":"completed","summary":"one paragraph"}',
    "",
    `If human input is required, atomically write ${task.paths.needsHuman} as JSON with:`,
    '{"kind":"question|approval|local-ui","prompt":"one-line request","localUrl":"optional URL"}',
    `Then atomically write ${task.paths.agentResult} as JSON with:`,
    '{"status":"blocked","summary":"why work cannot continue"}',
    "Do not ask the user directly in this non-interactive session.",
  ].join("\n");
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
