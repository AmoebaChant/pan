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

test("publishes one attributable workstream commit directly to the default branch", async (t) => {
  const fixture = await createDomain(t);
  const service = createService(fixture);
  const prepared = await service.prepare({
    workstream: "existing",
    sessionId: "session-1",
    rationale: "Record the durable delivery outcome.",
    sourceTurn: "turn-1",
  });
  await writeFile(prepared.receipt.filePath, "# Existing\n\nPublished.\n");

  const published = await service.publish({
    operationId: prepared.receipt.operationId,
    sessionId: "session-1",
  });

  assert.equal(published.status, "confirmed", JSON.stringify(published));
  assert.equal(published.commitCreated.sha, published.pushConfirmed.sha);
  assert.equal(
    await git(fixture.domain, ["show", "origin/main:workstreams/existing/README.md"]),
    "# Existing\n\nPublished.",
  );
  const message = await git(fixture.domain, [
    "show",
    "-s",
    "--format=%B",
    published.pushConfirmed.sha,
  ]);
  assert.match(message, /PAN-Workstream-Operation: operation-1/);
  assert.match(message, /PAN-Workstream-Source-Turn: turn-1/);
  assert.match(message, /PAN-Workstream-Idempotency: pan-workstream:/);
  await assert.rejects(readFile(prepared.receipt.filePath), /ENOENT/);

  const retried = await service.publish({
    operationId: prepared.receipt.operationId,
    sessionId: "session-1",
  });
  assert.equal(retried.status, "confirmed");
  assert.equal(retried.commitCreated.sha, published.commitCreated.sha);
  assert.match(retried.diagnostics[0], /already published/i);
});

test("confirms a no-op prepared workspace without creating a commit", async (t) => {
  const fixture = await createDomain(t);
  const service = createService(fixture);
  const prepared = await service.prepare({
    workstream: "existing",
    sessionId: "session-1",
  });

  const result = await service.publish({
    operationId: prepared.receipt.operationId,
    sessionId: "session-1",
  });

  assert.equal(result.status, "confirmed");
  assert.equal(result.noChange, true);
  assert.equal(result.commitCreated, undefined);
  await assert.rejects(readFile(prepared.receipt.filePath), /ENOENT/);
});

test("rejects unrelated workspace changes and remote advances before commit", async (t) => {
  const fixture = await createDomain(t);
  const service = createService(fixture);
  const prepared = await service.prepare({
    workstream: "existing",
    sessionId: "session-1",
  });
  await writeFile(prepared.receipt.filePath, "# Existing\n\nChanged.\n");
  await writeFile(path.join(prepared.receipt.workspace, "unrelated.txt"), "changed\n");

  const unrelated = await service.publish({
    operationId: prepared.receipt.operationId,
    sessionId: "session-1",
  });
  assert.equal(unrelated.status, "rejected");
  assert.match(unrelated.diagnostics[0], /outside the intended/i);

  await rm(path.join(prepared.receipt.workspace, "unrelated.txt"));
  await writeFile(
    path.join(fixture.seed, "workstreams", "existing", "README.md"),
    "# Existing\n\nConcurrent update.\n",
  );
  await git(fixture.seed, ["add", "workstreams/existing/README.md"]);
  await git(fixture.seed, ["commit", "-m", "Concurrent workstream update"]);
  await git(fixture.seed, ["push", "origin", "main"]);

  const advanced = await service.publish({
    operationId: prepared.receipt.operationId,
    sessionId: "session-1",
  });
  assert.equal(advanced.status, "rejected");
  assert.match(advanced.diagnostics[0], /advanced/i);
});

test("retains a local commit when leadership is lost before push", async (t) => {
  const fixture = await createDomain(t);
  const prepared = await createService(fixture).prepare({
    workstream: "existing",
    sessionId: "session-1",
  });
  await writeFile(prepared.receipt.filePath, "# Existing\n\nLocal commit only.\n");
  let assertions = 0;
  const service = new WorkstreamDeliveryService({
    repositoryPath: fixture.domain,
    repository: REPOSITORY,
    commands: fixture.commands,
    operationDirectory: fixture.operations,
    now: () => new Date("2026-07-22T16:00:00.000Z"),
    assertLeadership: async () => ({
      asserted: ++assertions < 3,
      reason: "leadership replaced",
    }),
  });

  const result = await service.publish({
    operationId: prepared.receipt.operationId,
    sessionId: "session-1",
  });

  assert.equal(result.status, "incomplete");
  assert.match(result.diagnostics[0], /leadership/i);
  assert.match(result.commitCreated.sha, /^[0-9a-f]{40}$/);
  assert.equal(
    await git(fixture.domain, ["rev-parse", "origin/main"]),
    prepared.receipt.target.baseCommit,
  );
  assert.equal(
    await git(prepared.receipt.workspace, ["rev-parse", "HEAD"]),
    result.commitCreated.sha,
  );

  const retried = await createService(fixture).publish({
    operationId: prepared.receipt.operationId,
    sessionId: "session-1",
  });
  assert.equal(retried.status, "confirmed");
  assert.equal(retried.pushConfirmed.sha, result.commitCreated.sha);
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

test("parses and dispatches a workstream publish helper", async () => {
  const calls = [];
  const handlers = createWorkstreamCommandHandlers({
    env: {
      PAN_SESSION_ID: "session-1",
      PAN_LEADERSHIP_HOLDER: "holder-1",
      PAN_LEADERSHIP_GENERATION: "generation-1",
    },
    serviceFactory: () => ({
      publish: async (input) => {
        calls.push(input);
        return {
          status: "confirmed",
          commitCreated: { sha: "a".repeat(40), branch: "main" },
          pushConfirmed: { sha: "a".repeat(40), branch: "main" },
          cleanup: { completed: true },
          diagnostics: [],
        };
      },
    }),
  });
  const parsed = parsePanHelperArgs(
    [
      "workstream",
      "publish",
      "operation-1",
      "--schema-version",
      "1",
      "--config",
      "domain.json",
    ],
    { handlers: { workstream: handlers } },
  );

  assert.deepEqual(parsed.options, { "operation-id": "operation-1" });
  const result = await handlers.publish({
    context: commandContext(),
    options: parsed.options,
  });
  assert.equal(result.status, "confirmed");
  assert.deepEqual(calls, [{ operationId: "operation-1", sessionId: "session-1" }]);
  assert.match(result.confirmedEffects.join(" "), /Confirmed workstream commit/);
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
  await git(domain, ["config", "user.name", "PAN Test"]);
  await git(domain, ["config", "user.email", "pan@example.invalid"]);

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
