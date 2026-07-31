import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  loadDomainConfig,
  migrateDomainConfig,
  migrateDomainConfigFile,
  replaceDomainConfigFile,
  validateDomainConfig,
} from "../src/index.js";

test("normalizes the minimal version 2 session configuration", () => {
  const config = validateDomainConfig(makeConfig());

  assert.equal(config.version, 2);
  assert.deepEqual(config.session.productContextRoots, []);
  assert.equal(config.session.agent.executable, "copilot");
  assert.deepEqual(config.scheduling, {
    enabled: true,
    startup: "immediate",
    reviewIntervalSeconds: 86_400,
    retrySeconds: 60,
    rateLimitRetrySeconds: 900,
    triageAuthority: "report",
  });
  assert.equal(config.state, undefined);
  assert.equal(config.leadership, undefined);
  assert.equal(config.policy, undefined);
  assert.equal(config.cadences, undefined);
  assert.equal(config.transcripts, undefined);
});

test("resolves the domain checkout from the configuration file location", () => {
  const configPath = path.resolve("portable-domain", "pan.json");
  const source = makeConfig();
  source.domain.path = "path-from-another-machine";

  const config = validateDomainConfig(source, { configPath });

  assert.equal(config.domain.path, path.dirname(configPath));

  delete source.domain.path;
  assert.equal(
    validateDomainConfig(source, { configPath }).domain.path,
    path.dirname(configPath),
  );

  assert.throws(
    () => validateDomainConfig(source),
    /domain\.path is required when configPath is not provided/,
  );

  const relative = makeConfig();
  relative.domain.path = "relative-domain";
  assert.throws(
    () => validateDomainConfig(relative),
    /domain\.path must be an absolute path/,
  );
});

test("reads version 1 into the version 2 runtime shape with diagnostics", () => {
  const legacy = makeVersion1Config();
  legacy.cadences = {
    fullReviewSeconds: 3_600,
    leaderLeaseSeconds: 90,
    leaderHeartbeatSeconds: 30,
    activePollSeconds: 30,
  };
  legacy.transcripts = { path: ".pan/history", retentionDays: 7 };

  const config = validateDomainConfig(legacy);

  assert.equal(config.version, 2);
  assert.equal(config.session.agent.name, "pan");
  assert.equal(config.scheduling.reviewIntervalSeconds, 3_600);
  assert.equal(config.leadership, undefined);
  assert.match(
    config.migrationDiagnostics.join("\n"),
    /activePollSeconds: obsolete host polling setting removed/,
  );
  assert.match(
    config.migrationDiagnostics.join("\n"),
    /transcripts: obsolete host transcript setting removed/,
  );
  assert.match(
    config.migrationDiagnostics.join("\n"),
    /leaderLeaseSeconds: obsolete session leadership setting removed/,
  );
});

test("proposes an explicit version 2 migration without mutating the input", () => {
  const source = makeVersion1Config();
  const { document, diagnostics } = migrateDomainConfig(source);

  assert.equal(source.version, 1);
  assert.equal(document.version, 2);
  assert.equal(document.session.agent.name, "pan");
  assert.equal(document.scheduling.reviewIntervalSeconds, 86_400);
  assert.equal(document.domain.path, undefined);
  assert.match(diagnostics.join("\n"), /cadences.fullReviewSeconds/);
});

test("migrates a pathless version 2 configuration file", async () => {
  const directory = path.resolve(`.domain-config-portable-${randomUUID()}`);
  const configPath = path.join(directory, "pan.json");
  const source = makeConfig();
  delete source.domain.path;
  await mkdir(directory);
  await writeFile(configPath, JSON.stringify(source));

  try {
    const migration = await migrateDomainConfigFile(configPath);

    assert.equal(migration.document.domain.path, undefined);
    assert.equal(migration.config.domain.path, directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("validates product-context roots and scheduling", () => {
  const config = makeConfig();
  config.session.productContextRoots = [
    { label: "product", path: path.resolve("product-context") },
  ];
  config.scheduling = { reviewIntervalSeconds: 600, retrySeconds: 60 };
  assert.equal(
    validateDomainConfig(config).session.productContextRoots[0].label,
    "product",
  );

  config.session.productContextRoots[0].path = "relative";
  assert.throws(
    () => validateDomainConfig(config),
    /session\.productContextRoots\[0\]\.path must be an absolute path/,
  );

  const duplicate = makeConfig();
  duplicate.session.productContextRoots = [
    { label: "product", path: path.resolve("one") },
    { label: "product", path: path.resolve("two") },
  ];
  assert.throws(
    () => validateDomainConfig(duplicate),
    /must not duplicate another product-context root label/,
  );

  const retry = makeConfig();
  retry.scheduling = { retrySeconds: 120, rateLimitRetrySeconds: 60 };
  assert.throws(
    () => validateDomainConfig(retry),
    /scheduling\.rateLimitRetrySeconds must be greater than or equal/,
  );

  const rejectedAuthority = makeConfig();
  rejectedAuthority.scheduling = { triageAuthority: "everything" };
  assert.throws(
    () => validateDomainConfig(rejectedAuthority),
    /scheduling\.triageAuthority must be "report" or "triage-fields"/,
  );

});

test("accepts obsolete version 2 fields only as ignored compatibility input", () => {
  const config = makeConfig();
  config.state = { branch: "pan-state", path: ".pan" };
  config.leadership = { leaseSeconds: 60, heartbeatSeconds: 60 };
  config.policy = { automatic: ["anything"] };

  const normalized = validateDomainConfig(config);

  assert.deepEqual(normalized.state, { branch: "pan-state", path: ".pan" });
  assert.equal(normalized.leadership, undefined);
  assert.equal(normalized.policy, undefined);
  assert.match(normalized.migrationDiagnostics.join("\n"), /leadership.*ignored/);
  assert.match(normalized.migrationDiagnostics.join("\n"), /policy.*ignored/);
});

test("rejects runner-only, credentials, and version 2 host fields", () => {
  for (const key of ["machine", "repositories", "terminal", "workspaceRoot"]) {
    assert.throws(
      () => validateDomainConfig({ ...makeConfig(), [key]: {} }),
      new RegExp(`${key} is runner-only`),
    );
  }

  const credential = makeConfig();
  credential.session.agent.token = "must-not-be-stored";
  assert.throws(
    () => validateDomainConfig(credential),
    /session\.agent\.token is not a supported configuration field/,
  );

  const hostSetting = makeConfig();
  hostSetting.cadences = {};
  assert.throws(
    () => validateDomainConfig(hostSetting),
    /cadences is not a supported Pan domain configuration field/,
  );
});

test("replaces and migrates files atomically", async () => {
  const directory = path.resolve(`.domain-config-test-${randomUUID()}`);
  const configPath = path.join(directory, "domain.json");
  await mkdir(directory);
  await writeFile(configPath, JSON.stringify(makeVersion1Config()));

  try {
    const migration = await migrateDomainConfigFile(configPath);
    const stored = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(migration.document.version, 2);
    assert.equal(stored.version, 2);

    const original = await readFile(configPath, "utf8");
    await assert.rejects(
      replaceDomainConfigFile(configPath, { version: 2 }),
      /domain must be an object/,
    );
    assert.equal(await readFile(configPath, "utf8"), original);

    const loaded = await loadDomainConfig(configPath);
    assert.equal(loaded.configPath, configPath);
    assert.equal(loaded.domain.path, directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("publishes a parseable versioned domain configuration schema", async () => {
  const schema = JSON.parse(
    await readFile(path.resolve("schema/domain-config.json"), "utf8"),
  );

  assert.equal(schema.title, "Pan domain runtime configuration");
  assert.equal(schema.$defs.version1.properties.version.const, 1);
  assert.equal(schema.$defs.version2.properties.version.const, 2);
  assert.equal(schema.$defs.version3.properties.version.const, 3);
  assert.ok(schema.$defs.version2.properties.session);
  assert.equal(
    schema.$defs.domain.required.includes("path"),
    false,
  );
});

test("publishes a machine-local API domain locator schema", async () => {
  const schema = JSON.parse(
    await readFile(path.resolve("schema/machine-domain-config.json"), "utf8"),
  );

  assert.equal(schema.properties.kind.const, "pan-machine");
  assert.deepEqual(schema.properties.domain.required, ["repository"]);
});

function makeConfig() {
  return {
    version: 2,
    domain: {
      repository: "example/domain",
      projectOwner: "example",
      projectNumber: 12,
      path: path.resolve("domain-clone"),
    },
    session: {
      agent: {
        name: "pan",
      },
    },
  };
}

function makeVersion1Config() {
  const config = makeConfig();
  const { session, ...legacy } = config;
  return {
    ...legacy,
    version: 1,
    state: {
      branch: "pan-state",
      path: ".pan",
    },
    agent: session.agent,
  };
}
