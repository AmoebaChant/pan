import assert from "node:assert/strict";
import test from "node:test";

import { buildTaskPrompt } from "../src/index.js";

const paths = {
  agentResult: "C:\\state\\agent-result.json",
  needsHuman: "C:\\state\\needs-human.json",
};

test("hands the task to the playbook and Issue and asks for one outcome", () => {
  const prompt = buildTaskPrompt("C:\\state\\context.json", {
    issue: {
      number: 31,
      repository: "example/tasks",
    },
    target: {
      defaultBranch: "main",
    },
    playbook: {
      id: "pan-development",
      instructions: ["Open a pull request that closes the Issue."],
    },
    paths,
  });

  assert.match(prompt, /complete canonical task context/);
  assert.match(prompt, /acceptance criteria/);
  assert.match(prompt, /Inspect repository guidance/);
  assert.match(prompt, /Run the smallest relevant existing tests/);
  assert.match(prompt, /Open a pull request that closes the Issue/);
  assert.match(prompt, /Deliver the way the playbook and Issue describe/);
  assert.match(prompt, /does not verify how you did it/);
  assert.match(prompt, /"outcome":"done\|needs-review"/);
  assert.match(prompt, /You decide when the task is finished/);
  assert.match(prompt, /provided task branch/);
  assert.match(prompt, /ask the same question in this terminal and wait/i);
  assert.match(prompt, /holds its slot and spends no budget/i);
  assert.match(prompt, /delete .*needs-human\.json and continue working/i);
  assert.doesNotMatch(prompt, /re-state your outstanding question/i);
  assert.doesNotMatch(prompt, /undefined/);
});

test("omits workstream README from context when the task has no workstream", () => {
  const prompt = buildTaskPrompt("C:\\state\\context.json", {
    issue: {
      number: 31,
      repository: "example/tasks",
    },
    target: {
      defaultBranch: "main",
    },
    playbook: {
      id: "pan-development",
      instructions: [],
    },
    paths,
  });

  assert.match(
    prompt,
    /It contains the Issue body, acceptance criteria, comments and answers, target worktree and branch, and playbook guidance\./,
  );
  assert.doesNotMatch(prompt, /workstream README/i);
});

test("names the workstream README in context when the task has a workstream", () => {
  const prompt = buildTaskPrompt("C:\\state\\context.json", {
    issue: {
      number: 31,
      repository: "example/tasks",
    },
    target: {
      defaultBranch: "main",
    },
    playbook: {
      id: "pan-development",
      instructions: [],
    },
    workstream: {
      path: "example",
      content: "# Example\n",
    },
    paths,
  });

  assert.match(
    prompt,
    /It contains the Issue body, acceptance criteria, comments and answers, target worktree and branch, workstream README, and playbook guidance\./,
  );
});

test("tells a restarted worker to re-state its outstanding question", () => {
  const prompt = buildTaskPrompt("C:\\state\\context.json", {
    issue: {
      number: 31,
      repository: "example/tasks",
    },
    target: {
      defaultBranch: "main",
    },
    playbook: {
      id: "pan-development",
      instructions: [],
    },
    needsHumanSince: "2026-07-20T16:00:00Z",
    paths: {
      agentResult: "C:\\state\\agent-result.json",
      needsHuman: "C:\\state\\needs-human-2.json",
    },
  });

  assert.match(prompt, /already waiting for a human answer as of 2026-07-20T16:00:00Z/);
  assert.match(prompt, /re-state your outstanding question/i);
  assert.match(prompt, /needs-human-2\.json again/);
});

test("scopes an agent-managed task to its working directory", () => {
  const prompt = buildTaskPrompt("C:\\state\\context.json", {
    issue: {
      number: 31,
      repository: "example/tasks",
    },
    target: {
      repository: "MeetingStage",
      workingDirectory: "C:\\Metarepo",
    },
    playbook: {
      id: "metarepo-development",
      instructions: ["Create an isolated workspace with the metarepo tooling."],
    },
    paths,
  });

  assert.match(prompt, /Create an isolated workspace with the metarepo tooling/);
  assert.match(prompt, /Work only inside C:\\Metarepo/);
  assert.match(prompt, /target working directory/);
  assert.match(prompt, /"outcome":"done\|needs-review"/);
  assert.match(prompt, /ask the same question in this terminal and wait/i);

  assert.doesNotMatch(prompt, /provided task branch/);
  assert.doesNotMatch(prompt, /provided worktree/);
  assert.doesNotMatch(prompt, /undefined/);
});
