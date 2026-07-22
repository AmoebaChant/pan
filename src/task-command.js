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
    "--allow-all-tools",
    "--disable-builtin-mcps",
    "--no-remote",
    "--no-auto-update",
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
