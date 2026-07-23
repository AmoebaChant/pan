import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { parsePanArgs } from "../src/index.js";

test("removes host and MCP runtime from the package surface", async () => {
  const packageMetadata = JSON.parse(
    await readFile(path.resolve("package.json"), "utf8"),
  );
  const packageExports = await import("../src/index.js");

  assert.deepEqual(packageMetadata.bin, {
    pan: "./bin/pan.js",
    "pan-runner": "./bin/pan-runner.js",
  });
  for (const name of [
    "PanHost",
    "PanAgentClient",
    "PanDaemon",
    "PanRuntime",
    "PanReviewService",
    "PanRepairService",
    "PanToolRegistry",
    "startPanMcpServer",
    "startPan",
    "connectPan",
  ]) {
    assert.equal(Object.hasOwn(packageExports, name), false, `${name} must not be exported`);
  }
  for (const file of [
    "bin/pan-mcp.js",
    "src/pan-host.js",
    "src/pan-mcp-server.js",
    "src/pan-launcher.js",
    "schema/pan-turn.json",
    "schema/pan-tool-message.json",
  ]) {
    await assert.rejects(access(path.resolve(file)));
  }
});

test("redirects one-shot prompt processing to the hostless session", () => {
  assert.throws(
    () => parsePanArgs(["review", "--json"], {}),
    /pan review is retired.*pan session --config <path>/is,
  );
});
