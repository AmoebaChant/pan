import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";
import test from "node:test";

const execFile = promisify(execFileCallback);

test("ships only hostless runtime assets and public schemas", async () => {
  const packageMetadata = JSON.parse(
    await readFile(path.resolve("package.json"), "utf8"),
  );
  const manifest = JSON.parse(
    await readFile(path.resolve("assets/copilot/manifest.json"), "utf8"),
  );
  const readme = await readFile(path.resolve("README.md"), "utf8");
  const packageExports = await import("../src/index.js");

  assert.deepEqual(packageMetadata.bin, {
    pan: "./bin/pan.js",
    "pan-runner": "./bin/pan-runner.js",
  });
  assert.deepEqual(packageMetadata.files, ["assets", "bin", "src", "schema"]);
  assert.match(packageMetadata.description, /hostless/i);
  assert.match(readme, /npx @amoebachant\/pan onboard/);
  assert.ok(readme.split(/\r?\n/).length < 30, "README should remain approachable");
  assert.equal(packageMetadata.files.includes("docs"), false);
  assert.equal(packageMetadata.files.includes(".github/agents"), false);

  for (const asset of manifest.assets) {
    await access(path.resolve("assets/copilot", asset.source));
  }
  await access(path.resolve("assets/pan.ico"));
  for (const schema of [
    "domain-config.json",
    "pan-action.json",
    "pan-command-result.json",
    "playbook.json",
    "portfolio-snapshot.json",
    "project-fields.json",
    "runner-profile.json",
  ]) {
    await access(path.resolve("schema", schema));
  }

  for (const name of [
    "startPanSession",
    "PanAssetService",
    "createEvidenceCommandHandlers",
    "createActionCommandHandlers",
    "createWorkstreamCommandHandlers",
    "RunnerDaemon",
    "startPanOnboarding",
    "verifyPanSetup",
    "createPanDesktopShortcuts",
  ]) {
    assert.equal(Object.hasOwn(packageExports, name), true, `${name} must be exported`);
  }
  for (const name of [
    "PanHost",
    "PanAgentClient",
    "PanDaemon",
    "PanRuntime",
    "PanReviewService",
    "PanRepairService",
    "PanToolRegistry",
    "startPanMcpServer",
    "connectPan",
  ]) {
    assert.equal(Object.hasOwn(packageExports, name), false, `${name} must not be exported`);
  }
});

test("package archive excludes private and retired surfaces", async () => {
  const command =
    process.platform === "win32"
      ? [process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", "npm pack --dry-run --json"]]
      : ["npm", ["pack", "--dry-run", "--json"]];
  const { stdout } = await execFile(command[0], command[1], { cwd: path.resolve() });
  const [{ files }] = JSON.parse(stdout);
  const paths = files.map(({ path: filePath }) => filePath);

  for (const filePath of paths) {
    assert.match(
      filePath,
      /^(README\.md|package\.json|assets\/|bin\/|schema\/|src\/)/,
      `Unexpected published file: ${filePath}`,
    );
  }
  for (const forbidden of [
    ".github/agents/pan.agent.md",
    "bin/pan-mcp.js",
    "docs/hostless-pan/task-board.md",
    "schema/pan-turn.json",
    "schema/pan-tool-message.json",
    "src/pan-host.js",
    "src/pan-mcp-server.js",
  ]) {
    assert.equal(paths.includes(forbidden), false, `${forbidden} must not be published`);
  }
});
