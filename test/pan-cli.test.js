import assert from "node:assert/strict";
import test from "node:test";

import { parsePanArgs } from "../src/index.js";

test("parses attention commands from PAN_PROFILE", () => {
  assert.deepEqual(
    parsePanArgs(["inbox", "--json"], { PAN_PROFILE: "runner.json" }),
    {
      command: "inbox",
      profile: "runner.json",
      json: true,
    },
  );
  assert.deepEqual(
    parsePanArgs(["answer", "42", "Use option A."], {
      PAN_PROFILE: "runner.json",
    }),
    {
      command: "answer",
      profile: "runner.json",
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
      "--profile",
      "runner.json",
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
      profile: "runner.json",
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

test("requires explicit store configuration", () => {
  assert.throws(() => parsePanArgs(["inbox"], {}), /PAN_PROFILE/);
});
