export function buildTaskPrompt(taskContextPath, task) {
  const directDelivery = task.playbook.delivery === "direct";
  const reportDelivery = task.playbook.delivery === "report";
  const playbookDelivery = task.playbook.delivery === "playbook";
  const deliveryResult = playbookDelivery
    ? '{"status":"completed","summary":"one paragraph","delivery":{"mode":"playbook","details":"what you delivered and where to find it","url":"optional link to the delivered change"}}'
    : reportDelivery
    ? '{"status":"completed","summary":"one paragraph","delivery":{"mode":"report","report":"complete Markdown findings and recommendation"}}'
    : directDelivery
      ? '{"status":"completed","summary":"one paragraph","delivery":{"mode":"direct","commit":"40-character commit SHA","url":"https://github.com/OWNER/REPOSITORY/commit/SHA"}}'
      : '{"status":"completed","summary":"one paragraph","delivery":{"mode":"pull-request","commit":"40-character commit SHA","url":"https://github.com/OWNER/REPOSITORY/pull/NUMBER"}}';
  const baseRemote = task.target.baseRemote ?? "origin";
  const pushRemote = task.target.pushRemote ?? "origin";
  const playbookInstructions = task.playbook.instructions.length
    ? [
        "",
        `Playbook ${task.playbook.id}:`,
        ...task.playbook.instructions.map(
          (instruction) => `- ${instruction}`,
        ),
      ]
    : [];
  const outstandingQuestion = task.needsHumanSince
    ? [
        "",
        `This task was already waiting for a human answer as of ${task.needsHumanSince}, and this session restarted since then.`,
        `The request file path is new, so re-state your outstanding question: write ${task.paths.needsHuman} again, ask it in this terminal, and wait.`,
      ]
    : [];
  return [
    "You are a Pan worker daemon executing one GitHub Issue.",
    "",
    `Read the complete canonical task context from ${taskContextPath}.`,
    playbookDelivery
      ? "It contains the Issue body, acceptance criteria, comments and answers, target working directory, workstream README, and playbook guidance."
      : "It contains the Issue body, acceptance criteria, comments and answers, target worktree and branch, workstream README, and playbook guidance.",
    ...playbookInstructions,
    "",
    "Required workflow:",
    ...(playbookDelivery
      ? [
          "- The playbook above defines this task end to end, including how to isolate your workspace and how to deliver. Follow it exactly; nothing else prepares a workspace for you.",
          "- Inspect repository guidance before editing, including AGENTS.md and contributing documentation when present.",
          "- Implement every acceptance criterion and all directly required integration surfaces.",
          "- Run the smallest relevant existing tests, builds, or checks.",
        ]
      : [
          "- Inspect repository guidance before editing, including AGENTS.md and contributing documentation when present.",
          reportDelivery
            ? "- Investigate every acceptance criterion and produce a complete, decision-ready report. Do not modify repository files or create commits."
            : "- Implement every acceptance criterion and all directly required integration surfaces.",
          reportDelivery
            ? "- Run only read-only checks and reproductions that support the report."
            : "- Run the smallest relevant existing tests, builds, or checks.",
          ...(reportDelivery
            ? []
            : [
                directDelivery
                  ? `- Commit the complete change, fetch ${baseRemote}/${task.target.defaultBranch}, rebase the task branch onto it, resolve any conflicts, rerun affected checks, and push HEAD with ${pushRemote} to ${task.target.defaultBranch}. Retry non-fast-forward pushes by fetching and integrating the new tip.`
                  : `- Commit the complete change, fetch ${baseRemote}/${task.target.defaultBranch}, rebase the task branch onto it, resolve any conflicts, rerun affected checks, push the task branch to ${pushRemote}, and create or reuse an open pull request targeting ${task.target.repository}:${task.target.defaultBranch}. Do not merge the pull request.`,
              ]),
        ]),
    "",
    "Guardrails:",
    ...(playbookDelivery
      ? [
          `- Work only inside ${task.target.workingDirectory}, and keep your work isolated from any other agent running there.`,
          "- Never merge or close pull requests, close Issues, or discard work you did not create.",
        ]
      : [
          "- Work only in the provided worktree and remain on the provided task branch.",
          "- Use git and GitHub only for the target repository, task branch, source Issue, and playbook-selected delivery.",
          "- Never force-push, delete branches or worktrees, merge or close pull requests, close Issues, or check out the default branch.",
          reportDelivery
            ? "- Report delivery is read-only. Do not change tracked files, create commits, push branches, or create pull requests."
            : directDelivery
            ? `- Direct delivery is authorized only by this playbook. Push the validated task commit with git push ${pushRemote} HEAD:refs/heads/${task.target.defaultBranch}.`
            : `- Pull-request delivery must link the source task with "Closes ${task.issue.repository}#${task.issue.number}" in the pull-request body.`,
        ]),
    "- Do not run cmd, PowerShell, or other wrapper commands that bypass denied tools.",
    "- Do not write credentials, tokens, local paths, runner state, or other private data into the target repository.",
    "",
    playbookDelivery
      ? "Completion means you finished the delivery your playbook describes. The runner does not verify it for you, so do not report completion while any step your playbook requires remains."
      : reportDelivery
      ? "Completion means the requested investigation is complete and the report contains the evidence, tradeoffs, recommendation, and concrete next steps needed for human review."
      : "Completion means the change has been delivered remotely according to the playbook. Do not report completion while commits, conflict resolution, checks, push, or pull-request creation remain.",
    `After delivery succeeds, atomically write ${task.paths.agentResult} as JSON with:`,
    deliveryResult,
    "",
    `If you need an answer from the human, atomically write ${task.paths.needsHuman} as JSON with:`,
    '{"kind":"question|approval|local-ui","prompt":"one-line request","localUrl":"optional URL"}',
    "Then ask the same question in this terminal and wait for the reply. Keep running: the task holds its slot and spends no budget while the question is outstanding.",
    `When you receive the answer, delete ${task.paths.needsHuman} and continue working.`,
    ...outstandingQuestion,
    `Only report blocked by writing ${task.paths.agentResult} as JSON with '{"status":"blocked","summary":"why work cannot continue"}' when an external dependency outside the human's control prevents all further progress.`,
  ].join("\n");
}
