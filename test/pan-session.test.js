import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  buildSessionCopilotArgs,
  startPanSession,
  verifyCopilotContract,
} from "../src/index.js";

test("launches a writing session with bounded leadership authority", async () => {
  const launches = [];
  const config = sessionConfig();
  const stateFile = new MemoryStateFile();
  const result = await startPanSession({
    config,
    configPath: "C:\\domains\\example\\pan.json",
    env: {
      PATH: "test-path",
      PAN_HOST_TOKEN: "must-not-reach-child",
      PAN_RUNTIME_STATE: "must-not-reach-child",
    },
    stateFileFactory: () => stateFile,
    sessionIdFactory: () => "session-a",
    hostname: "machine-a",
    pid: 1234,
    assetService: { status: async () => ({ status: "current" }) },
    domainIdentity: {
      validate: async () => ({
        domain: {
          repository: "example/domain",
          path: "C:\\domains\\example",
          defaultBranch: "main",
        },
        project: { owner: "example", number: 12, id: "PVT_test" },
      }),
    },
    verifyCopilot: async ({ executable }) => assert.equal(executable, "copilot-test"),
    executable: "copilot-test",
    spawnProcess(executable, args, options) {
      launches.push({ executable, args, options });
      const child = new EventEmitter();
      process.nextTick(() => child.emit("close", 17, null));
      return child;
    },
  });

  assert.equal(result.exitCode, 17);
  assert.equal(result.mode, "writing");
  assert.equal(launches[0].executable, "copilot-test");
  assert.equal(launches[0].options.cwd, "C:\\domains\\example");
  assert.equal(launches[0].options.stdio, "inherit");
  assert.equal(launches[0].options.windowsHide, false);
  assert.deepEqual(launches[0].args, [
    "--agent",
    "pan",
    "--no-auto-update",
    "--model",
    "gpt-5.6-sol",
    "--add-dir",
    "C:\\product-reference",
  ]);
  assert.equal(launches[0].options.env.PAN_HOST_TOKEN, undefined);
  assert.equal(launches[0].options.env.PAN_RUNTIME_STATE, undefined);
  assert.equal(launches[0].options.env.PAN_SESSION_MODE, "writing");
  assert.equal(launches[0].options.env.PAN_SESSION_ID, "session-a");
  assert.equal(launches[0].options.env.PAN_LEADERSHIP_HOLDER, "machine-a/pan-1234");
  assert.ok(launches[0].options.env.PAN_LEADERSHIP_GENERATION);
  assert.equal(
    launches[0].options.env.PAN_DOMAIN_CONFIG,
    "C:\\domains\\example\\pan.json",
  );
  assert.equal(launches[0].options.env.PAN_DOMAIN_REPOSITORY, "example/domain");
  assert.deepEqual(
    JSON.parse(launches[0].options.env.PAN_PRODUCT_CONTEXT_ROOTS),
    [{ label: "product", path: "C:\\product-reference" }],
  );
  assert.ok(!launches[0].args.some((arg) => arg.includes("mcp")));
  assert.equal(stateFile.value.holder, "machine-a/pan-1234");
  assert.ok(Date.parse(stateFile.value.expiresAt) <= Date.now());
});

test("runs a contending session read-only without mutation authority", async () => {
  const stateFile = new MemoryStateFile();
  const firstChild = new EventEmitter();
  const writer = startSession({
    stateFile,
    sessionIdFactory: () => "writer",
    pid: process.pid,
    spawnProcess: () => firstChild,
  });
  await new Promise((resolve) => setImmediate(resolve));

  let readOnlyLaunch;
  const readOnly = await startSession({
    stateFile,
    sessionIdFactory: () => "reader",
    pid: process.pid,
    spawnProcess: (_executable, _args, options) => {
      readOnlyLaunch = options;
      const child = new EventEmitter();
      process.nextTick(() => child.emit("close", 0, null));
      return child;
    },
  });

  assert.equal(readOnly.mode, "read-only");
  assert.equal(readOnlyLaunch.env.PAN_SESSION_MODE, "read-only");
  assert.equal(readOnlyLaunch.env.PAN_SESSION_ID, "reader");
  assert.equal(readOnlyLaunch.env.PAN_LEADERSHIP_HOLDER, undefined);
  assert.equal(readOnlyLaunch.env.PAN_LEADERSHIP_GENERATION, undefined);
  firstChild.emit("close", 0, null);
  await writer;
});

test("bootstraps one native schedule only for a writing session", async () => {
  const stateFile = new MemoryStateFile();
  let launch;
  let contract;
  let disposed = false;
  const result = await startSession({
    stateFile,
    config: scheduledSessionConfig(),
    verifyCopilot: async (options) => {
      contract = options;
    },
    dueStateFactory: async () => ({
      path: "C:\\runtime\\writer.due.json",
      dispose: async () => {
        disposed = true;
      },
    }),
    spawnProcess: (_executable, args, options) => {
      launch = { args, options };
      const child = new EventEmitter();
      process.nextTick(() => child.emit("close", 0, null));
      return child;
    },
  });

  assert.equal(result.mode, "writing");
  assert.equal(contract.requireScheduling, true);
  assert.equal(
    launch.options.env.PAN_SCHEDULE_DUE_STATE,
    "C:\\runtime\\writer.due.json",
  );
  assert.equal(launch.options.env.PAN_SCHEDULE_INTERVAL_SECONDS, "3600");
  assert.match(
    launch.args[launch.args.indexOf("--interactive") + 1],
    /\/every 3600s/,
  );
  assert.equal(disposed, true);
});

test("does not bootstrap a schedule for a read-only session", async () => {
  const stateFile = new MemoryStateFile();
  stateFile.value = {
    holder: "another-machine/pan-1",
    token: "another-session",
    sessionId: "another-session",
    expiresAt: "2099-01-01T00:00:00.000Z",
  };
  stateFile.version = 1;
  let contract;
  await startSession({
    stateFile,
    config: scheduledSessionConfig(),
    verifyCopilot: async (options) => {
      contract = options;
    },
    dueStateFactory: async () => assert.fail("read-only session must not create due state"),
    spawnProcess: (_executable, args, options) => {
      assert.ok(!args.includes("--interactive"));
      assert.equal(options.env.PAN_SCHEDULE_DUE_STATE, undefined);
      const child = new EventEmitter();
      process.nextTick(() => child.emit("close", 0, null));
      return child;
    },
  });

  assert.equal(contract.requireScheduling, false);
});

test("stops the writing child when its leadership generation is replaced", async () => {
  const stateFile = new MemoryStateFile();
  let heartbeat;
  let terminated;
  const child = new EventEmitter();
  const session = startSession({
    stateFile,
    sessionIdFactory: () => "writer",
    spawnProcess: () => child,
    setIntervalImpl(callback) {
      heartbeat = callback;
      return "heartbeat";
    },
    clearIntervalImpl() {},
    terminateChild: async (knownChild) => {
      terminated = knownChild;
      knownChild.emit("close", 1, null);
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  stateFile.value = {
    holder: "machine-b/pan-2000",
    token: "replacement",
    sessionId: "replacement",
    expiresAt: "2099-01-01T00:00:00.000Z",
  };
  stateFile.version += 1;

  heartbeat();
  const result = await session;

  assert.equal(terminated, child);
  assert.equal(result.mode, "writing");
  assert.equal(result.exitCode, 1);
  assert.equal(result.leadership.status, "lost");
  assert.match(result.leadership.diagnostic, /leadership lost/i);
  assert.equal(stateFile.value.token, "replacement");
});

test("stops the writing child when its heartbeat cannot be verified", async () => {
  const stateFile = new MemoryStateFile();
  const read = stateFile.read.bind(stateFile);
  let reads = 0;
  stateFile.read = async () => {
    reads += 1;
    if (reads === 3) {
      throw new Error("GitHub is unavailable");
    }
    return read();
  };
  let heartbeat;
  const child = new EventEmitter();
  const session = startSession({
    stateFile,
    spawnProcess: () => child,
    setIntervalImpl(callback) {
      heartbeat = callback;
      return "heartbeat";
    },
    clearIntervalImpl() {},
    terminateChild: async (knownChild) => knownChild.emit("close", 1, null),
  });
  await new Promise((resolve) => setImmediate(resolve));

  heartbeat();
  const result = await session;

  assert.equal(result.leadership.status, "lost");
  assert.match(result.leadership.diagnostic, /GitHub is unavailable/);
});

test("releases writing leadership when child launch fails", async () => {
  const stateFile = new MemoryStateFile();

  await assert.rejects(
    startSession({
      stateFile,
      spawnProcess: () => {
        throw new Error("launch failed");
      },
    }),
    /launch failed/,
  );

  assert.ok(Date.parse(stateFile.value.expiresAt) <= Date.now());
});

test("stops and releases a writing session on termination", async () => {
  const stateFile = new MemoryStateFile();
  const signals = new EventEmitter();
  const child = new EventEmitter();
  let terminated;
  const session = startSession({
    stateFile,
    signals,
    spawnProcess: () => child,
    terminateChild: async (knownChild) => {
      terminated = knownChild;
      knownChild.emit("close", null, "SIGINT");
    },
  });
  await new Promise((resolve) => setImmediate(resolve));

  signals.emit("SIGINT", "SIGINT");
  const result = await session;

  assert.equal(terminated, child);
  assert.equal(result.signal, "SIGINT");
  assert.ok(Date.parse(stateFile.value.expiresAt) <= Date.now());
});

test("refuses to launch while user-scoped PAN assets need repair", async () => {
  await assert.rejects(
    startPanSession({
      config: sessionConfig(),
      configPath: "C:\\domains\\example\\pan.json",
      assetService: { status: async () => ({ status: "stale" }) },
      domainIdentity: { validate: async () => assert.fail("identity must not run") },
      spawnProcess: () => assert.fail("Copilot must not launch"),
    }),
    /assets are stale/,
  );
});

test("requires the supported ordinary Copilot session contract", async () => {
  await assert.rejects(
    verifyCopilotContract({
      executable: "copilot-test",
      commands: { run: async () => "--agent --model" },
    }),
    /--add-dir/,
  );
});

test("does not add product context when none is configured", () => {
  const config = sessionConfig();
  config.session.productContextRoots = [];
  assert.deepEqual(buildSessionCopilotArgs({ config }), [
    "--agent",
    "pan",
    "--no-auto-update",
    "--model",
    "gpt-5.6-sol",
  ]);
});

function sessionConfig() {
  return {
    domain: {
      repository: "example/domain",
      projectOwner: "example",
      projectNumber: 12,
      path: "C:\\domains\\example",
    },
    state: { branch: "pan-state", path: ".pan", leaderPath: ".pan/leader.json" },
    leadership: { leaseSeconds: 120, heartbeatSeconds: 30 },
    session: {
      agent: { name: "pan", executable: "copilot-test", model: "gpt-5.6-sol" },
      productContextRoots: [
        { label: "product", path: "C:\\product-reference" },
      ],
    },
  };
}

function scheduledSessionConfig() {
  return {
    ...sessionConfig(),
    scheduling: {
      enabled: true,
      startup: "immediate",
      reviewIntervalSeconds: 86_400,
      retrySeconds: 60,
      rateLimitRetrySeconds: 900,
    },
  };
}

function startSession({
  stateFile,
  sessionIdFactory = () => "session-a",
  pid = 1234,
  spawnProcess,
  config = sessionConfig(),
  ...overrides
}) {
  return startPanSession({
    config,
    configPath: "C:\\domains\\example\\pan.json",
    assetService: { status: async () => ({ status: "current" }) },
    domainIdentity: {
      validate: async () => ({
        domain: {
          repository: "example/domain",
          path: "C:\\domains\\example",
          defaultBranch: "main",
        },
        project: { owner: "example", number: 12, id: "PVT_test" },
      }),
    },
    verifyCopilot: async () => {},
    stateFileFactory: () => stateFile,
    sessionIdFactory,
    hostname: "machine-a",
    pid,
    spawnProcess,
    ...overrides,
  });
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
