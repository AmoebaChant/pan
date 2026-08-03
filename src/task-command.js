import { formatTaskSessionName } from "./terminal-title.js";

/**
 * The directory a task actually runs in, whichever target shape it uses.
 */
export function taskWorkingDirectory(task) {
  const directory = task.target.workingDirectory ?? task.target.worktreePath;
  if (!directory) {
    throw new TypeError(
      "task target must have a workingDirectory or a worktreePath",
    );
  }
  return directory;
}

export function buildTaskCopilotSpawnOptions(task, env) {
  return {
    cwd: taskWorkingDirectory(task),
    env,
    stdio: "inherit",
    windowsHide: false,
  };
}

export function buildTaskCopilotArgs(task, taskPrompt) {
  const args = [
    "-C",
    taskWorkingDirectory(task),
    "--disable-builtin-mcps",
    "--no-remote",
    "--no-auto-update",
    "--add-dir",
    task.paths.statePath,
    "--deny-tool=shell(cmd:*)",
    "--deny-tool=shell(powershell:*)",
    "--deny-tool=shell(pwsh:*)",
  ];
  if (task.copilot.approvalMode === "allow-all") {
    args.splice(2, 0, "--allow-all-tools");
  }
  if (!task.copilot.resume) {
    args.push(
      "--name",
      formatTaskSessionName({
        issueNumber: task.issue?.number,
        repository: task.issue?.repository,
        title: task.issue?.title,
      }),
    );
  }
  if (task.copilot.maxAiCredits !== undefined) {
    args.push(
      "--max-ai-credits",
      String(task.copilot.maxAiCredits),
    );
  }
  if (task.copilot.resume && !task.copilot.resumeWithSessionId) {
    args.push(`--resume=${task.copilot.sessionId}`);
  } else if (task.copilot.sessionId) {
    args.push("--session-id", task.copilot.sessionId);
  }
  if (task.copilot.model) {
    args.push("--model", task.copilot.model);
  }
  args.push("-i", taskPrompt);
  return args;
}
