import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  buildSessionCopilotArgs,
  startPanSession,
  verifyCopilotContract,
} from "../src/index.js";

test("launches an ordinary foreground Copilot session", async () => {
  const launches = [];
  const result = await startPanSession({
    config: sessionConfig(),
    configPath: "C:\\domains\\example\\pan.json",
    env: {
      PATH: "test-path",
      PAN_HOST_TOKEN: "must-not-reach-child",
      PAN_LEADERSHIP_HOLDER: "must-not-reach-child",
    },
    sessionIdFactory: () => "session-a",
    assetService: { status: async () => ({ status: "current" }) },
    domainIdentity: { validate: async () => identity() },
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
  assert.equal(result.mode, undefined);
  assert.equal(result.leadership, undefined);
  assert.equal(launches[0].options.cwd, "C:\\domains\\example");
  assert.equal(launches[0].options.stdio, "inherit");
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
  assert.equal(launches[0].options.env.PAN_LEADERSHIP_HOLDER, undefined);
  assert.equal(launches[0].options.env.PAN_SESSION_ID, "session-a");
  assert.equal(launches[0].options.env.PAN_DOMAIN_REPOSITORY, "example/domain");
  assert.match(
    launches[0].options.env.PAN_PROJECT_SCHEMA,
    /schema[\\/]project-fields\.json$/,
  );
});

test("bootstraps the configured native schedule without a leadership mode", async () => {
  let launch;
  let contract;
  let disposed = false;
  const config = sessionConfig();
  config.scheduling = {
    enabled: true,
    startup: "manual",
    reviewIntervalSeconds: 7_200,
    retrySeconds: 60,
    rateLimitRetrySeconds: 900,
  };

  await startPanSession({
    config,
    configPath: "C:\\domains\\example\\pan.json",
    env: {},
    sessionIdFactory: () => "session-a",
    assetService: { status: async () => ({ status: "current" }) },
    domainIdentity: { validate: async () => identity() },
    verifyCopilot: async (options) => {
      contract = options;
    },
    dueStateFactory: async () => ({
      path: "C:\\runtime\\session-a.due.json",
      dispose: async () => {
        disposed = true;
      },
    }),
    spawnProcess: (_executable, args, options) => {
      launch = { args, options };
      const child = new EventEmitter();
      process.nextTick(() => child.emit("close", 0, null));
      return child;
    },
  });

  assert.equal(contract.requireScheduling, true);
  assert.equal(
    launch.options.env.PAN_SCHEDULE_DUE_STATE,
    "C:\\runtime\\session-a.due.json",
  );
  assert.match(
    launch.args[launch.args.indexOf("--interactive") + 1],
    /\/every 3600s/,
  );
  assert.equal(disposed, true);
});

test("rejects stale installed assets before launch", async () => {
  await assert.rejects(
    startPanSession({
      config: sessionConfig(),
      configPath: "C:\\domains\\example\\pan.json",
      assetService: { status: async () => ({ status: "stale" }) },
    }),
    /pan assets repair/,
  );
});

test("builds and verifies the Copilot invocation contract", async () => {
  assert.deepEqual(buildSessionCopilotArgs({ config: sessionConfig() }), [
    "--agent",
    "pan",
    "--no-auto-update",
    "--model",
    "gpt-5.6-sol",
    "--add-dir",
    "C:\\product-reference",
  ]);
  let invocation;
  await verifyCopilotContract({
    executable: "copilot-test",
    commands: {
      run: async (executable, args) => {
        invocation = { executable, args };
        return [
          "Usage: copilot [options]",
          "--agent <name>",
          "--add-dir <path>",
          "--model <model>",
          "--no-auto-update",
          "--interactive <prompt>",
        ].join("\n");
      },
    },
  });
  assert.deepEqual(invocation, {
    executable: "copilot-test",
    args: ["--help"],
  });
});

function sessionConfig() {
  return {
    domain: {
      repository: "example/domain",
      projectOwner: "example",
      projectNumber: 12,
      path: "C:\\domains\\example",
    },
    session: {
      agent: {
        name: "pan",
        executable: "copilot-test",
        model: "gpt-5.6-sol",
      },
      productContextRoots: [
        { label: "product", path: "C:\\product-reference" },
      ],
    },
    scheduling: { enabled: false },
  };
}

function identity() {
  return {
    domain: {
      repository: "example/domain",
      path: "C:\\domains\\example",
      defaultBranch: "main",
    },
    project: { owner: "example", number: 12, id: "PVT_test" },
  };
}
