import assert from "node:assert/strict";
import test from "node:test";

import { GitHubWorkstreamStore } from "../src/index.js";

test("lists and reads repository workstreams through GitHub APIs", async () => {
  const gh = fakeGh();
  const store = new GitHubWorkstreamStore({
    repository: "example/domain",
    gh,
  });

  const listed = await store.list();
  const child = await store.read("parent/child");

  assert.deepEqual(
    listed.workstreams.map(({ path, parent, children }) => ({
      path,
      parent,
      children,
    })),
    [
      { path: "parent", parent: undefined, children: ["parent/child"] },
      { path: "parent/child", parent: "parent", children: [] },
    ],
  );
  assert.equal(child.content, "# Child\n");
  assert.equal(child.sourcePath, "workstreams/parent/child/README.md");
  assert.match(child.url, /blob\/main\/workstreams\/parent\/child\/README\.md$/);
});

test("writes a workstream with optimistic GitHub Contents API concurrency", async () => {
  const gh = fakeGh();
  const store = new GitHubWorkstreamStore({
    repository: "example/domain",
    gh,
  });

  const written = await store.write("parent/child", "# Updated\n", {
    message: "parent/child: update state",
    expectedSha: "child-sha",
  });

  assert.equal(written.content, "# Updated\n");
  const write = gh.calls.find((args) => args.includes("PUT"));
  assert.ok(write.includes("sha=child-sha"));
  assert.ok(write.includes("branch=main"));
});

test("rejects URL and traversal workstream references", async () => {
  const store = new GitHubWorkstreamStore({
    repository: "example/domain",
    gh: fakeGh(),
  });

  await assert.rejects(
    store.read("https://github.com/example/domain/issues/1"),
    /canonical relative path/,
  );
  await assert.rejects(
    store.read("../escape"),
    /canonical relative path|invalid segment/,
  );
});

function fakeGh() {
  const files = new Map([
    ["workstreams/parent/README.md", "# Parent\n"],
    ["workstreams/parent/child/README.md", "# Child\n"],
  ]);
  return {
    calls: [],
    async runJson(args) {
      this.calls.push(args);
      const endpoint = args.find((arg) => arg.startsWith("repos/"));
      if (endpoint === "repos/example/domain") {
        return { default_branch: "main" };
      }
      if (endpoint?.includes("/git/trees/")) {
        return {
          sha: "tree-sha",
          truncated: false,
          tree: [...files.keys()].map((path) => ({
            path,
            type: "blob",
            sha: path.includes("child") ? "child-sha" : "parent-sha",
          })),
        };
      }
      const contentsPrefix = "repos/example/domain/contents/";
      if (endpoint?.startsWith(contentsPrefix)) {
        const path = endpoint.slice(contentsPrefix.length);
        if (args.includes("PUT")) {
          files.set(
            path,
            Buffer.from(valueAfterPrefix(args, "content="), "base64").toString(
              "utf8",
            ),
          );
          return { content: { sha: "updated-sha" } };
        }
        const content = files.get(path);
        return {
          type: "file",
          sha: path.includes("child") ? "child-sha" : "parent-sha",
          content: Buffer.from(content).toString("base64"),
          html_url: `https://github.com/example/domain/blob/main/${path}`,
        };
      }
      throw new Error(`Unexpected gh call: ${args.join(" ")}`);
    },
  };
}

function valueAfterPrefix(args, prefix) {
  return args.find((arg) => arg.startsWith(prefix)).slice(prefix.length);
}
