import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  loadDomainConfig,
  validateDomainConfig,
} from "../src/index.js";

test("applies bounded runtime defaults without runner settings", () => {
  const config = validateDomainConfig(makeConfig());

  assert.equal(config.cadences.activePollSeconds, 30);
  assert.equal(config.cadences.idlePollSeconds, 300);
  assert.equal(config.cadences.fullReviewSeconds, 86_400);
  assert.equal(config.cadences.rateLimitRetrySeconds, 900);
  assert.equal(config.cadences.leaderLeaseSeconds, 120);
  assert.equal(config.cadences.leaderHeartbeatSeconds, 30);
  assert.equal(config.agent.executable, "copilot");
  assert.equal(config.agent.turnTimeoutSeconds, 600);
  assert.equal(config.state.leaderPath, ".pan/leader.json");
  assert.equal(config.transcripts.path, ".pan/transcripts");
  assert.equal(config.transcripts.retentionDays, 30);
  assert.deepEqual(config.reviewPolicy.higherRisk, {
    enabled: false,
    actionKinds: [],
  });
  assert.equal(config.machine, undefined);
  assert.equal(config.repositories, undefined);
});

test("confines state and transcript paths to the configured namespace", () => {
  const config = makeConfig();
  config.transcripts = { path: ".pan/history", retentionDays: 7 };
  assert.equal(
    validateDomainConfig(config).transcripts.path,
    ".pan/history",
  );

  for (const invalidPath of [
    "../outside",
    ".pan/../outside",
    "/absolute",
    ".pan\\outside",
  ]) {
    const invalid = makeConfig();
    invalid.transcripts = { path: invalidPath };
    assert.throws(
      () => validateDomainConfig(invalid),
      /transcripts\.path .*confined repository-relative path|transcripts\.path must remain inside/,
    );
  }

  const outsideNamespace = makeConfig();
  outsideNamespace.transcripts = { path: "other/transcripts" };
  assert.throws(
    () => validateDomainConfig(outsideNamespace),
    /transcripts\.path must remain inside the \.pan state namespace/,
  );
});

test("rejects invalid cadence relationships before runtime mutation", () => {
  const heartbeat = makeConfig();
  heartbeat.cadences = {
    leaderLeaseSeconds: 60,
    leaderHeartbeatSeconds: 60,
  };
  assert.throws(
    () => validateDomainConfig(heartbeat),
    /cadences\.leaderHeartbeatSeconds must be less than/,
  );

  const idle = makeConfig();
  idle.cadences = { activePollSeconds: 60, idlePollSeconds: 30 };
  assert.throws(
    () => validateDomainConfig(idle),
    /cadences\.idlePollSeconds must be greater than or equal/,
  );
});

test("rejects malformed identity and missing Project fields", () => {
  const repository = makeConfig();
  repository.domain.repository = "not-a-repository";
  assert.throws(
    () => validateDomainConfig(repository),
    /domain\.repository must use owner\/name/,
  );

  const missingProject = makeConfig();
  delete missingProject.domain.projectNumber;
  assert.throws(
    () => validateDomainConfig(missingProject),
    /domain\.projectNumber must be an integer/,
  );
});

test("rejects runner-only, credential, and unknown configuration fields", () => {
  for (const key of ["machine", "repositories", "terminal", "workspaceRoot"]) {
    const config = { ...makeConfig(), [key]: {} };
    assert.throws(
      () => validateDomainConfig(config),
      new RegExp(`${key} is runner-only`),
    );
  }

  const credential = makeConfig();
  credential.agent.token = "must-not-be-stored";
  assert.throws(
    () => validateDomainConfig(credential),
    /agent\.token is not a supported configuration field/,
  );
});

test("requires explicit opt-in and action kinds for higher-risk review", () => {
  const config = makeConfig();
  config.reviewPolicy = {
    higherRisk: {
      enabled: true,
      actionKinds: ["issue-create", "canonical-reorder"],
    },
  };
  assert.deepEqual(
    validateDomainConfig(config).reviewPolicy.higherRisk.actionKinds,
    ["issue-create", "canonical-reorder"],
  );

  config.reviewPolicy.higherRisk.actionKinds = [];
  assert.throws(
    () => validateDomainConfig(config),
    /must name at least one action kind/,
  );
});

test("loads valid JSON and wraps unreadable or malformed config errors", async () => {
  const directory = path.resolve(`.domain-config-test-${randomUUID()}`);
  const validPath = path.join(directory, "domain.json");
  const malformedPath = path.join(directory, "malformed.json");
  await mkdir(directory);
  await writeFile(validPath, JSON.stringify(makeConfig()));
  await writeFile(malformedPath, "{");

  try {
    const loaded = await loadDomainConfig(validPath);
    assert.equal(loaded.configPath, validPath);
    assert.equal(loaded.domain.repository, "example/domain");
    await assert.rejects(
      loadDomainConfig(malformedPath),
      /Unable to read PAN domain config .*malformed\.json/,
    );
    await assert.rejects(
      loadDomainConfig(path.join(directory, "missing.json")),
      /Unable to read PAN domain config .*missing\.json/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function makeConfig() {
  return {
    version: 1,
    domain: {
      repository: "example/domain",
      projectOwner: "example",
      projectNumber: 12,
      path: path.resolve("domain-clone"),
    },
    state: {
      branch: "pan-state",
      path: ".pan",
    },
    agent: {
      name: "pan",
    },
  };
}
