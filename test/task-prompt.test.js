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
  assert.match(prompt, /ask the user directly and continue after the reply/i);
  assert.doesNotMatch(prompt, /non-interactive session/i);
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

  assert.match(prompt, /push HEAD to main/);
  assert.match(prompt, /git push origin HEAD:refs\/heads\/main/);
  assert.match(prompt, /Never force-push/);
  assert.doesNotMatch(prompt, /open the pull request/);
});
