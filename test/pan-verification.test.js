import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { assertMatchingDomain, verifyPanSetup } from "../src/index.js";

test("verifies assets, domain identity, Copilot, and runner agreement", async () => {
  const config = makeConfig();
  const profile = makeProfile();
  const commands = [];
  const result = await verifyPanSetup({
    config,
    configPath: "C:\\domains\\example\\pan.json",
    runnerProfilePath: "C:\\domains\\example\\runners\\machine.json",
    profileLoader: async () => profile,
    assetService: { status: async () => ({ status: "current" }) },
    domainIdentity: {
      validate: async () => ({ domain: { path: config.domain.path } }),
    },
    commands: {
      async run(executable, args) {
        commands.push({ executable, args });
        return "--agent --add-dir --model --no-auto-update --interactive";
      },
    },
  });

  assert.equal(result.status, "ready");
  assert.equal(result.runnerOnline, false);
  assert.match(result.launchCommands.chat, /pan\.js' 'session' '--config'/);
  assert.match(result.launchCommands.runner, /pan-runner\.js' '--profile'/);
  assert.deepEqual(commands, [
    { executable: "copilot", args: ["--help"] },
    {
      executable: process.execPath,
      args: [
        path.resolve("bin", "pan.js"),
        "config",
        "validate",
        "--schema-version",
        "1",
        "--config",
        path.resolve("C:\\domains\\example\\pan.json"),
        "--json",
      ],
    },
    {
      executable: process.execPath,
      args: [
        path.resolve("bin", "pan-runner.js"),
        "--profile",
        path.resolve("C:\\domains\\example\\runners\\machine.json"),
        "--validate-profile",
      ],
    },
  ]);
});

test("rejects a runner aimed at another domain", () => {
  const profile = makeProfile();
  profile.store.projectNumber = 99;

  assert.throws(
    () => assertMatchingDomain(makeConfig(), profile),
    /same PAN domain/,
  );
});

test("rejects a runner that references another domain configuration file", () => {
  const profile = makeProfile();
  profile.domainConfigPath = path.resolve("C:\\domains\\other\\pan.json");

  assert.throws(
    () =>
      assertMatchingDomain(makeConfig(), profile, {
        configPath: "C:\\domains\\example\\pan.json",
        requireConfigPath: true,
      }),
    /reference the verified PAN domain configuration/,
  );
});

test("accepts a runner profile stored beside its domain configuration", () => {
  const profile = makeProfile();
  delete profile.domainConfigPath;
  profile.profilePath = path.resolve(
    "C:\\domains\\example\\runners\\machine.json",
  );

  assert.doesNotThrow(() =>
    assertMatchingDomain(makeConfig(), profile, {
      configPath: "C:\\domains\\example\\pan.json",
      requireConfigPath: true,
    }),
  );
});

function makeConfig() {
  return {
    domain: {
      repository: "example/domain",
      projectOwner: "example",
      projectNumber: 12,
      path: path.resolve("C:\\domains\\example"),
    },
    session: { agent: { name: "pan" }, productContextRoots: [] },
    scheduling: { enabled: false },
  };
}

function makeProfile() {
  return {
    online: false,
    domainConfigPath: path.resolve("C:\\domains\\example\\pan.json"),
    store: {
      repository: "example/domain",
      projectOwner: "example",
      projectNumber: 12,
      path: path.resolve("C:\\domains\\example"),
    },
  };
}
