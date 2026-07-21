export const UNATTENDED_AUTOPILOT_CONTINUES = 1_000;

export function buildTaskCopilotSpawnOptions(task, env) {
  return {
    cwd: task.target.worktreePath,
    env,
    stdio: "inherit",
    windowsHide: false,
  };
}

export function buildTaskCopilotArgs(task, taskPrompt) {
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
    "--max-autopilot-continues",
    String(
      task.copilot.maxAutopilotContinues ??
        UNATTENDED_AUTOPILOT_CONTINUES,
    ),
    "--add-dir",
    task.paths.statePath,
    "--deny-tool=shell(git:*)",
    "--deny-tool=shell(gh:*)",
    "--deny-tool=shell(cmd:*)",
    "--deny-tool=shell(powershell:*)",
    "--deny-tool=shell(pwsh:*)",
  ];
  if (task.copilot.maxAiCredits !== undefined) {
    args.push(
      "--max-ai-credits",
      String(task.copilot.maxAiCredits),
    );
  }
  if (task.copilot.model) {
    args.push("--model", task.copilot.model);
  }
  return args;
}
