import assert from "node:assert/strict";
import test from "node:test";

import {
  parsePanArgs,
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
      projectNumber: undefined,
      repositoryMode: undefined,
      projectMode: undefined,
      approvalMode: "prompt",
    },
  );

  assert.throws(
    () => parsePanArgs(["setup"], { PAN_CONFIG: "domain.json" }),
    /creates configuration/,
  );
});

test("parses onboarding, verification, connected setup, and shortcut commands", () => {
  assert.deepEqual(parsePanArgs(["onboard"], {}), {
    command: "onboard",
    json: false,
  });
  assert.deepEqual(
    parsePanArgs([
      "setup",
      "--repository",
      "example/domain",
      "--repository-mode",
      "connect",
      "--project-owner",
      "example",
      "--project-mode",
      "connect",
      "--project-number",
      "9",
    ], {}),
    {
      command: "setup",
      json: false,
      repository: "example/domain",
      path: undefined,
      projectOwner: "example",
      projectTitle: undefined,
      projectNumber: 9,
      repositoryMode: "connect",
      projectMode: "connect",
      approvalMode: undefined,
    },
  );
  assert.deepEqual(
    parsePanArgs([
      "verify",
      "--config",
      "domain.json",
      "--profile",
      "runner.json",
    ], {}),
    {
      command: "verify",
      config: "domain.json",
      profile: "runner.json",
      json: false,
    },
  );
  assert.deepEqual(
    parsePanArgs([
      "shortcuts",
      "create",
      "--config",
      "domain.json",
      "--profile",
      "runner.json",
      "--selection",
      "chat",
    ], {}),
    {
      command: "shortcuts",
      operation: "create",
      config: "domain.json",
      profile: "runner.json",
      selection: "chat",
      desktopPath: undefined,
      json: false,
    },
  );
});

test("runs onboarding before loading domain configuration", async () => {
  const result = await runPanCli(["onboard"], {
    domainConfigLoader: async () => assert.fail("config loader was called"),
    onboardingFactory: async () => ({ status: "completed", exitCode: 0 }),
  });

  assert.deepEqual(result, { status: "completed", exitCode: 0 });
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
      parsePanArgs(["session", "--config", "domain.json"], {
        PAN_PROFILE: "runner.json",
      }),
    /cannot be used together/,
  );
  assert.throws(
    () =>
      parsePanArgs([
        "session",
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

test("does not expose retired helper command families", () => {
  for (const command of [
    "evidence",
    "action",
    "leadership",
    "reconcile",
    "attention",
    "workstream",
  ]) {
    assert.throws(
      () => parsePanArgs([command, "--config", "domain.json"], {}),
      /Usage:/,
    );
  }
});
