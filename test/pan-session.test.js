import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  buildSessionCopilotArgs,
  startPanSession,
  verifyCopilotContract,
} from "../src/index.js";

test("launches one ordinary foreground Copilot session in the validated domain", async () => {
  const launches = [];
  const config = sessionConfig();
  const result = await startPanSession({
    config,
    configPath: "C:\\domains\\example\\pan.json",
    env: {
      PATH: "test-path",
      PAN_HOST_TOKEN: "must-not-reach-child",
      PAN_RUNTIME_STATE: "must-not-reach-child",
    },
    assetService: { status: async () => ({ status: "current" }) },
    domainIdentity: {
      validate: async () => ({
        domain: {
          repository: "example/domain",
          path: "C:\\domains\\example",
          defaultBranch: "main",
        },
        project: { owner: "example", number: 12, id: "PVT_test" },
      }),
    },
    verifyCopilot: async ({ executable }) => assert.equal(executable, "copilot-test"),
    executable: "copilot-test",
    spawnProcess(executable, args, options) {
      launches.push({ executable, args, options });
      const child = new EventEmitter();
      process.nextTick(() => child.emit("close", 17, null));
      return child;
    },
  });

  assert.equal(result.exitCode, 17);
  assert.equal(launches[0].executable, "copilot-test");
  assert.equal(launches[0].options.cwd, "C:\\domains\\example");
  assert.equal(launches[0].options.stdio, "inherit");
  assert.equal(launches[0].options.windowsHide, false);
  assert.deepEqual(launches[0].args, [
    "--agent",
    "pan",
    "--no-auto-update",
    "--model",
    "gpt-5.6-sol",
    "--add-dir",
    "C:\\product-reference",
  ]);
  assert.equal(launches[0].options.env.PAN_HOST_TOKEN, undefined);
  assert.equal(launches[0].options.env.PAN_RUNTIME_STATE, undefined);
  assert.equal(
    launches[0].options.env.PAN_DOMAIN_CONFIG,
    "C:\\domains\\example\\pan.json",
  );
  assert.equal(launches[0].options.env.PAN_DOMAIN_REPOSITORY, "example/domain");
  assert.deepEqual(
    JSON.parse(launches[0].options.env.PAN_PRODUCT_CONTEXT_ROOTS),
    [{ label: "product", path: "C:\\product-reference" }],
  );
  assert.ok(!launches[0].args.some((arg) => arg.includes("mcp")));
});

test("refuses to launch while user-scoped PAN assets need repair", async () => {
  await assert.rejects(
    startPanSession({
      config: sessionConfig(),
      configPath: "C:\\domains\\example\\pan.json",
      assetService: { status: async () => ({ status: "stale" }) },
      domainIdentity: { validate: async () => assert.fail("identity must not run") },
      spawnProcess: () => assert.fail("Copilot must not launch"),
    }),
    /assets are stale/,
  );
});

test("requires the supported ordinary Copilot session contract", async () => {
  await assert.rejects(
    verifyCopilotContract({
      executable: "copilot-test",
      commands: { run: async () => "--agent --model" },
    }),
    /--add-dir/,
  );
});

test("does not add product context when none is configured", () => {
  const config = sessionConfig();
  config.session.productContextRoots = [];
  assert.deepEqual(buildSessionCopilotArgs({ config }), [
    "--agent",
    "pan",
    "--no-auto-update",
    "--model",
    "gpt-5.6-sol",
  ]);
});

function sessionConfig() {
  return {
    domain: {
      repository: "example/domain",
      projectOwner: "example",
      projectNumber: 12,
      path: "C:\\domains\\example",
    },
    state: { branch: "pan-state", path: ".pan", leaderPath: ".pan/leader.json" },
    session: {
      agent: { name: "pan", executable: "copilot-test", model: "gpt-5.6-sol" },
      productContextRoots: [
        { label: "product", path: "C:\\product-reference" },
      ],
    },
  };
}
