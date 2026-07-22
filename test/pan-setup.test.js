import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { setupPanDomain } from "../src/index.js";

test("creates and bootstraps a private PAN domain with safe approvals", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pan-setup-"));
  const directory = path.join(root, "domain");
  const gh = new FakeGh();
  const commands = new FakeCommands();

  try {
    const result = await setupPanDomain(
      {
        repository: "example/domain",
        path: directory,
        projectOwner: "example",
        projectTitle: "Personal PAN",
        approvalMode: "prompt",
      },
      {
        gh,
        commands,
        hostname: "Machine A",
        env: { LOCALAPPDATA: path.join(root, "local") },
        now: () => new Date("2026-07-21T00:00:00.000Z"),
        ask: assert.fail,
      },
    );

    assert.ok(
      gh.calls.some(
        (args) =>
          args[0] === "repo" &&
          args[1] === "create" &&
          args.includes("--private"),
      ),
    );
    assert.ok(
      gh.calls.some(
        (args) =>
          args[0] === "project" &&
          args[1] === "field-delete" &&
          args.includes("status-id"),
      ),
    );
    assert.equal(
      gh.calls.filter(
        (args) => args[0] === "project" && args[1] === "field-create",
      ).length,
      8,
    );

    const config = JSON.parse(await readFile(result.configPath, "utf8"));
    assert.equal(config.domain.path, path.resolve(directory));
    assert.equal(config.domain.projectNumber, 7);

    const runner = JSON.parse(
      await readFile(result.runnerProfilePath, "utf8"),
    );
    assert.equal(runner.online, false);
    assert.deepEqual(runner.repositories, {});
    assert.equal(runner.copilot.approvalMode, "prompt");
    assert.equal(runner.store.path, path.resolve(directory));

    const workstream = await readFile(
      path.join(
        directory,
        "workstreams",
        "getting-started",
        "README.md",
      ),
      "utf8",
    );
    assert.match(workstream, /state: Active/);
    assert.match(workstream, /updated: 2026-07-21/);
    assert.deepEqual(
      commands.calls.map(({ executable, args }) => [executable, args[2]]),
      [
        ["git", "add"],
        ["git", "commit"],
        ["git", "push"],
      ],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refuses to overwrite an existing local path before remote mutation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pan-setup-existing-"));
  const gh = new FakeGh();
  try {
    await assert.rejects(
      setupPanDomain(
        {
          repository: "example/domain",
          path: root,
          projectOwner: "example",
          projectTitle: "PAN",
          approvalMode: "prompt",
        },
        {
          gh,
          commands: new FakeCommands(),
          hostname: "machine",
          ask: assert.fail,
        },
      ),
      /Local clone path already exists/,
    );
    assert.deepEqual(gh.calls, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

class FakeGh {
  constructor() {
    this.calls = [];
  }

  async run(args) {
    this.calls.push(args);
    if (args[0] === "repo" && args[1] === "clone") {
      await mkdir(args[3], { recursive: true });
    }
    return "";
  }

  async runJson(args) {
    this.calls.push(args);
    if (args[0] === "project" && args[1] === "create") {
      return {
        number: 7,
        url: "https://github.com/users/example/projects/7",
      };
    }
    if (args[0] === "project" && args[1] === "field-list") {
      return { fields: [{ id: "status-id", name: "Status" }] };
    }
    assert.fail(`Unexpected gh JSON call: ${args.join(" ")}`);
  }
}

class FakeCommands {
  constructor() {
    this.calls = [];
  }

  async run(executable, args) {
    this.calls.push({ executable, args });
    return "";
  }
}
