import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  WorkstreamDeliveryService,
  createWorkstreamCommandHandlers,
  parsePanHelperArgs,
} from "../src/index.js";

test("removes only its operation artifacts when worktree creation fails", async (t) => {
  const root = await mkdtemp(path.join(process.cwd(), "workstream-delivery-unit-"));
  const domain = path.join(root, "domain");
  const operations = path.join(root, "operations");
  await mkdir(domain);
  t.after(() => rm(root, { recursive: true, force: true }));
  const base = "a".repeat(40);
  const service = new WorkstreamDeliveryService({
    repositoryPath: domain,
    repository: "example/domain",
    operationDirectory: operations,
    operationIdFactory: () => "failed-operation",
    commands: {
      async run(_executable, args) {
        if (args.includes("rev-parse") && args.includes("--show-toplevel")) {
          return domain;
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
  assert.deepEqual(await readdir(operations), []);
});

test("rejects invalid paths, origin mismatches, and unavailable leadership before workspace creation", async (t) => {
  const testRoot = await mkdtemp(path.join(process.cwd(), "workstream-delivery-unit-"));
  const root = path.join(testRoot, "domain");
  const operations = path.join(testRoot, "operations");
  await mkdir(root);
  t.after(() => rm(testRoot, { recursive: true, force: true }));
  const commands = {
    async run(_executable, args) {
      if (args.includes("rev-parse") && args.includes("--show-toplevel")) {
        return root;
      }
      if (args.includes("get-url")) {
        return "https://github.com/example/domain.git";
      }
      throw new Error(`Unexpected git invocation: ${args.join(" ")}`);
    },
  };
  const service = new WorkstreamDeliveryService({
    repositoryPath: root,
    repository: "example/domain",
    commands,
    operationDirectory: operations,
  });

  await assert.rejects(
    service.prepare({ workstream: "../escape", sessionId: "session-1" }),
    /invalid segment/,
  );
  await assert.rejects(
    new WorkstreamDeliveryService({
      repositoryPath: root,
      repository: "other/domain",
      commands,
      operationDirectory: operations,
    }).prepare({ workstream: "existing", sessionId: "session-1" }),
    /expected other\/domain/,
  );
  const rejected = await new WorkstreamDeliveryService({
    repositoryPath: root,
    repository: "example/domain",
    commands,
    operationDirectory: operations,
    assertLeadership: async () => ({ asserted: false, reason: "lease lost" }),
  }).prepare({ workstream: "existing", sessionId: "session-1" });
  assert.equal(rejected.status, "rejected");
  assert.match(rejected.diagnostics[0], /lease lost/);
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

function commandContext() {
  return {
    domain: {
      repository: "example/domain",
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
