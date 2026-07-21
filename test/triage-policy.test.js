import assert from "node:assert/strict";
import test from "node:test";

import { deriveTriage, formatAnswer, matchingRunner } from "../src/index.js";

test("infers agent routing and fields from Issue directives", () => {
  const result = deriveTriage(
    makeItem({
      body: [
        "Implement the feature.",
        "workstream: orchestration/pan",
        "repo:example/tool",
        "env:local",
        "priority: high",
      ].join("\n"),
    }),
  );

  assert.deepEqual(result.fields, {
    owner: "agent",
    priority: "high",
    requirements: ["repo:example/tool", "env:local"],
    autonomy: "full-auto",
    workstream: "orchestration/pan",
    status: "ready",
  });
  assert.deepEqual(result.missing, []);
});

test("uses answer directives to complete missing triage details", () => {
  const result = deriveTriage(makeItem({ status: "needs-detail" }), [
    { body: formatAnswer("workstream: orchestration/pan\nrepo:example/tool") },
  ]);

  assert.equal(result.fields.status, "ready");
  assert.equal(result.fields.workstream, "orchestration/pan");
  assert.equal(result.fields.owner, "agent");
});

test("uses a substantive answer as the missing task description", () => {
  const result = deriveTriage(
    makeItem({
      body: "workstream: orchestration/pan\nrepo:example/tool",
    }),
    [{ body: formatAnswer("Implement option A and preserve existing behavior.") }],
  );

  assert.equal(result.fields.status, "ready");
  assert.deepEqual(result.missing, []);
});

test("reports missing agent routing details", () => {
  const result = deriveTriage(
    makeItem({
      owner: "agent",
      body: "Implement it.",
      requirements: ["env:local"],
    }),
  );

  assert.equal(result.fields.status, "needs-detail");
  assert.match(result.prompt, /exactly one repo/);
});

test("matches all requirements against online runner capabilities", () => {
  const profiles = [
    {
      id: "offline",
      online: false,
      capabilities: ["repo:example/tool", "env:local"],
    },
    {
      id: "online",
      online: true,
      capabilities: ["repo:example/tool", "env:local"],
    },
  ];

  assert.equal(
    matchingRunner(["repo:example/tool", "env:local"], profiles).id,
    "online",
  );
  assert.equal(
    matchingRunner(["repo:example/tool", "tool:missing"], profiles),
    undefined,
  );
});

test("requires one playbook to satisfy the complete task", () => {
  const profiles = [
    {
      id: "split",
      online: true,
      capabilities: ["repo:example/tool", "tool:a", "tool:b"],
      playbooks: [
        {
          capabilities: ["repo:example/tool", "tool:a"],
        },
        {
          capabilities: ["repo:example/tool", "tool:b"],
        },
      ],
    },
  ];

  assert.equal(
    matchingRunner(
      ["repo:example/tool", "tool:a", "tool:b"],
      profiles,
    ),
    undefined,
  );
});

function makeItem({
  body = "Do the task.",
  owner = "unassigned",
  status = "untriaged",
  priority = "normal",
  requirements = [],
  autonomy = "manual",
  workstream = "",
} = {}) {
  return {
    body,
    requirements,
    fields: {
      owner,
      status,
      priority,
      requirements: requirements.join("\n"),
      autonomy,
      workstream,
    },
  };
}
