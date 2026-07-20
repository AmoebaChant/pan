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

const FIXTURE_PATH = path.resolve("test/fixtures/copilot-spike");
const SESSION_ID = "00000000-0000-4000-8000-000000000001";

function buildTurnArguments(prompt, options = {}) {
  const sessionId = options.sessionId ?? SESSION_ID;
  const args = [
    "-C",
    FIXTURE_PATH,
    "-p",
    prompt,
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
  const args = buildTurnArguments("Review the fixture portfolio.");

  assert.deepEqual(args.slice(0, 6), [
    "-C",
    FIXTURE_PATH,
    "-p",
    "Review the fixture portfolio.",
    "--agent",
    "pan",
  ]);
  assert.ok(args.includes("--available-tools=pan-spike-read_portfolio"));
  assert.ok(args.includes("--allow-tool=pan-spike(read_portfolio)"));
  assert.ok(args.includes("--disable-builtin-mcps"));
  assert.ok(args.includes("--output-format"));
  assert.ok(args.includes("--session-id"));
  assert.ok(!args.includes("--allow-all-tools"));
});

test("resumes conversational state in a separate bounded turn process", () => {
  const args = buildTurnArguments("Continue the review.", { resume: true });

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
      buildTurnArguments(
        "Identify yourself, then call read_portfolio and name its project.",
        { sessionId: randomUUID() },
      ),
      {
        cwd: FIXTURE_PATH,
        stdio: ["ignore", "pipe", "pipe"],
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
