import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  loadRunnerProfile,
  validateRunnerProfile,
} from "../src/index.js";

test("loads a capability profile and applies runner defaults", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pan-profile-"));
  const runnersDirectory = path.join(directory, "runners");
  const profilePath = path.join(runnersDirectory, "runner.json");
  const source = makeProfile(directory);
  delete source.store.path;
  await mkdir(runnersDirectory);
  await writeFile(profilePath, JSON.stringify(source));

  try {
    const profile = await loadRunnerProfile(profilePath);

    assert.equal(profile.pollIntervalSeconds, 30);
    assert.equal(profile.leaseSeconds, 600);
    assert.equal(profile.heartbeatSeconds, 120);
    assert.deepEqual(profile.taskBudget, {
      wallClockMinutes: undefined,
      maxAiCredits: undefined,
      maxAutopilotContinues: undefined,
    });
    assert.equal(profile.terminal.executable, "wt");
    assert.equal(profile.terminal.profile, "PowerShell");
    assert.equal(profile.copilot.approvalMode, "prompt");
    assert.equal(profile.profilePath, profilePath);
    assert.equal(profile.store.path, directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("requires a repository capability for every local repository", () => {
  const root = path.resolve("runner-root");
  const profile = makeProfile(root);
  profile.capabilities = ["env:local"];

  assert.throws(
    () => validateRunnerProfile(profile),
    /capabilities must include repo:example\/tool/,
  );
});

test("rejects a heartbeat cadence that can outlive the lease", () => {
  const profile = makeProfile(path.resolve("runner-root"));
  profile.leaseSeconds = 30;
  profile.heartbeatSeconds = 30;

  assert.throws(
    () => validateRunnerProfile(profile),
    /heartbeatSeconds must be less than leaseSeconds/,
  );
});

test("rejects Copilot credit budgets below the CLI minimum", () => {
  const profile = makeProfile(path.resolve("runner-root"));
  profile.taskBudget = { maxAiCredits: 29 };

  assert.throws(
    () => validateRunnerProfile(profile),
    /maxAiCredits must be at least 30/,
  );
});

test("preserves a configured Windows Terminal profile", () => {
  const source = makeProfile(path.resolve("runner-root"));
  source.terminal.profile = "PAN Work";

  assert.equal(validateRunnerProfile(source).terminal.profile, "PAN Work");
});

test("requires explicit opt-in for all-tools Copilot approval", () => {
  const source = makeProfile(path.resolve("runner-root"));
  source.copilot = { approvalMode: "allow-all" };

  assert.equal(
    validateRunnerProfile(source).copilot.approvalMode,
    "allow-all",
  );

  source.copilot.approvalMode = "automatic";
  assert.throws(
    () => validateRunnerProfile(source),
    /approvalMode must be "prompt" or "allow-all"/,
  );
});

test("allows an offline starter profile without service repositories", () => {
  const source = makeProfile(path.resolve("runner-root"));
  source.online = false;
  source.capabilities = ["env:local"];
  source.repositories = {};

  assert.deepEqual(validateRunnerProfile(source).playbooks[0].repositories, []);

  source.online = true;
  assert.throws(
    () => validateRunnerProfile(source),
    /at least one repository when the runner is online/,
  );
});

test("accepts a private domain configuration path for human attention", () => {
  const source = makeProfile(path.resolve("runner-root"));
  source.domainConfigPath = path.resolve("private-domain.json");

  assert.equal(
    validateRunnerProfile(source).domainConfigPath,
    source.domainConfigPath,
  );
});

test("adapts a legacy profile to one compatibility playbook", () => {
  const profile = validateRunnerProfile(makeProfile(path.resolve("runner-root")));

  assert.deepEqual(profile.playbooks, [
    {
      id: "legacy",
      capacity: 1,
      capabilities: ["env:local", "repo:example/tool"],
      repositories: ["example/tool"],
      instructions: [],
      delivery: "pull-request",
      legacy: true,
    },
  ]);
});

function makeProfile(root) {
  return {
    version: 1,
    id: "runner-a",
    machine: "machine-a",
    online: true,
    maxConcurrentDaemons: 1,
    capabilities: ["env:local", "repo:example/tool"],
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
