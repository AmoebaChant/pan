import assert from "node:assert/strict";
import {
  mkdir,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  buildRunnerAvailability,
  normalizeRunnerAvailability,
  RunnerProfileSource,
} from "../src/index.js";

let fixtureIndex = 0;

test("sanitizes legacy profiles and derives known free capacity", () => {
  const profile = legacyProfile("runner-b");
  const availability = normalizeRunnerAvailability(profile, {
    activeLeaseCount: 1,
  });
  const serialized = JSON.stringify(availability);

  assert.deepEqual(availability, {
    id: "runner-b",
    online: true,
    capabilities: ["env:local", "repo:example/tool"],
    maximumCapacity: 3,
    activeLeaseCount: 1,
    freeCapacity: 2,
    capacityKnown: true,
  });
  for (const secret of [
    "machine",
    "workspaceRoot",
    "stateDirectory",
    "terminal",
    "repositories",
    "githubAssignee",
    "copilot",
    "C:\\",
    "octocat",
  ]) {
    assert.ok(!serialized.includes(secret), `leaked ${secret}`);
  }
});

test("advertises zero free capacity when use is unknown or offline", () => {
  const unknown = normalizeRunnerAvailability(legacyProfile("runner-a"));
  const offline = normalizeRunnerAvailability(
    { ...legacyProfile("runner-b"), online: false },
    { activeLeaseCount: 0 },
  );

  assert.deepEqual(
    {
      activeLeaseCount: unknown.activeLeaseCount,
      freeCapacity: unknown.freeCapacity,
      capacityKnown: unknown.capacityKnown,
    },
    {
      activeLeaseCount: null,
      freeCapacity: 0,
      capacityKnown: false,
    },
  );
  assert.equal(offline.freeCapacity, 0);
  assert.equal(offline.capacityKnown, true);
});

test("sorts availability by ID and reports malformed or duplicate evidence", () => {
  const snapshot = buildRunnerAvailability(
    [
      legacyProfile("runner-b"),
      { ...legacyProfile("runner-a"), capabilities: [] },
      legacyProfile("runner-b"),
      legacyProfile("runner-c"),
      legacyProfile("runner-d"),
    ],
    {
      activeLeaseCounts: new Map([
        ["runner-b", 2],
        ["runner-c", 0],
        ["runner-d", -1],
      ]),
    },
  );

  assert.equal(snapshot.complete, false);
  assert.deepEqual(
    snapshot.runners.map((runner) => runner.id),
    ["runner-b", "runner-c", "runner-d"],
  );
  assert.equal(snapshot.runners[0].freeCapacity, 1);
  assert.equal(snapshot.runners[2].capacityKnown, false);
  assert.deepEqual(
    snapshot.diagnostics.map((diagnostic) => diagnostic.code).sort(),
    [
      "duplicate-runner",
      "invalid-active-count",
      "invalid-availability",
    ],
  );
});

test("loads sanitized availability while retaining malformed profile diagnostics", async (t) => {
  const directory = await createDirectory(t);
  await Promise.all([
    writeFile(path.join(directory, "runner-b.json"), "{}"),
    writeFile(path.join(directory, "runner-a.json"), "{}"),
    writeFile(path.join(directory, "broken.json"), "{"),
  ]);
  const profiles = new Map([
    ["runner-a.json", legacyProfile("runner-a")],
    ["runner-b.json", legacyProfile("runner-b")],
  ]);
  const source = new RunnerProfileSource({
    directory,
    profileLoader: async (file) => {
      const name = path.basename(file);
      if (name === "broken.json") {
        throw new Error(`Unable to read runner profile ${file}: malformed JSON`);
      }
      return profiles.get(name);
    },
  });

  const availability = await source.loadAvailability({
    activeLeaseCounts: { "runner-a": 0 },
  });
  await assert.rejects(source.load(), /malformed JSON/);

  assert.equal(availability.complete, false);
  assert.deepEqual(
    availability.runners.map((runner) => runner.id),
    ["runner-a", "runner-b"],
  );
  assert.equal(availability.runners[0].freeCapacity, 3);
  assert.equal(availability.runners[1].freeCapacity, 0);
  assert.deepEqual(availability.diagnostics, [
    {
      source: "broken.json",
      code: "invalid-runner-profile",
      message: "Unable to read runner profile <profile>: malformed JSON",
    },
  ]);
  assert.ok(!JSON.stringify(availability).includes(directory));
});

test("reports an unavailable profile directory as missing evidence", async (t) => {
  const directory = await createDirectory(t);
  await rm(directory, { recursive: true, force: true });

  const availability = await new RunnerProfileSource({
    directory,
  }).loadAvailability();

  assert.deepEqual(availability, {
    complete: false,
    runners: [],
    diagnostics: [
      {
        code: "missing-runner-directory",
        message: "Runner profile directory is unavailable",
      },
    ],
  });
});

function legacyProfile(id) {
  return {
    id,
    machine: `machine-${id}`,
    online: true,
    maxConcurrentDaemons: 3,
    capabilities: ["repo:example/tool", "env:local"],
    store: {
      repository: "example/domain",
      path: "C:\\private\\domain",
    },
    repositories: {
      "example/tool": { path: "C:\\private\\tool" },
    },
    workspaceRoot: "C:\\private\\worktrees",
    stateDirectory: "C:\\private\\state",
    terminal: { type: "windows-terminal", executable: "wt" },
    githubAssignee: "octocat",
    copilot: { executable: "copilot", model: "private-model" },
  };
}

async function createDirectory(t) {
  const directory = path.resolve(
    `.runner-availability-fixture-${process.pid}-${fixtureIndex++}`,
  );
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory);
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
