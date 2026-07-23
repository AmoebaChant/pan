import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const ASSET_ROOT = path.resolve("assets/copilot");
const AGENT_PATH = path.join(ASSET_ROOT, "agents/pan.agent.md");
const SETUP_AGENT_PATH = path.join(ASSET_ROOT, "agents/pan-setup.agent.md");
const INSTRUCTIONS_PATH = path.join(ASSET_ROOT, "instructions/pan.instructions.md");
const MANIFEST_PATH = path.join(ASSET_ROOT, "manifest.json");

test("defines one user-scoped hostless Pan identity", async () => {
  const source = await readFile(AGENT_PATH, "utf8");
  const { frontmatter, body } = parseAgent(source);

  assert.equal(frontmatter.name, "pan");
  assert.match(frontmatter.description, /chief-of-staff agent/i);
  assert.equal(frontmatter["disable-model-invocation"], "true");
  assert.equal(frontmatter["user-invocable"], "true");
  assert.equal(frontmatter.tools, undefined);
  assert.match(body, /ordinary file, search, git, shell, and GitHub/i);
  assert.match(body, /use `gh` directly/i);
  assert.match(body, /Re-read targets before writes/i);
});

test("packages a conversational setup agent that delegates mechanics to PAN commands", async () => {
  const source = await readFile(SETUP_AGENT_PATH, "utf8");
  const { frontmatter, body } = parseAgent(source);

  assert.equal(frontmatter.name, "pan-setup");
  assert.equal(frontmatter["user-invocable"], "true");
  assert.match(body, /You are Pan speaking directly/i);
  assert.match(body, /runnerOnline.*profile.*eligib/i);
  assert.match(body, /not a\s+domain-bound Pan session/i);
  assert.match(body, /domain-bound Pan session/i);
  assert.match(body, /exact `configPath`\s+and `runnerProfilePath`/i);
  assert.match(body, /navigate their workloads/i);
  assert.match(body, /manage agents on their behalf/i);
  assert.match(body, /private\s+GitHub repository/i);
  assert.match(body, /call.*domain/i);
  assert.match(body, /work and\s+personal life/i);
  assert.match(body, /one focused question at a time/i);
  assert.match(body, /Focus on what I do for the user/i);
  assert.match(body, /existing local checkout/i);
  assert.match(body, /resumable/i);
  assert.match(body, /Do not restart the welcome or\s+questionnaire/i);
  assert.match(body, /pan setup/);
  assert.match(body, /pan verify/);
  assert.match(body, /pan shortcuts create/);
  assert.match(body, /exact `launchCommands`/i);
  assert.match(body, /returned `command`.*verified commands/is);
  assert.doesNotMatch(body, /npx @amoebachant\/pan/);
});

test("shares direct GitHub triage and scheduling instructions", async () => {
  const source = await readFile(INSTRUCTIONS_PATH, "utf8");

  for (const heading of [
    "# PAN domain instructions",
    "## Live GitHub workflow",
    "## Triage and mutations",
    "## Session behavior",
  ]) {
    assert.match(source, new RegExp(`^${escapeRegex(heading)}$`, "m"));
  }
  assert.match(source, /GitHub Issues and the configured\s+Project are the only work state/i);
  assert.match(source, /Use `gh` directly/i);
  assert.match(source, /PAN_PROJECT_SCHEMA/);
  assert.match(source, /Never add a\s+closed Issue/i);
  assert.match(source, /There is no PAN\s+leadership lease or read-only mode/i);
  assert.doesNotMatch(source, /pan evidence|pan action|pan reconcile/i);
});

test("packages direct-GitHub portfolio, workstream, and attention skills", async () => {
  const expected = {
    "pan-attention": ["gh project item-list", "gh issue view", "gh issue create"],
    "pan-portfolio": [
      "gh project item-list",
      "gh issue list",
      "gh issue view",
      "gh project item-edit",
    ],
    "pan-workstream": ["isolated worktree", "merge with `--no-ff`"],
  };

  for (const [name, commands] of Object.entries(expected)) {
    const source = await readFile(path.join(ASSET_ROOT, "skills", name, "SKILL.md"), "utf8");
    const { frontmatter } = parseAgent(source);
    assert.equal(frontmatter.name, name);
    assert.ok(frontmatter.description);
    for (const command of commands) {
      assert.match(source, new RegExp(escapeRegex(command)));
    }
  }
});

test("manifest covers every distributed asset with its content hash", async () => {
  const manifest = JSON.parse(await readFile(MANIFEST_PATH, "utf8"));
  const files = await assetFiles(ASSET_ROOT);
  const distributed = files.filter((file) => file !== "manifest.json").sort();

  assert.equal(manifest.version, 1);
  assert.deepEqual(
    manifest.assets.map((entry) => entry.source).sort(),
    distributed,
  );
  for (const asset of manifest.assets) {
    assert.equal(asset.destination, asset.source);
    assert.match(asset.sha256, /^[a-f0-9]{64}$/);
    const content = await readFile(path.join(ASSET_ROOT, asset.source));
    assert.equal(asset.sha256, createHash("sha256").update(content).digest("hex"));
  }
});

test("hostless assets contain no private identity, repository, or machine paths", async () => {
  const contents = await Promise.all(
    (await assetFiles(ASSET_ROOT))
      .filter((file) => file !== "manifest.json")
      .map((file) => readFile(path.join(ASSET_ROOT, file), "utf8")),
  );
  const source = contents.join("\n");
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

async function assetFiles(directory, relative = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) {
      return assetFiles(path.join(directory, entry.name), child);
    }
    return [child.replaceAll("\\", "/")];
  }));
  return files.flat();
}

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
