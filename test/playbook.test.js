import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  matchingPlaybook,
  validateRunnerProfile,
} from "../src/index.js";

test("normalizes explicit playbooks with independent capacity", () => {
  const profile = validateRunnerProfile(makeProfile());

  assert.equal(profile.maxConcurrentDaemons, 6);
  assert.deepEqual(
    profile.playbooks.map(({ id, capacity }) => ({ id, capacity })),
    [
      { id: "pan-development", capacity: 5 },
      { id: "documentation", capacity: 1 },
    ],
  );
  assert.deepEqual(
    profile.playbooks.map(({ delivery }) => delivery),
    ["pull-request", "pull-request"],
  );
});

test("supports direct delivery and rejects unknown delivery policies", () => {
  const profile = makeProfile();
  profile.playbooks[0].delivery = "direct";

  assert.equal(
    validateRunnerProfile(profile).playbooks[0].delivery,
    "direct",
  );

  profile.playbooks[0].delivery = "email";
  assert.throws(
    () => validateRunnerProfile(profile),
    /delivery must be "pull-request" or "direct"/,
  );

  profile.playbooks[0].delivery = null;
  assert.throws(
    () => validateRunnerProfile(profile),
    /delivery must be "pull-request" or "direct"/,
  );
});

test("rejects playbooks that use unavailable machine capabilities", () => {
  const profile = makeProfile();
  profile.playbooks[0].capabilities.push("tool:missing");

  assert.throws(
    () => validateRunnerProfile(profile),
    /unavailable capability tool:missing/,
  );
});

test("matches task requirements to a playbook with free capacity", () => {
  const profile = validateRunnerProfile(makeProfile());
  const item = {
    requirements: ["repo:example/tool", "env:local", "tool:node22"],
  };

  assert.equal(matchingPlaybook(item, profile).id, "pan-development");
  assert.equal(
    matchingPlaybook(item, profile, new Map([["pan-development", 5]])),
    undefined,
  );
});

test("uses structured delivery requirements to select compatible playbooks", () => {
  const profile = makeProfile();
  profile.playbooks[0].delivery = "direct";
  const validated = validateRunnerProfile(profile);
  const item = {
    requirements: ["repo:example/tool", "delivery:pull-request"],
  };

  assert.equal(matchingPlaybook(item, validated).id, "documentation");
  item.requirements = ["repo:example/tool", "delivery:direct"];
  assert.equal(matchingPlaybook(item, validated).id, "pan-development");
});

function makeProfile() {
  const root = path.resolve("runner-root");
  return {
    version: 1,
    id: "runner-a",
    machine: "machine-a",
    online: true,
    maxConcurrentDaemons: 6,
    capabilities: [
      "env:local",
      "tool:node22",
      "tool:docs",
      "repo:example/tool",
    ],
    playbooks: [
      {
        id: "pan-development",
        capacity: 5,
        capabilities: [
          "env:local",
          "tool:node22",
          "repo:example/tool",
        ],
        repositories: ["example/tool"],
        instructions: ["Run relevant tests."],
      },
      {
        id: "documentation",
        capacity: 1,
        capabilities: [
          "env:local",
          "tool:docs",
          "repo:example/tool",
        ],
        repositories: ["example/tool"],
      },
    ],
    store: {
      repository: "example/data",
      projectOwner: "example",
      projectNumber: 1,
      path: path.join(root, "data"),
    },
    repositories: {
      "example/tool": {
        path: path.join(root, "tool"),
        defaultBranch: "main",
      },
    },
    workspaceRoot: path.join(root, "worktrees"),
    stateDirectory: path.join(root, "state"),
    terminal: {
      type: "windows-terminal",
    },
  };
}
