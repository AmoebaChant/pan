import assert from "node:assert/strict";
import test from "node:test";

import { parsePanArgs } from "../src/index.js";

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
