import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  handleMcpRequest,
  TOOL_NAMES,
} from "./fixtures/copilot-spike/tools/pan-tools.js";
import {
  buildScheduleBootstrapPrompt,
  createInitialSessionDueState,
  isSessionReviewDue,
  MAX_NATIVE_SCHEDULE_INTERVAL_SECONDS,
  recordSessionReview,
  verifyCopilotInvocationContract,
} from "../src/index.js";

const FIXTURE_PATH = path.resolve("test/fixtures/copilot-spike");
const SESSION_ID = "00000000-0000-4000-8000-000000000001";

test("package tests exclude executable fixture files", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));

  assert.equal(packageJson.scripts.test, "node --test test/*.test.js");
});

test("defines a bounded native scheduling bootstrap contract", () => {
  const prompt = buildScheduleBootstrapPrompt({
    scheduling: {
      enabled: true,
      startup: "immediate",
      reviewIntervalSeconds: 86_400,
    },
    dueStatePath: "C:\\runtime\\session-a.due.json",
  });

  assert.equal(MAX_NATIVE_SCHEDULE_INTERVAL_SECONDS, 3_600);
  assert.match(prompt, /exactly one native session-scoped recurring schedule/i);
  assert.match(prompt, /\/every 3600s/);
  assert.match(prompt, /C:\\runtime\\session-a\.due\.json/);
  assert.match(prompt, /Run one fresh startup review now/i);
  assert.match(prompt, /fresh complete portfolio evidence/i);
});

test("requires the documented Copilot schedule commands or gives manual guidance", async () => {
  await assert.rejects(
    verifyCopilotInvocationContract({
      commands: {
        run: async () =>
          "--agent --add-dir --model --no-auto-update --interactive",
      },
      requireScheduling: true,
    }),
    /Upgrade Copilot CLI.*\/every 3600s/i,
  );

  await verifyCopilotInvocationContract({
    commands: {
      run: async () =>
        "--agent --add-dir --model --no-auto-update --interactive /every /after",
    },
    requireScheduling: true,
  });
});

test("uses launch-local due state without replaying another session", () => {
  const state = createInitialSessionDueState({
    sessionId: "session-a",
    reviewIntervalSeconds: 86_400,
    now: "2026-07-22T00:00:00.000Z",
  });

  assert.equal(
    isSessionReviewDue(state, { now: "2026-07-22T23:59:59.000Z" }),
    false,
  );
  assert.equal(
    isSessionReviewDue(state, { now: "2026-07-23T00:00:00.000Z" }),
    true,
  );
  assert.deepEqual(
    recordSessionReview(state, { now: "2026-07-23T00:00:00.000Z" }),
    {
      ...state,
      lastReviewAt: "2026-07-23T00:00:00.000Z",
      nextReviewAt: "2026-07-24T00:00:00.000Z",
    },
  );
});

function buildTurnArguments(options = {}) {
  const sessionId = options.sessionId ?? SESSION_ID;
  const args = [
    "-C",
    FIXTURE_PATH,
    "--agent",
    "pan",
    "--no-ask-user",
    "--disable-builtin-mcps",
    "--no-remote",
    "--no-auto-update",
    "--disallow-temp-dir",
    "--available-tools=pan-spike-read_portfolio",
    "--allow-tool=pan-spike(read_portfolio)",
    "--output-format",
    "json",
    "--stream",
    "off",
  ];

  if (options.resume) {
    args.push(`--resume=${sessionId}`);
  } else {
    args.push("--session-id", sessionId);
  }

  return args;
}

test("uses prompt-mode JSONL turns with the pan agent and one named tool", () => {
  const args = buildTurnArguments();

  assert.deepEqual(args.slice(0, 4), [
    "-C",
    FIXTURE_PATH,
    "--agent",
    "pan",
  ]);
  assert.ok(!args.includes("-p"));
  assert.ok(args.includes("--available-tools=pan-spike-read_portfolio"));
  assert.ok(args.includes("--allow-tool=pan-spike(read_portfolio)"));
  assert.ok(args.includes("--disable-builtin-mcps"));
  assert.ok(args.includes("--output-format"));
  assert.ok(args.includes("--session-id"));
  assert.ok(!args.includes("--allow-all-tools"));
});

test("resumes conversational state in a separate bounded turn process", () => {
  const args = buildTurnArguments({ resume: true });

  assert.equal(args.at(-1), `--resume=${SESSION_ID}`);
  assert.ok(!args.includes("--session-id"));
});

test("fixture custom agent and MCP configuration remain repository-local", async () => {
  const agent = await readFile(
    path.join(FIXTURE_PATH, ".github/agents/pan.agent.md"),
    "utf8",
  );
  const config = JSON.parse(
    await readFile(path.join(FIXTURE_PATH, ".github/mcp.json"), "utf8"),
  );

  assert.match(agent, /PAN_SPIKE_AGENT/);
  assert.deepEqual(
    config.mcpServers["pan-spike"].tools,
    TOOL_NAMES,
  );
  assert.equal(config.mcpServers["pan-spike"].command, "node");
});

test("fixture tool returns only synthetic structured portfolio data", () => {
  const response = handleMcpRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "read_portfolio", arguments: {} },
  });

  assert.equal(response.id, 1);
  assert.deepEqual(
    JSON.parse(response.result.content[0].text),
    {
      domain: "fixture",
      projects: [{ id: "fixture-1", title: "Synthetic PAN project" }],
    },
  );
});

test("fixture exposes malformed output without affecting the safe tool", () => {
  const malformed = handleMcpRequest({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "malformed_result", arguments: {} },
  });

  assert.equal(malformed.result.content, "not-an-mcp-content-array");
  assert.deepEqual(TOOL_NAMES, ["read_portfolio", "malformed_result"]);
});

test("fixture tool adapter speaks newline-delimited MCP JSON-RPC over stdio", async () => {
  const child = spawn(
    process.execPath,
    [path.join(FIXTURE_PATH, "tools/pan-tools.js")],
    {
      cwd: FIXTURE_PATH,
      env: { ...process.env, PAN_MCP_SERVER: "1" },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  let stdout = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });

  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {},
    })}\n`,
  );
  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    })}\n`,
  );
  child.stdin.end();
  await once(child, "close");

  const responses = stdout.trim().split(/\r?\n/).map(JSON.parse);
  assert.equal(responses[0].result.serverInfo.name, "pan-spike");
  assert.deepEqual(
    responses[1].result.tools.map((tool) => tool.name),
    TOOL_NAMES,
  );
});

test(
  "opt-in live contract reaches the installed authenticated Copilot CLI",
  { skip: process.env.PAN_LIVE_COPILOT_SPIKE !== "1", timeout: 120_000 },
  async () => {
    const child = spawn(
      process.env.COPILOT_EXECUTABLE ?? "copilot",
      buildTurnArguments({ sessionId: randomUUID() }),
      {
        cwd: FIXTURE_PATH,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.stdin.end(
      "Identify yourself, then call read_portfolio and name its project.",
      "utf8",
    );

    const [code] = await once(child, "close");
    assert.equal(code, 0, stderr);
    const events = stdout.trim().split(/\r?\n/).map(JSON.parse);
    const assistantText = events
      .filter((event) => event.type === "assistant.message")
      .map((event) => event.data.content)
      .join("\n");
    assert.match(assistantText, /PAN_SPIKE_AGENT/);
    assert.match(assistantText, /Synthetic PAN project/);
    assert.equal(events.at(-1).type, "result");
    assert.equal(events.at(-1).exitCode, 0);
  },
);
