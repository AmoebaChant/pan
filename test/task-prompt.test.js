import assert from "node:assert/strict";
import test from "node:test";

import { buildTaskPrompt } from "../src/index.js";

test("requires complete implementation and runner-owned pull-request handoff", () => {
  const prompt = buildTaskPrompt("C:\\state\\context.json", {
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
  assert.match(prompt, /commit any remaining changes, push the branch, and open the pull request/);
  assert.match(prompt, /Follow the repository contribution guide/);
  assert.match(prompt, /ask the user directly and continue after the reply/i);
  assert.doesNotMatch(prompt, /non-interactive session/i);
});

test("describes runner-owned direct delivery without granting git access", () => {
  const prompt = buildTaskPrompt("C:\\state\\context.json", {
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

  assert.match(prompt, /push it directly to the default branch/);
  assert.match(prompt, /runner owns the direct commit and push/);
  assert.match(prompt, /Never push/);
  assert.doesNotMatch(prompt, /open the pull request/);
});
