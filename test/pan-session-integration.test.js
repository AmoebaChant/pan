import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import path from "node:path";
import test from "node:test";

import { startPanSession } from "../src/index.js";

const FAKE_COPILOT = path.resolve("test/fixtures/fake-copilot.js");
const DOMAIN_ROOT = process.cwd();

test("launches an ordinary Copilot child in the configured domain root", async () => {
  const launches = [];
  let assetChecks = 0;
  const result = await startSession({
    assetService: {
      status: async () => {
        assetChecks += 1;
        return { status: "current" };
      },
    },
    env: fakeEnvironment({ exitCode: 17 }),
    spawnProcess: fakeCopilotSpawn(launches),
  });

  assert.equal(result.exitCode, 17);
  assert.equal(result.mode, "writing");
  assert.equal(assetChecks, 1);
  assert.equal(launches[0].executable, "copilot-test");
  assert.equal(launches[0].options.cwd, DOMAIN_ROOT);
  assert.equal(launches[0].options.stdio, "inherit");
  assert.equal(launches[0].options.windowsHide, false);
  assert.ok(!launches[0].args.some((arg) => /mcp/i.test(arg)));
  assert.equal(launches[0].options.env.PAN_LEGACY_HOST, undefined);
  assert.equal(launches[0].options.env.PAN_SESSION_MODE, "writing");
});

test("blocks sessions until stale or conflicting user-scoped assets are repaired", async (t) => {
  for (const status of ["stale", "conflicting"]) {
    await t.test(status, async () => {
      await assert.rejects(
        startSession({
          assetService: { status: async () => ({ status }) },
          domainIdentity: {
            validate: async () => assert.fail("domain validation must not run"),
          },
          spawnProcess: () => assert.fail("Copilot must not launch"),
        }),
        new RegExp(`assets are ${status}`),
      );
    });
  }
});

test("allows exactly one scheduled writer while a concurrent session is read-only", async () => {
  const stateFile = new MemoryStateFile();
  const writerLaunches = [];
  const readerLaunches = [];
  let writerDueStates = 0;
  const writer = startSession({
    stateFile,
    config: scheduledConfig(),
    env: fakeEnvironment({ lifetime: "hold", expectSchedule: true }),
    sessionIdFactory: () => "writer",
    dueStateFactory: async () => {
      writerDueStates += 1;
      return disposableDueState("writer");
    },
    spawnProcess: fakeCopilotSpawn(writerLaunches),
  });
  await waitFor(() => writerLaunches.length === 1);

  let readerDueStates = 0;
  const reader = await startSession({
    stateFile,
    config: scheduledConfig(),
    env: fakeEnvironment(),
    sessionIdFactory: () => "reader",
    dueStateFactory: async () => {
      readerDueStates += 1;
      return disposableDueState("reader");
    },
    spawnProcess: fakeCopilotSpawn(readerLaunches),
  });

  assert.equal(reader.mode, "read-only");
  assert.equal(writerDueStates, 1);
  assert.equal(readerDueStates, 0);
  assert.ok(writerLaunches[0].args.includes("--interactive"));
  assert.ok(!readerLaunches[0].args.includes("--interactive"));
  const schedulingPrompt =
    writerLaunches[0].args[writerLaunches[0].args.indexOf("--interactive") + 1];
  assert.match(schedulingPrompt, /\/every 3600s/);
  assert.match(schedulingPrompt, /nextReviewAt/);
  assert.ok(writerLaunches[0].options.env.PAN_LEADERSHIP_GENERATION);
  assert.equal(readerLaunches[0].options.env.PAN_LEADERSHIP_GENERATION, undefined);

  writerLaunches[0].child.kill("SIGTERM");
  const writerResult = await writer;
  assert.equal(writerResult.mode, "writing");
  assert.ok(Date.parse(stateFile.value.expiresAt) <= Date.now());
});

test("leadership loss kills the writing child before another scheduled action can start", async () => {
  const stateFile = new MemoryStateFile();
  const launches = [];
  let heartbeat;
  let dueDisposed = false;
  const session = startSession({
    stateFile,
    config: scheduledConfig(),
    env: fakeEnvironment({ lifetime: "hold", expectSchedule: true }),
    sessionIdFactory: () => "writer",
    dueStateFactory: async () => ({
      ...disposableDueState("writer"),
      dispose: async () => {
        dueDisposed = true;
      },
    }),
    setIntervalImpl(callback) {
      heartbeat = callback;
      return "heartbeat";
    },
    clearIntervalImpl() {},
    terminateChild: async (child) => {
      child.kill("SIGTERM");
    },
    spawnProcess: fakeCopilotSpawn(launches),
  });
  await waitFor(() => launches.length === 1 && typeof heartbeat === "function");

  stateFile.value = {
    holder: "another-machine/pan-42",
    token: "replacement",
    sessionId: "replacement",
    expiresAt: "2099-01-01T00:00:00.000Z",
  };
  stateFile.version += 1;
  heartbeat();

  const result = await session;
  assert.equal(result.exitCode, 1);
  assert.equal(result.leadership.status, "lost");
  assert.equal(launches.length, 1);
  assert.equal(dueDisposed, true);
  assert.equal(stateFile.value.token, "replacement");
});

test("a termination signal stops a real foreground child and releases its lease", async () => {
  const stateFile = new MemoryStateFile();
  const launches = [];
  const signals = new EventEmitter();
  const session = startSession({
    stateFile,
    env: fakeEnvironment({ lifetime: "hold" }),
    signals,
    terminateChild: async (child) => {
      child.kill("SIGTERM");
    },
    spawnProcess: fakeCopilotSpawn(launches),
  });
  await waitFor(() => launches.length === 1);

  signals.emit("SIGINT", "SIGINT");
  await session;

  assert.equal(launches[0].child.killed, true);
  assert.ok(Date.parse(stateFile.value.expiresAt) <= Date.now());
});

function sessionConfig() {
  return {
    domain: {
      repository: "example/domain",
      projectOwner: "example",
      projectNumber: 12,
      path: DOMAIN_ROOT,
    },
    state: { branch: "pan-state", leaderPath: ".pan/leader.json" },
    leadership: { leaseSeconds: 120, heartbeatSeconds: 30 },
    session: {
      agent: { name: "pan", executable: "copilot-test", model: "gpt-5.6-sol" },
      productContextRoots: [{ label: "product", path: DOMAIN_ROOT }],
    },
  };
}

function scheduledConfig() {
  return {
    ...sessionConfig(),
    scheduling: {
      enabled: true,
      startup: "manual",
      reviewIntervalSeconds: 86_400,
      retrySeconds: 60,
      rateLimitRetrySeconds: 900,
    },
  };
}

function startSession({
  stateFile = new MemoryStateFile(),
  config = sessionConfig(),
  env = fakeEnvironment(),
  sessionIdFactory = () => "session-a",
  ...overrides
} = {}) {
  return startPanSession({
    config,
    configPath: path.join(DOMAIN_ROOT, "pan.json"),
    env,
    assetService: { status: async () => ({ status: "current" }) },
    domainIdentity: {
      validate: async () => ({
        domain: {
          repository: "example/domain",
          path: DOMAIN_ROOT,
          defaultBranch: "main",
        },
        project: { owner: "example", number: 12, id: "PVT_test" },
      }),
    },
    verifyCopilot: async () => {},
    stateFileFactory: () => stateFile,
    sessionIdFactory,
    hostname: "machine-a",
    pid: 1234,
    ...overrides,
  });
}

function fakeEnvironment({ exitCode, expectSchedule = false, lifetime } = {}) {
  return {
    PATH: process.env.PATH,
    FAKE_COPILOT_EXPECTED_CWD: DOMAIN_ROOT,
    FAKE_COPILOT_EXPECTED_AGENT: "pan",
    ...(exitCode === undefined ? {} : { FAKE_COPILOT_EXIT_CODE: String(exitCode) }),
    ...(expectSchedule ? { FAKE_COPILOT_EXPECT_SCHEDULE: "1" } : {}),
    ...(lifetime ? { FAKE_COPILOT_LIFETIME: lifetime } : {}),
    PAN_LEGACY_HOST: "must-not-reach-child",
  };
}

function fakeCopilotSpawn(launches) {
  return (executable, args, options) => {
    const child = spawn(process.execPath, [FAKE_COPILOT, ...args], options);
    launches.push({ executable, args, options, child });
    return child;
  };
}

function disposableDueState(sessionId) {
  return {
    path: path.join(DOMAIN_ROOT, `${sessionId}.due.json`),
    dispose: async () => {},
  };
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("timed out waiting for foreground Copilot child");
}

class MemoryStateFile {
  value = undefined;
  version = 0;

  async read() {
    return {
      value: this.value ? structuredClone(this.value) : undefined,
      version: this.version || undefined,
    };
  }

  async write(value, expectedVersion) {
    if ((this.version || undefined) !== expectedVersion) {
      return undefined;
    }
    this.version += 1;
    this.value = structuredClone(value);
    return this.version;
  }
}
