import assert from "node:assert/strict";
import test from "node:test";

import { buildTaskPrompt } from "../src/index.js";

test("requires complete implementation and agent-owned pull-request delivery", () => {
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
      instructions: ["Follow the repository contribution guide."],
      delivery: "pull-request",
    },
    paths: {
      agentResult: "C:\\state\\agent-result.json",
      needsHuman: "C:\\state\\needs-human.json",
    },
  });

  assert.match(prompt, /complete canonical task context/);
  assert.match(prompt, /acceptance criteria/);
  assert.match(prompt, /Inspect repository guidance/);
  assert.match(prompt, /Run the smallest relevant existing tests/);
  assert.match(prompt, /create or reuse an open pull request/);
  assert.match(prompt, /Closes example\/tasks#31/);
  assert.match(prompt, /delivery.*pull-request.*commit.*url/);
  assert.match(prompt, /Follow the repository contribution guide/);
  assert.match(prompt, /ask the same question in this terminal and wait/i);
  assert.match(prompt, /holds its slot and spends no budget/i);
  assert.match(prompt, /delete .*needs-human\.json and continue working/i);
  assert.doesNotMatch(prompt, /non-interactive session/i);
  assert.doesNotMatch(prompt, /re-state your outstanding question/i);
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
      delivery: "pull-request",
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

test("authorizes agent-owned direct delivery without allowing unrelated git actions", () => {
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
      delivery: "direct",
    },
    paths: {
      agentResult: "C:\\state\\agent-result.json",
      needsHuman: "C:\\state\\needs-human.json",
    },
  });

  assert.match(prompt, /push HEAD with origin to main/);
  assert.match(prompt, /git push origin HEAD:refs\/heads\/main/);
  assert.match(prompt, /Never force-push/);
  assert.doesNotMatch(prompt, /open the pull request/);
});

test("keeps report delivery read-only", () => {
  const prompt = buildTaskPrompt("C:\\state\\context.json", {
    issue: {
      number: 31,
      repository: "example/tasks",
    },
    target: {
      defaultBranch: "main",
    },
    playbook: {
      id: "pan-investigation",
      instructions: [],
      delivery: "report",
    },
    paths: {
      agentResult: "C:\\state\\agent-result.json",
      needsHuman: "C:\\state\\needs-human.json",
    },
  });

  assert.match(prompt, /Report delivery is read-only/);
  assert.doesNotMatch(prompt, /git push/);
  assert.doesNotMatch(prompt, /Closes example\/tasks#31/);
});

test("hands the whole workflow to the playbook for playbook delivery", () => {
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
      delivery: "playbook",
    },
    paths: {
      agentResult: "C:\\state\\agent-result.json",
      needsHuman: "C:\\state\\needs-human.json",
    },
  });

  assert.match(prompt, /Create an isolated workspace with the metarepo tooling/);
  assert.match(prompt, /playbook above defines this task end to end/);
  assert.match(prompt, /nothing else prepares a workspace for you/);
  assert.match(prompt, /Work only inside C:\\Metarepo/);
  assert.match(prompt, /target working directory/);
  assert.match(prompt, /"mode":"playbook"/);
  assert.match(prompt, /runner does not verify it for you/);
  assert.match(prompt, /ask the same question in this terminal and wait/i);

  assert.doesNotMatch(prompt, /git push/);
  assert.doesNotMatch(prompt, /rebase the task branch/);
  assert.doesNotMatch(prompt, /provided task branch/);
  assert.doesNotMatch(prompt, /Closes example\/tasks#31/);
  assert.doesNotMatch(prompt, /undefined/);
});
