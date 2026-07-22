import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  WorkstreamDeliveryService,
  createWorkstreamCommandHandlers,
  parsePanHelperArgs,
} from "../src/index.js";
import { ProcessClient } from "../src/process-client.js";

const run = promisify(execFile);
const REPOSITORY = "example/domain";

test("prepares from the freshly fetched remote branch without touching a dirty checkout", async (t) => {
  const fixture = await createDomain(t);
  await writeFile(
    path.join(fixture.seed, "workstreams", "existing", "README.md"),
    "# Existing\n\nRemote advance.\n",
  );
  await git(fixture.seed, ["add", "workstreams/existing/README.md"]);
  await git(fixture.seed, ["commit", "-m", "Remote advance"]);
  await git(fixture.seed, ["push", "origin", "main"]);

  const staged = path.join(fixture.domain, "staged.txt");
  const modified = path.join(fixture.domain, "unrelated.txt");
  const untracked = path.join(fixture.domain, "untracked.txt");
  await writeFile(staged, "staged\n");
  await git(fixture.domain, ["add", "staged.txt"]);
  await writeFile(modified, "modified\n");
  await writeFile(untracked, "untracked\n");
  const before = await Promise.all([readFile(staged), readFile(modified), readFile(untracked)]);

  const result = await createService(fixture).prepare({
    workstream: "existing",
    sessionId: "session-1",
    rationale: "Refresh current status.",
    sourceTurn: "turn-1",
  });

  assert.equal(result.status, "confirmed");
  assert.equal(
    result.receipt.target.baseCommit,
    await git(fixture.domain, ["rev-parse", "origin/main"]),
  );
  assert.match(await readFile(result.receipt.filePath, "utf8"), /Remote advance/);
  assert.equal(
    await git(result.receipt.workspace, ["branch", "--show-current"]),
    "",
  );
  assert.deepEqual(
    await Promise.all([readFile(staged), readFile(modified), readFile(untracked)]),
    before,
  );
  const stored = JSON.parse(
    await readFile(result.receipt.cleanup.receiptPath, "utf8"),
  );
  assert.equal(stored.workstream.expectedBlob, result.receipt.workstream.expectedBlob);
  assert.equal(stored.target.baseCommit, result.receipt.target.baseCommit);
  assert.equal(stored.sessionId, "session-1");
});

test("prepares a missing workstream as the only editable target", async (t) => {
  const fixture = await createDomain(t);

  const result = await createService(fixture).prepare({
    workstream: "new/child",
    sessionId: "session-1",
  });

  assert.equal(result.receipt.workstream.expectedAbsent, true);
  assert.equal(result.receipt.workstream.expectedBlob, null);
  assert.equal(
    result.receipt.filePath,
    path.join(result.receipt.workspace, "workstreams", "new", "child", "README.md"),
  );
  await assert.rejects(readFile(result.receipt.filePath, "utf8"), /ENOENT/);
  await writeFile(result.receipt.filePath, "# New\n");
  assert.equal(await readFile(result.receipt.filePath, "utf8"), "# New\n");
});

test("rejects invalid paths, origin mismatches, and unavailable leadership before creating a workspace", async (t) => {
  const fixture = await createDomain(t);
  const service = createService(fixture);

  await assert.rejects(
    service.prepare({ workstream: "../escape", sessionId: "session-1" }),
    /invalid segment/,
  );
  await assert.rejects(
    new WorkstreamDeliveryService({
      repositoryPath: fixture.domain,
      repository: "other/domain",
      commands: fixture.commands,
      operationDirectory: fixture.operations,
    }).prepare({ workstream: "existing", sessionId: "session-1" }),
    /expected other\/domain/,
  );
  const rejected = await new WorkstreamDeliveryService({
    repositoryPath: fixture.domain,
    repository: REPOSITORY,
    commands: fixture.commands,
    operationDirectory: fixture.operations,
    assertLeadership: async () => ({ asserted: false, reason: "lease lost" }),
  }).prepare({ workstream: "existing", sessionId: "session-1" });
  assert.equal(rejected.status, "rejected");
  assert.match(rejected.diagnostics[0], /lease lost/);
});

test("removes only its operation artifacts when worktree creation fails", async (t) => {
  const fixture = await createDomain(t);
  const base = "a".repeat(40);
  const service = new WorkstreamDeliveryService({
    repositoryPath: fixture.domain,
    repository: REPOSITORY,
    operationDirectory: fixture.operations,
    operationIdFactory: () => "failed-operation",
    commands: {
      async run(_executable, args) {
        if (args.includes("rev-parse") && args.includes("--show-toplevel")) {
          return fixture.domain;
        }
        if (args.includes("get-url")) {
          return "https://github.com/example/domain.git";
        }
        if (args.includes("symbolic-ref")) {
          return "origin/main";
        }
        if (args.includes("fetch")) {
          return "";
        }
        if (args.includes("rev-parse")) {
          return base;
        }
        if (args.includes("ls-tree")) {
          return "";
        }
        if (args.includes("worktree") && args.includes("add")) {
          throw new Error("simulated worktree failure");
        }
        throw new Error(`Unexpected git invocation: ${args.join(" ")}`);
      },
    },
  });

  await assert.rejects(
    service.prepare({ workstream: "new", sessionId: "session-1" }),
    /simulated worktree failure/,
  );
  assert.deepEqual(await readdir(fixture.operations), []);
});

test("parses a strict workstream prepare helper and returns its exact edit path", async () => {
  const handlers = createWorkstreamCommandHandlers({
    env: {
      PAN_SESSION_ID: "session-1",
      PAN_LEADERSHIP_HOLDER: "holder-1",
      PAN_LEADERSHIP_GENERATION: "generation-1",
    },
    serviceFactory: () => ({
      prepare: async (input) => ({
        status: "confirmed",
        receipt: {
          operationId: "operation-1",
          workstream: {
            path: input.workstream,
            expectedBlob: undefined,
            expectedAbsent: true,
          },
          target: { baseCommit: "a".repeat(40), defaultBranch: "main" },
          workspace: "C:\\pan\\operations\\operation-1\\worktree",
          filePath: "C:\\pan\\operations\\operation-1\\worktree\\workstreams\\new\\README.md",
          cleanup: { receiptPath: "C:\\pan\\operations\\operation-1\\receipt.json" },
          expiresAt: "2026-07-22T17:00:00.000Z",
        },
      }),
    }),
  });
  const parsed = parsePanHelperArgs(
    [
      "workstream",
      "prepare",
      "new",
      "--rationale",
      "Add a workstream.",
      "--source-turn",
      "turn-1",
      "--schema-version",
      "1",
      "--config",
      "domain.json",
    ],
    { handlers: { workstream: handlers } },
  );

  assert.deepEqual(parsed.options, {
    workstream: "new",
    rationale: "Add a workstream.",
    "source-turn": "turn-1",
  });
  const result = await handlers.prepare({
    context: commandContext(),
    options: parsed.options,
  });
  assert.equal(result.status, "confirmed");
  assert.equal(
    result.data.filePath,
    "C:\\pan\\operations\\operation-1\\worktree\\workstreams\\new\\README.md",
  );
  assert.equal(result.data.expectedAbsent, true);
});

async function createDomain(t) {
  const root = await mkdtemp(path.join(process.cwd(), "workstream-delivery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const seed = path.join(root, "seed");
  const remote = path.join(root, "remote.git");
  const domain = path.join(root, "domain");
  await git(root, ["init", "--bare", "--initial-branch=main", remote]);
  await git(root, ["init", "-b", "main", seed]);
  await git(seed, ["config", "user.name", "PAN Test"]);
  await git(seed, ["config", "user.email", "pan@example.invalid"]);
  await mkdir(path.join(seed, "workstreams", "existing"), { recursive: true });
  await writeFile(
    path.join(seed, "workstreams", "existing", "README.md"),
    "# Existing\n\nInitial.\n",
  );
  await writeFile(path.join(seed, "unrelated.txt"), "original\n");
  await git(seed, ["add", "."]);
  await git(seed, ["commit", "-m", "Initial workstream"]);
  await git(seed, ["remote", "add", "origin", remote]);
  await git(seed, ["push", "-u", "origin", "main"]);
  await git(root, ["clone", remote, domain]);

  return {
    seed,
    domain,
    operations: path.join(root, "operations"),
    commands: {
      async run(executable, args, options) {
        if (args.at(-2) === "get-url" && args.at(-1) === "origin") {
          return "https://github.com/example/domain.git";
        }
        return new ProcessClient().run(executable, args, options);
      },
    },
  };
}

function createService(fixture) {
  return new WorkstreamDeliveryService({
    repositoryPath: fixture.domain,
    repository: REPOSITORY,
    commands: fixture.commands,
    operationDirectory: fixture.operations,
    operationIdFactory: () => "operation-1",
    now: () => new Date("2026-07-22T16:00:00.000Z"),
  });
}

async function git(cwd, args) {
  const { stdout } = await run("git", args, { cwd, windowsHide: true });
  return stdout.trim();
}

function commandContext() {
  return {
    domain: {
      repository: REPOSITORY,
      projectOwner: "example",
      projectNumber: 1,
      path: "C:\\domain",
    },
    config: {
      state: { branch: "pan-state", leaderPath: ".pan/leader.json" },
      leadership: { leaseSeconds: 120 },
    },
    gh: {},
  };
}
