import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  resolveNewConfinedWorkstreamReadme,
  resolveConfinedWorkstreamReadme,
  WorkstreamStore,
} from "../src/index.js";

const run = promisify(execFile);

test("enumerates hierarchy from folders and reads revision metadata", async (t) => {
  const repositoryPath = await createRepository(t);
  const store = new WorkstreamStore({ repositoryPath });

  const listed = await store.list();
  const child = await store.read("parent/child");

  assert.equal(listed.complete, true);
  assert.match(listed.revision, /^[0-9a-f]{40}$/);
  assert.deepEqual(
    listed.workstreams.map((entry) => ({
      path: entry.path,
      parent: entry.parent,
      children: entry.children,
    })),
    [
      { path: "parent", parent: undefined, children: ["parent/child"] },
      { path: "parent/child", parent: "parent", children: [] },
      { path: "solo", parent: undefined, children: [] },
    ],
  );
  assert.equal(child.sourcePath, "workstreams/parent/child/README.md");
  assert.match(child.contentHash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(child.revision, listed.revision);
  assert.ok(Number.isFinite(Date.parse(child.modifiedAt)));
});

test("rejects missing workstreams and symlink escapes after realpath", async (t) => {
  const repositoryPath = await createRepository(t);
  const outside = path.join(repositoryPath, "outside");
  await mkdir(outside);
  await writeFile(path.join(outside, "README.md"), "# Outside\n");
  await symlink(
    outside,
    path.join(repositoryPath, "workstreams", "escape"),
    process.platform === "win32" ? "junction" : "dir",
  );

  await assert.rejects(
    resolveConfinedWorkstreamReadme(repositoryPath, "escape"),
    /escapes the configured repository root/,
  );
  await assert.rejects(
    new WorkstreamStore({ repositoryPath }).read("missing"),
    /Unable to read workstream missing/,
  );
});

test("validates new workstream targets without allowing existing symlink escapes", async (t) => {
  const repositoryPath = await createRepository(t);
  const newReadme = await resolveNewConfinedWorkstreamReadme(
    repositoryPath,
    "new/child",
  );

  assert.equal(
    newReadme,
    path.join(repositoryPath, "workstreams", "new", "child", "README.md"),
  );
  await mkdir(path.join(repositoryPath, "outside"));
  await symlink(
    path.join(repositoryPath, "outside"),
    path.join(repositoryPath, "workstreams", "new"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(
    resolveNewConfinedWorkstreamReadme(repositoryPath, "new/child"),
    /escapes the configured repository root/,
  );
});

test("reports malformed hierarchy without pretending enumeration is complete", async (t) => {
  const repositoryPath = await createRepository(t);
  await mkdir(
    path.join(repositoryPath, "workstreams", "orphan", "child"),
    { recursive: true },
  );
  await writeFile(
    path.join(
      repositoryPath,
      "workstreams",
      "orphan",
      "child",
      "README.md",
    ),
    "# Child without parent README\n",
  );

  const listed = await new WorkstreamStore({ repositoryPath }).list();

  assert.equal(listed.complete, false);
  assert.ok(
    listed.errors.some(
      (error) =>
        error.path === "orphan" && /has no README\.md/.test(error.reason),
    ),
  );
  assert.ok(
    listed.workstreams.some(
      (entry) =>
        entry.path === "orphan/child" && entry.parent === "orphan",
    ),
  );
});

test("performs bounded literal and regex narrative searches", async (t) => {
  const repositoryPath = await createRepository(t);
  const store = new WorkstreamStore({ repositoryPath, searchLimit: 10 });

  const literal = await store.search("commitment due");
  const regex = await store.search("owner:\\s+agent", { regex: true });
  const limited = await store.search("#", { limit: 1 });

  assert.equal(literal.complete, true);
  assert.deepEqual(
    literal.matches.map((match) => [
      match.path,
      match.startLine,
      match.endLine,
      match.text,
    ]),
    [["parent/child", 3, 3, "Commitment due Friday."]],
  );
  assert.equal(regex.matches[0].path, "parent/child");
  assert.equal(regex.matches[0].startLine, 4);
  assert.equal(limited.limited, true);
  assert.equal(limited.complete, false);
});

test("returns bounded recent git history for one workstream", async (t) => {
  const repositoryPath = await createRepository(t);
  const store = new WorkstreamStore({ repositoryPath });

  const history = await store.history("parent/child", { limit: 2 });

  assert.deepEqual(
    history.map((entry) => entry.subject),
    ["Update child workstream", "Add workstreams"],
  );
  for (const entry of history) {
    assert.match(entry.sha, /^[0-9a-f]{40}$/);
    assert.ok(Number.isFinite(Date.parse(entry.committedAt)));
    assert.equal(
      entry.changedPath,
      "workstreams/parent/child/README.md",
    );
  }
});

async function createRepository(t) {
  const repositoryPath = await mkdtemp(
    path.join(os.tmpdir(), "pan-workstream-store-"),
  );
  t.after(() => rm(repositoryPath, { recursive: true, force: true }));
  await mkdir(
    path.join(repositoryPath, "workstreams", "parent", "child"),
    { recursive: true },
  );
  await mkdir(path.join(repositoryPath, "workstreams", "solo"));
  await writeFile(
    path.join(repositoryPath, "workstreams", "parent", "README.md"),
    "# Parent\n",
  );
  await writeFile(
    path.join(
      repositoryPath,
      "workstreams",
      "parent",
      "child",
      "README.md",
    ),
    "# Child\n\nCommitment due Friday.\n",
  );
  await writeFile(
    path.join(repositoryPath, "workstreams", "solo", "README.md"),
    "# Solo\n",
  );

  await git(repositoryPath, ["init", "-b", "main"]);
  await git(repositoryPath, ["config", "user.name", "PAN Test"]);
  await git(repositoryPath, ["config", "user.email", "pan@example.invalid"]);
  await git(repositoryPath, ["add", "workstreams"]);
  await git(repositoryPath, ["commit", "-m", "Add workstreams"]);
  await writeFile(
    path.join(
      repositoryPath,
      "workstreams",
      "parent",
      "child",
      "README.md",
    ),
    "# Child\n\nCommitment due Friday.\nOwner: agent\n",
  );
  await git(repositoryPath, [
    "add",
    "workstreams/parent/child/README.md",
  ]);
  await git(repositoryPath, ["commit", "-m", "Update child workstream"]);
  return repositoryPath;
}

async function git(repositoryPath, args) {
  await run("git", args, {
    cwd: repositoryPath,
    windowsHide: true,
  });
}
