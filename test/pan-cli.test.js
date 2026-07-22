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

test("parses attention commands from PAN_CONFIG", () => {
  assert.deepEqual(
    parsePanArgs(["inbox", "--json"], { PAN_CONFIG: "domain.json" }),
    {
      command: "inbox",
      config: "domain.json",
      profile: undefined,
      json: true,
    },
  );
  assert.deepEqual(
    parsePanArgs(["answer", "42", "Use option A."], {
      PAN_CONFIG: "domain.json",
    }),
    {
      command: "answer",
      config: "domain.json",
      profile: undefined,
      json: false,
      identifier: "42",
      text: "Use option A.",
    },
  );
});

test("parses add fields and repeatable requirements", () => {
  assert.deepEqual(
    parsePanArgs([
      "add",
      "Implement it",
      "--config",
      "domain.json",
      "--body",
      "Acceptance criteria.",
      "--workstream",
      "orchestration/pan",
      "--repo",
      "example/tool",
      "--requirement",
      "env:local",
      "--owner",
      "agent",
      "--autonomy",
      "full-auto",
    ]),
    {
      command: "add",
      config: "domain.json",
      profile: undefined,
      json: false,
      title: "Implement it",
      body: "Acceptance criteria.",
      bodyFile: undefined,
      workstream: "orchestration/pan",
      owner: "agent",
      priority: "normal",
      autonomy: "full-auto",
      requirements: ["env:local", "repo:example/tool"],
    },
  );
});

test("prefers explicit paths and retains legacy profile parsing", () => {
  assert.deepEqual(
    parsePanArgs(["inbox", "--config", "explicit.json"], {
      PAN_CONFIG: "environment.json",
    }),
    {
      command: "inbox",
      config: "explicit.json",
      profile: undefined,
      json: false,
    },
  );
  assert.deepEqual(
    parsePanArgs(["daemon", "--once"], { PAN_PROFILE: "runner.json" }),
    {
      command: "daemon",
      config: undefined,
      profile: "runner.json",
      once: true,
    },
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

test("requires explicit store configuration", () => {
  assert.throws(() => parsePanArgs(["inbox"], {}), /PAN_CONFIG/);
});

test("parses reasoning review and conversational commands", () => {
  assert.deepEqual(
    parsePanArgs(["review", "--apply", "--json"], {
      PAN_CONFIG: "domain.json",
    }),
    {
      command: "review",
      config: "domain.json",
      profile: undefined,
      json: true,
      apply: true,
    },
  );
  assert.deepEqual(
    parsePanArgs(["chat", "What", "next?", "--dry-run"], {
      PAN_CONFIG: "domain.json",
    }),
    {
      command: "chat",
      config: "domain.json",
      profile: undefined,
      json: false,
      apply: false,
      text: "What next?",
    },
  );
});

test("parses persistent PAN lifecycle commands", () => {
  assert.deepEqual(
    parsePanArgs(["start", "--apply", "--config", "domain.json"], {}),
    {
      command: "start",
      config: "domain.json",
      profile: undefined,
      apply: true,
      noTerminal: false,
      background: false,
    },
  );
  assert.deepEqual(
    parsePanArgs(["stop"], { PAN_CONFIG: "domain.json" }),
    {
      command: "stop",
      config: "domain.json",
      profile: undefined,
    },
  );
  assert.deepEqual(
    parsePanArgs([
      "host",
      "--state-file",
      "host.json",
      "--config",
      "domain.json",
    ]),
    {
      command: "host",
      config: "domain.json",
      profile: undefined,
      apply: false,
      stateFile: "host.json",
    },
  );
  assert.deepEqual(
    parsePanArgs(["connect", "--model", "gpt-5.6-sol"], {
      PAN_CONFIG: "domain.json",
    }),
    {
      command: "connect",
      config: "domain.json",
      profile: undefined,
      model: "gpt-5.6-sol",
    },
  );
  assert.throws(
    () =>
      parsePanArgs(["start", "--no-terminal"], {
        PAN_CONFIG: "domain.json",
      }),
    /requires --background/,
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
