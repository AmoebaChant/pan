import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const AGENT_PATH = path.resolve(".github/agents/pan.agent.md");
const ALLOWED_TOOLS = [
  "pan-tools/read_portfolio",
  "pan-tools/read_workstream",
  "pan-tools/read_issue",
  "pan-tools/read_runner_availability",
  "pan-tools/propose_actions",
];

test("defines one selectable generic PAN identity for review and chat", async () => {
  const source = await readFile(AGENT_PATH, "utf8");
  const { frontmatter, body } = parseAgent(source);

  assert.equal(frontmatter.name, "pan");
  assert.match(frontmatter.description, /chief-of-staff agent/i);
  assert.equal(frontmatter["disable-model-invocation"], "true");
  assert.equal(frontmatter["user-invocable"], "true");
  assert.deepEqual(frontmatter.tools, ALLOWED_TOOLS);
  assert.match(body, /Autonomous reviews and interactive conversations/);
  assert.match(body, /same agent/);
});

test("states complete-portfolio, evidence, uncertainty, and authority invariants", async () => {
  const source = await readFile(AGENT_PATH, "utf8");

  for (const heading of [
    "# Purpose",
    "# Communication",
    "# Portfolio reasoning",
    "# Evidence and uncertainty",
    "# Authority and actions",
    "# Output protocol",
    "# Boundaries",
  ]) {
    assert.match(source, new RegExp(`^${escapeRegex(heading)}$`, "m"));
  }
  assert.match(source, /classify\s+every Project item/i);
  assert.match(source, /facts, interpretations, assumptions, and uncertainties/i);
  assert.match(source, /runtime policy validates/i);
  assert.match(source, /PAN protocol version 1/i);
  assert.match(source, /Do not use shell commands/i);
  assert.match(source, /do\s+not create or maintain a second queue/i);
});

test("advertises only named PAN tools and no broad grants", async () => {
  const { frontmatter } = parseAgent(await readFile(AGENT_PATH, "utf8"));

  assert.deepEqual(frontmatter.tools, ALLOWED_TOOLS);
  for (const broadTool of [
    "*",
    "execute",
    "shell",
    "powershell",
    "read",
    "edit",
    "search",
    "github",
  ]) {
    assert.ok(!frontmatter.tools.includes(broadTool));
  }
});

test("contains no private identity, repository, fixture, or machine paths", async () => {
  const source = await readFile(AGENT_PATH, "utf8");

  for (const privateValue of [
    "AmoebaChant",
    "kevbrown",
    "example/domain",
    "Synthetic PAN project",
    "copilot-spike",
    "C:\\",
    "/Users/",
    "/home/",
  ]) {
    assert.ok(
      !source.includes(privateValue),
      `agent definition must not contain ${privateValue}`,
    );
  }
});

test(
  "opt-in live check discovers and selects the repository PAN agent",
  { skip: process.env.PAN_LIVE_COPILOT_SPIKE !== "1", timeout: 120_000 },
  async () => {
    const child = spawn(
      process.env.COPILOT_EXECUTABLE ?? "copilot",
      [
        "-C",
        path.resolve("."),
        "-p",
        "State your role in one sentence without using tools.",
        "--agent",
        "pan",
        "--no-ask-user",
        "--disable-builtin-mcps",
        "--no-remote",
        "--no-auto-update",
        "--disallow-temp-dir",
        "--output-format",
        "json",
        "--stream",
        "off",
        "--session-id",
        randomUUID(),
      ],
      {
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
    const discovery = events.find(
      (event) => event.type === "session.custom_agents_updated",
    );
    assert.ok(discovery.data.agents.some((agent) => agent.id === "pan"));
    assert.equal(events.at(-1).type, "result");
    assert.equal(events.at(-1).exitCode, 0);
  },
);

function parseAgent(source) {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  assert.ok(match, "agent definition must have YAML frontmatter");
  const frontmatter = {};
  let list;
  for (const line of match[1].split(/\r?\n/)) {
    const item = line.match(/^\s+-\s+(.+)$/);
    if (item && list) {
      list.push(item[1]);
      continue;
    }
    const property = line.match(/^([^:]+):\s*(.*)$/);
    assert.ok(property, `invalid frontmatter line: ${line}`);
    if (property[2]) {
      frontmatter[property[1]] = property[2];
      list = undefined;
    } else {
      list = [];
      frontmatter[property[1]] = list;
    }
  }
  return { frontmatter, body: match[2] };
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
