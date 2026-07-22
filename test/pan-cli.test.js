import assert from "node:assert/strict";
import test from "node:test";

import {
  parsePanArgs,
  parsePanHelperArgs,
  runPanCli,
} from "../src/index.js";

test("parses setup without pre-existing configuration", () => {
  assert.deepEqual(
    parsePanArgs([
      "setup",
      "--repository",
      "example/domain",
      "--path",
      "C:\\domains\\example",
      "--project-owner",
      "example",
      "--project-title",
      "My PAN",
      "--approval-mode",
      "prompt",
      "--json",
    ], {}),
    {
      command: "setup",
      json: true,
      repository: "example/domain",
      path: "C:\\domains\\example",
      projectOwner: "example",
      projectTitle: "My PAN",
      approvalMode: "prompt",
    },
  );

  assert.throws(
    () => parsePanArgs(["setup"], { PAN_CONFIG: "domain.json" }),
    /creates configuration/,
  );
});

test("parses asset installation commands without domain configuration", () => {
  assert.deepEqual(parsePanArgs(["assets", "status", "--json"], {}), {
    command: "assets",
    operation: "status",
    force: false,
    json: true,
  });
  assert.deepEqual(parsePanArgs(["assets", "repair", "--force"], {}), {
    command: "assets",
    operation: "repair",
    force: true,
    json: false,
  });
  assert.throws(
    () => parsePanArgs(["assets", "install", "--force"], {}),
    /only supported/,
  );
});

test("runs asset commands before loading domain configuration", async () => {
  const stdout = { value: "", write(value) { this.value += value; } };
  const expected = { status: "current", assets: [], shadows: [] };
  const result = await runPanCli(["assets", "status", "--json"], {
    stdout,
    domainConfigLoader: async () => assert.fail("config loader was called"),
    assetServiceFactory: () => ({
      status: async () => expected,
    }),
  });

  assert.equal(result, expected);
  assert.deepEqual(JSON.parse(stdout.value), expected);
});

test("parses the hostless session command", () => {
  assert.deepEqual(
    parsePanArgs(["session", "--json"], { PAN_CONFIG: "domain.json" }),
    {
      command: "session",
      config: "domain.json",
      profile: undefined,
      json: true,
    },
  );
});

test("prefers explicit configuration and rejects runner profiles for PAN commands", () => {
  assert.deepEqual(
    parsePanArgs(["session", "--config", "explicit.json"], {
      PAN_CONFIG: "environment.json",
    }),
    {
      command: "session",
      config: "explicit.json",
      profile: undefined,
      json: false,
    },
  );
  assert.throws(
    () => parsePanArgs(["session"], { PAN_PROFILE: "runner.json" }),
    /--profile and PAN_PROFILE belong to pan-runner/,
  );
});

test("rejects simultaneous domain and runner configuration", () => {
  assert.throws(
    () =>
      parsePanArgs(["inbox", "--config", "domain.json"], {
        PAN_PROFILE: "runner.json",
      }),
    /cannot be used together/,
  );
  assert.throws(
    () =>
      parsePanArgs([
        "inbox",
        "--config",
        "domain.json",
        "--profile",
        "runner.json",
      ]),
    /cannot be used together/,
  );
});

test("retires host-era commands with migration guidance", () => {
  for (const command of ["start", "stop", "host", "connect", "daemon", "chat", "review"]) {
    assert.throws(
      () => parsePanArgs([command, "--json"], {}),
      (error) => {
        assert.match(error.message, new RegExp(`pan ${command} is retired`, "i"));
        assert.match(error.message, /pan session --config <path>/i);
        assert.deepEqual(error.result, {
          version: 1,
          status: "retired",
          command,
          replacement: "pan session --config <path>",
          guidance: [error.result.guidance[0]],
        });
        return true;
      },
    );
  }
  assert.throws(
    () => parsePanArgs(["session", "--background", "--config", "domain.json"]),
    /sessions run in the foreground/i,
  );
});

test("rejects unknown helper inputs before constructing command context", async () => {
  const handlers = {
    evidence: {
      snapshot: Object.assign(async () => assert.fail("handler must not run"), {
        specification: { options: ["scope"], flags: ["refresh"] },
      }),
    },
  };
  assert.throws(
    () =>
      parsePanHelperArgs(
        ["evidence", "unknown", "--schema-version", "1", "--config", "domain.json"],
        { handlers },
      ),
    /Unknown PAN evidence operation/,
  );
  assert.throws(
    () =>
      parsePanHelperArgs(
        [
          "evidence",
          "snapshot",
          "--schema-version",
          "2",
          "--config",
          "domain.json",
        ],
        { handlers },
      ),
    /Unsupported PAN command schema version/,
  );
  await assert.rejects(
    runPanCli(
      [
        "evidence",
        "snapshot",
        "--schema-version",
        "1",
        "--config",
        "domain.json",
        "--unknown",
      ],
      {
        commandHandlers: handlers,
        commandContextFactory: async () =>
          assert.fail("context must not be constructed"),
      },
    ),
    /Unknown option/,
  );
});

test("dispatches a strict helper command with one fresh command context", async () => {
  const output = [];
  let contexts = 0;
  const handler = Object.assign(
    async ({ context, options }) => ({
      version: 1,
      status: "confirmed",
      operation: "evidence.snapshot",
      operationId: "snapshot-1",
      domain: context.domain,
      confirmedEffects: [`Read ${options.scope}.`],
      remainingSteps: [],
      diagnostics: [],
      recovery: { safe: true, steps: [] },
    }),
    { specification: { options: ["scope"] } },
  );
  const result = await runPanCli(
    [
      "evidence",
      "snapshot",
      "--schema-version",
      "1",
      "--config",
      "domain.json",
      "--scope",
      "all",
      "--json",
    ],
    {
      commandHandlers: { evidence: { snapshot: handler } },
      commandContextFactory: async () => {
        contexts += 1;
        return {
          domain: {
            repository: "example/domain",
            projectOwner: "example",
            projectNumber: 12,
          },
        };
      },
      stdout: { write: (value) => output.push(value) },
    },
  );
  assert.equal(contexts, 1);
  assert.equal(result.status, "confirmed");
  assert.equal(output.length, 1);
  assert.equal(JSON.parse(output[0]).operation, "evidence.snapshot");
});

test("dispatches reconcile missing-issues with an opt-in apply flag", async () => {
  const output = [];
  const handler = Object.assign(
    async ({ context, options }) => ({
      version: 1,
      status: "confirmed",
      operation: "reconcile.missing-issues",
      operationId: "reconcile-1",
      domain: context.domain,
      confirmedEffects: [options.apply ? "Applied reconciliation." : "Planned reconciliation."],
      remainingSteps: [],
      diagnostics: [],
      recovery: { safe: true, steps: [] },
    }),
    { specification: { flags: ["apply"] } },
  );

  const result = await runPanCli(
    [
      "reconcile",
      "missing-issues",
      "--schema-version",
      "1",
      "--config",
      "domain.json",
      "--apply",
      "--json",
    ],
    {
      commandHandlers: { reconcile: { "missing-issues": handler } },
      commandContextFactory: async () => ({
        domain: {
          repository: "example/domain",
          projectOwner: "example",
          projectNumber: 12,
        },
      }),
      stdout: { write: (value) => output.push(value) },
    },
  );

  assert.equal(result.status, "confirmed");
  assert.equal(JSON.parse(output[0]).confirmedEffects[0], "Applied reconciliation.");
});

test("dispatches reconcile merged-prs with a per-item receipt", async () => {
  const output = [];
  const handler = Object.assign(
    async ({ context, options }) => ({
      version: 1,
      status: "confirmed",
      operation: "reconcile.merged-prs",
      operationId: "merged-1",
      domain: context.domain,
      receipts: [
        {
          itemId: "item-1",
          issueNumber: 1,
          issueUrl: "https://github.com/example/domain/issues/1",
          pullRequestUrl: "https://github.com/example/domain/pull/42",
          projectStatus: options.apply ? "confirmed" : "planned",
          issueStatus: options.apply ? "confirmed" : "planned",
        },
      ],
      confirmedEffects: ["Confirmed merged pull request completion."],
      remainingSteps: [],
      diagnostics: [],
      recovery: { safe: true, steps: [] },
    }),
    { specification: { flags: ["apply"] } },
  );

  const result = await runPanCli(
    [
      "reconcile",
      "merged-prs",
      "--schema-version",
      "1",
      "--config",
      "domain.json",
      "--apply",
      "--json",
    ],
    {
      commandHandlers: { reconcile: { "merged-prs": handler } },
      commandContextFactory: async () => ({
        domain: {
          repository: "example/domain",
          projectOwner: "example",
          projectNumber: 12,
        },
      }),
      stdout: { write: (value) => output.push(value) },
    },
  );

  assert.equal(result.receipts[0].issueStatus, "confirmed");
  assert.equal(JSON.parse(output[0]).operation, "reconcile.merged-prs");
});
