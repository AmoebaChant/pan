import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  normalizeGitHubRepositoryUrl,
  resolveWorkstreamReadme,
} from "../src/local-task-executor.js";

test("confines workstream README paths to the data repository", () => {
  const store = path.resolve("private-data");

  assert.equal(
    resolveWorkstreamReadme(store, "parent/child"),
    path.join(store, "workstreams", "parent", "child", "README.md"),
  );
  assert.throws(
    () => resolveWorkstreamReadme(store, "../../outside"),
    /invalid segment/,
  );
  assert.throws(
    () => resolveWorkstreamReadme(store, "parent\\outside"),
    /using \/ separators/,
  );
});

test("normalizes supported GitHub remote URL formats", () => {
  assert.equal(
    normalizeGitHubRepositoryUrl("https://github.com/example/tool.git"),
    "example/tool",
  );
  assert.equal(
    normalizeGitHubRepositoryUrl("git@github.com:example/tool.git"),
    "example/tool",
  );
  assert.equal(
    normalizeGitHubRepositoryUrl("ssh://git@github.com/example/tool.git"),
    "example/tool",
  );
  assert.equal(
    normalizeGitHubRepositoryUrl("https://example.com/example/tool.git"),
    undefined,
  );
});
