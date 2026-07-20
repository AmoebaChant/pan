import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import path from "node:path";
import test from "node:test";

import { PanAgentClient } from "../src/index.js";

const FIXTURE = path.resolve("test/fixtures/fake-pan-agent.js");

test("uses one custom agent for review and chat turns", async () => {
  const client = fixtureClient({
    agent: "pan",
    extraArgs: ["--max-ai-credits", "5"],
    model: "fixture-model",
  });

  const review = await client.review(turn("autonomous-review"));
  const sessionId = randomUUID();
  const chat = await client.chat(
    turn("interactive-chat", { userInput: "Why this order?" }),
    { sessionId, resume: true },
  );

  assert.equal(review.response.mode, "autonomous-review");
  assert.equal(chat.response.mode, "interactive-chat");
  assert.equal(chat.sessionId, sessionId);
  const args = review.result.data.arguments;
  assert.deepEqual(args.slice(0, 6), [
    "-C",
    path.resolve("."),
    "-p",
    args[3],
    "--agent",
    "pan",
  ]);
  for (const expected of [
    "--no-ask-user",
    "--disable-builtin-mcps",
    "--no-remote",
    "--no-auto-update",
    "--disallow-temp-dir",
    "--available-tools=pan-tools-read_portfolio",
    "--allow-tool=pan-tools(read_portfolio)",
    "--output-format",
    "--stream",
    "--model",
    "fixture-model",
    "--max-ai-credits",
    "5",
  ]) {
    assert.ok(args.includes(expected), `missing argument ${expected}`);
  }
  assert.ok(args.includes("--session-id"));
  assert.equal(chat.result.data.arguments.at(-1), `--resume=${sessionId}`);
});

test("supports an inline portfolio without exposing unavailable tools", async () => {
  const client = fixtureClient();
  const result = await client.review(
    {
      ...turn("autonomous-review"),
      portfolio: { project: { items: ["item-1"] } },
    },
    { inlinePortfolio: true },
  );

  const args = result.result.data.arguments;
  assert.ok(!args.some((argument) => argument.startsWith("--available-tools")));
  assert.ok(!args.some((argument) => argument.startsWith("--allow-tool")));
  assert.match(args[3], /complete portfolio snapshot is embedded/i);
});

test("validates and reports multiple bounded tool exchanges", async () => {
  const messages = [];
  const client = fixtureClient({
    scenario: "tools",
    onToolMessage: async (message) => messages.push(message),
  });

  const result = await client.review(
    turn("autonomous-review", {
      allowedOperations: ["read_portfolio", "propose_actions"],
    }),
  );

  assert.equal(result.toolMessages.length, 4);
  assert.deepEqual(
    messages.map((message) => `${message.type}:${message.operation}`),
    [
      "tool-request:read_portfolio",
      "tool-result:read_portfolio",
      "tool-request:propose_actions",
      "tool-result:propose_actions",
    ],
  );
});

test("includes reasoning response requirements in the agent prompt", async () => {
  const client = fixtureClient();
  const result = await client.review({
    ...turn("autonomous-review"),
    portfolio: {
      canonicalOrder: ["item-1"],
      dossiers: [],
      manualConstraints: [],
      authority: {},
    },
    responseRequirements: {
      classifications: "Classify every item.",
      humanNextAction: "Recommend human work.",
      agentQueueRecommendation: "Recommend agent work.",
    },
  });
  const prompt = result.result.data.arguments[3];

  assert.match(prompt, /"classifications":\[\{"itemId":"item-1"/);
  assert.match(prompt, /"humanNextAction":/);
  assert.match(prompt, /"agentQueueRecommendation":/);
  assert.match(prompt, /Follow responseRequirements exactly/);
});

test("rejects unknown tools before invoking the callback", async () => {
  let callbackCount = 0;
  const client = fixtureClient({
    scenario: "unknown-tool",
    onToolMessage: async () => {
      callbackCount += 1;
    },
  });

  await assert.rejects(
    client.review(turn("autonomous-review")),
    (error) =>
      error.turnId === "turn-1" &&
      error.state === "unknown-tool" &&
      error.confirmedSideEffects === false,
  );
  assert.equal(callbackCount, 0);
});

test("rejects malformed JSONL output with turn and transport state", async () => {
  const client = fixtureClient({ scenario: "malformed" });

  await assert.rejects(
    client.review(turn("autonomous-review")),
    (error) =>
      error.turnId === "turn-1" &&
      error.state === "malformed-jsonl" &&
      error.confirmedSideEffects === false,
  );
});

test("times out and cancels bounded child processes", async () => {
  const timeoutClient = fixtureClient({ scenario: "timeout", timeout: 50 });
  const timeoutError = await captureRejection(
    timeoutClient.review(turn("autonomous-review")),
  );
  assert.equal(timeoutError.state, "timeout");
  assertProcessGone(readFixturePid(timeoutError));

  const controller = new AbortController();
  const cancelClient = fixtureClient({ scenario: "cancel", timeout: 10_000 });
  const pending = cancelClient.review(turn("autonomous-review"), {
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 50);
  const cancelError = await captureRejection(pending);
  assert.equal(cancelError.state, "cancelled");
  assertProcessGone(readFixturePid(cancelError));
});

test("reports nonzero exits and confirmed tool side effects", async () => {
  const client = fixtureClient({ scenario: "nonzero" });

  await assert.rejects(
    client.review(turn("autonomous-review")),
    (error) =>
      error.state === "nonzero-exit" &&
      error.exitCode === 7 &&
      error.confirmedSideEffects === true,
  );
});

test("strips delivery credentials from the Copilot child", async () => {
  const client = fixtureClient({
    env: {
      ...process.env,
      GH_TOKEN: "must-not-leak",
      GITHUB_TOKEN: "must-not-leak",
      SSH_AUTH_SOCK: "must-not-leak",
      GIT_ASKPASS: "must-not-leak",
    },
  });

  await client.review(turn("autonomous-review"));
});

test("enforces the configured output bound", async () => {
  const client = fixtureClient({
    maxBuffer: 1_024,
    scenario: "output-limit",
  });

  await assert.rejects(
    client.review(turn("autonomous-review")),
    (error) => error.state === "output-limit",
  );
});

function fixtureClient(options = {}) {
  const {
    agent,
    env = process.env,
    extraArgs,
    maxBuffer,
    model,
    onToolMessage,
    inlinePortfolio = false,
    scenario = "success",
    timeout = 2_000,
  } = options;
  return new PanAgentClient({
    executable: process.execPath,
    executableArgs: [FIXTURE],
    cwd: path.resolve("."),
    env: { ...env, PAN_FAKE_SCENARIO: scenario },
    agent,
    extraArgs,
    maxBuffer,
    model,
    timeout,
    onToolMessage,
    inlinePortfolio,
  });
}

function readFixturePid(error) {
  const firstLine = error.cause.stdout.trim().split(/\r?\n/, 1)[0];
  return JSON.parse(firstLine).data.pid;
}

async function captureRejection(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail("Expected promise to reject");
}

function assertProcessGone(pid) {
  assert.throws(
    () => process.kill(pid, 0),
    (error) => error.code === "ESRCH",
    `fixture process ${pid} is still running`,
  );
}

function turn(mode, options = {}) {
  return {
    version: 1,
    type: "request",
    turnId: "turn-1",
    mode,
    timestamp: "2026-07-20T21:00:00.000Z",
    snapshot: {
      id: "snapshot-1",
      capturedAt: "2026-07-20T20:59:59.000Z",
      complete: true,
    },
    toolChannel: {
      transport: "mcp-stdio",
      server: "pan-tools",
      allowedOperations: options.allowedOperations ?? ["read_portfolio"],
    },
    ...(options.userInput ? { userInput: options.userInput } : {}),
  };
}
