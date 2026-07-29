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

test("supports direct and report delivery and rejects unknown delivery policies", () => {
  const profile = makeProfile();
  profile.playbooks[0].delivery = "direct";
  profile.playbooks[1].delivery = "report";

  assert.deepEqual(
    validateRunnerProfile(profile).playbooks.map(({ delivery }) => delivery),
    ["direct", "report"],
  );

  profile.playbooks[0].delivery = "email";
  assert.throws(
    () => validateRunnerProfile(profile),
    /delivery must be "pull-request", "direct", "report", or "playbook"/,
  );

  profile.playbooks[0].delivery = null;
  assert.throws(
    () => validateRunnerProfile(profile),
    /delivery must be "pull-request", "direct", "report", or "playbook"/,
  );
});

test("playbook delivery requires an absolute working directory", () => {
  const withWorkingDirectory = (delivery, workingDirectory) => {
    const profile = makeProfile();
    profile.playbooks[0].delivery = delivery;
    if (workingDirectory !== undefined) {
      profile.playbooks[0].workingDirectory = workingDirectory;
    }
    return profile;
  };

  assert.equal(
    validateRunnerProfile(withWorkingDirectory("playbook", "C:\\Metarepo"))
      .playbooks[0].workingDirectory,
    "C:\\Metarepo",
  );
  assert.equal(
    validateRunnerProfile(withWorkingDirectory("playbook", "/srv/metarepo"))
      .playbooks[0].workingDirectory,
    "/srv/metarepo",
  );

  assert.throws(
    () => validateRunnerProfile(withWorkingDirectory("playbook", undefined)),
    /workingDirectory must be a non-empty string/,
  );
  assert.throws(
    () => validateRunnerProfile(withWorkingDirectory("playbook", "relative")),
    /workingDirectory must be an absolute path/,
  );
  assert.throws(
    () => validateRunnerProfile(withWorkingDirectory("direct", "C:\\Metarepo")),
    /workingDirectory is only valid for playbook delivery/,
  );
});

test("routes delivery:playbook requirements to a playbook-delivery playbook", () => {
  const profile = makeProfile();
  profile.playbooks[0].delivery = "playbook";
  profile.playbooks[0].workingDirectory = "C:\\Metarepo";
  const validated = validateRunnerProfile(profile);
  const repository = validated.playbooks[0].repositories[0];

  assert.equal(
    matchingPlaybook(
      { requirements: [`repo:${repository}`, "delivery:playbook"] },
      validated,
    )?.id,
    validated.playbooks[0].id,
  );
  assert.equal(
    matchingPlaybook(
      { requirements: [`repo:${repository}`, "delivery:pull-request"] },
      validated,
    )?.id,
    "documentation",
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

test("treats capacity 0 as a disabled playbook and rejects negative capacity", () => {
  const profile = makeProfile();
  profile.playbooks[0].capacity = 0;
  const validated = validateRunnerProfile(profile);
  const item = {
    requirements: ["repo:example/tool", "env:local", "tool:node22"],
  };

  assert.equal(validated.playbooks[0].capacity, 0);
  assert.equal(matchingPlaybook(item, validated), undefined);
  assert.equal(
    matchingPlaybook({ requirements: ["repo:example/tool"] }, validated).id,
    "documentation",
  );

  profile.playbooks[0].capacity = -1;
  assert.throws(
    () => validateRunnerProfile(profile),
    /playbooks\[0\]\.capacity must be an integer >= 0/,
  );

  profile.playbooks[0].capacity = 1.5;
  assert.throws(
    () => validateRunnerProfile(profile),
    /playbooks\[0\]\.capacity must be an integer >= 0/,
  );
});

test("requires explicit playbook configuration for direct delivery", () => {
  const profile = makeProfile();
  const item = {
    requirements: ["repo:example/tool", "delivery:direct"],
  };

  assert.equal(
    matchingPlaybook(item, validateRunnerProfile(profile)),
    undefined,
  );

  profile.playbooks[0].delivery = "direct";
  assert.equal(
    matchingPlaybook(item, validateRunnerProfile(profile)).id,
    "pan-development",
  );
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
