import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  dispatchBlocker,
  matchingPlaybook,
  playbookBlocker,
  unsatisfiableRequirements,
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
});

test("treats workingDirectory as the agent-managed workspace switch", () => {
  const withWorkingDirectory = (workingDirectory) => {
    const profile = makeProfile();
    if (workingDirectory !== undefined) {
      profile.playbooks[0].workingDirectory = workingDirectory;
    }
    return profile;
  };

  assert.equal(
    validateRunnerProfile(withWorkingDirectory(undefined)).playbooks[0]
      .workingDirectory,
    undefined,
  );
  assert.equal(
    validateRunnerProfile(withWorkingDirectory("C:\\Metarepo")).playbooks[0]
      .workingDirectory,
    "C:\\Metarepo",
  );
  assert.equal(
    validateRunnerProfile(withWorkingDirectory("/srv/metarepo")).playbooks[0]
      .workingDirectory,
    "/srv/metarepo",
  );

  assert.throws(
    () => validateRunnerProfile(withWorkingDirectory("relative")),
    /workingDirectory must be an absolute path/,
  );
});

test("rejects a retired delivery field with an actionable message", () => {
  const profile = makeProfile();
  profile.playbooks[0].delivery = "direct";

  assert.throws(
    () => validateRunnerProfile(profile),
    /delivery is retired: describe how to deliver in .*\.instructions instead/,
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

test("requires a playbook that serves the task repository", () => {
  const profile = makeProfile();
  const item = {
    requirements: ["repo:example/tool"],
  };

  assert.equal(
    matchingPlaybook(item, validateRunnerProfile(profile)).id,
    "pan-development",
  );

  assert.equal(
    matchingPlaybook(
      { requirements: ["repo:other/repo"] },
      validateRunnerProfile(profile),
    ),
    undefined,
  );
});

test("dispatches an agent item that has no workstream", () => {
  const profile = validateRunnerProfile(makeProfile());
  const item = {
    fields: { owner: "agent", workstream: "" },
    requirements: ["repo:example/tool", "env:local", "tool:node22"],
  };

  assert.equal(dispatchBlocker(item), undefined);
  assert.equal(matchingPlaybook(item, profile).id, "pan-development");
});

test("refuses to dispatch a closed Issue before any other check", () => {
  const runnable = {
    state: "closed",
    fields: { owner: "someone-else", workstream: "pan" },
    requirements: [],
  };

  assert.equal(
    dispatchBlocker(runnable).code,
    "issue-closed",
    "the closed check must precede the owner and requirement checks",
  );
  assert.equal(
    dispatchBlocker({
      ...runnable,
      state: "open",
      fields: { owner: "agent", workstream: "pan" },
      requirements: ["repo:example/tool", "env:local", "tool:node22"],
    }),
    undefined,
    "an open Issue with valid fields must dispatch",
  );
});

test("names the field that makes a ready item undispatchable", () => {
  const runnable = {
    fields: { owner: "agent", workstream: "pan" },
    requirements: ["repo:example/tool", "env:local", "tool:node22"],
  };
  const withFields = (fields) => ({ ...runnable, fields });
  const withRequirements = (requirements) => ({ ...runnable, requirements });

  assert.equal(dispatchBlocker(runnable), undefined);
  assert.equal(
    dispatchBlocker(withFields({ owner: "human", workstream: "pan" })).code,
    "owner-not-agent",
  );
  assert.equal(
    dispatchBlocker(withFields({ owner: "agent", workstream: "" })),
    undefined,
    "an empty workstream must not block dispatch",
  );
  assert.equal(
    dispatchBlocker(withRequirements([])).code,
    "repository-requirement-missing",
  );
  assert.equal(
    dispatchBlocker(withRequirements(["repo:a/b", "repo:c/d"])).code,
    "repository-requirement-ambiguous",
  );
  assert.equal(
    dispatchBlocker({ ...runnable, state: "closed" }).code,
    "issue-closed",
  );
  assert.equal(
    dispatchBlocker(runnable),
    undefined,
    "the same runnable item without a closed state must remain dispatchable",
  );
});

test("names the playbook constraint that rejects a dispatchable item", () => {
  const profile = makeProfile();
  const validated = validateRunnerProfile(profile);
  const item = (requirements) => ({
    fields: { owner: "agent", workstream: "pan" },
    requirements,
  });
  const base = ["repo:example/tool", "env:local", "tool:node22"];

  assert.equal(
    playbookBlocker(item(["repo:other/repo"]), validated).code,
    "repository-unconfigured",
  );
  assert.equal(
    playbookBlocker(item(base), { ...validated, playbooks: [] }).code,
    "no-playbook-for-repository",
  );

  const full = playbookBlocker(
    item(base),
    validated,
    new Map([
      ["pan-development", 5],
      ["documentation", 1],
    ]),
  );
  assert.equal(full.code, "no-compatible-playbook");
  assert.match(full.message, /pan-development \(at capacity 5\/5\)/);

  assert.match(
    playbookBlocker(item([...base, "tool:docs"]), validated).message,
    /pan-development \(missing tool:docs\)/,
  );

  profile.playbooks[0].capacity = 0;
  profile.playbooks[1].capacity = 0;
  assert.match(
    playbookBlocker(item(base), validateRunnerProfile(profile)).message,
    /pan-development \(disabled\); documentation \(disabled\)/,
  );
});

test("separates a permanently unsatisfiable requirement from a busy playbook", () => {
  const validated = validateRunnerProfile(makeProfile());
  const item = (requirements) => ({
    fields: { owner: "agent", workstream: "pan" },
    requirements,
  });
  const base = ["repo:example/tool", "env:local", "tool:node22"];

  const stranded = item([...base, "delivery:pull-request"]);
  assert.deepEqual(unsatisfiableRequirements(stranded, validated), [
    "delivery:pull-request",
  ]);
  const blocker = playbookBlocker(stranded, validated);
  assert.equal(blocker.code, "requirements-unsatisfiable");
  assert.deepEqual(blocker.requirements, ["delivery:pull-request"]);
  assert.match(blocker.message, /can ever satisfy delivery:pull-request/);

  assert.deepEqual(
    unsatisfiableRequirements(item([...base, "tool:docs"]), validated),
    [],
  );
  assert.deepEqual(unsatisfiableRequirements(item(base), validated), []);
  assert.deepEqual(
    unsatisfiableRequirements(item(base), {
      ...validated,
      playbooks: [],
    }),
    [],
  );
});

function makeProfile() {  const root = path.resolve("runner-root");
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
