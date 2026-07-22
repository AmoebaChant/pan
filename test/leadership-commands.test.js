import assert from "node:assert/strict";
import test from "node:test";

import {
  createLeadershipCommandHandlers,
  runPanCli,
} from "../src/index.js";

test("leadership helpers use fresh durable state rather than in-memory ownership", async () => {
  const stateFile = new MemoryStateFile();
  const context = commandContext();
  const first = createLeadershipCommandHandlers({
    env: sessionEnvironment("session-a", "generation-a"),
    stateFileFactory: () => stateFile,
  });

  const acquired = await first.acquire({ context });
  assert.equal(acquired.status, "confirmed");
  assert.equal(acquired.leadership.sessionId, "session-a");
  assert.equal(stateFile.value.holderKind, "copilot-session");

  const fresh = createLeadershipCommandHandlers({
    env: sessionEnvironment("session-a", "generation-a"),
    stateFileFactory: () => stateFile,
  });
  assert.equal((await fresh.assert({ context })).status, "confirmed");
  assert.equal((await fresh.renew({ context })).status, "confirmed");

  const other = createLeadershipCommandHandlers({
    env: sessionEnvironment("session-b", "generation-b"),
    stateFileFactory: () => stateFile,
  });
  const rejected = await other.acquire({ context });
  assert.equal(rejected.status, "rejected");
  assert.match(rejected.diagnostics.at(-1), /not confirmed/i);

  const status = await other.status({ context });
  assert.equal(status.status, "confirmed");
  assert.equal(status.leadership.status, "remote-or-unverifiable");
});

test("stale generations cannot renew or release a replacement leader", async () => {
  const stateFile = new MemoryStateFile();
  const context = commandContext();
  const first = createLeadershipCommandHandlers({
    env: sessionEnvironment("session-a", "generation-a"),
    stateFileFactory: () => stateFile,
  });
  assert.equal((await first.acquire({ context })).status, "confirmed");
  const released = await first.release({ context });
  assert.equal(released.status, "confirmed");
  assert.equal(released.leadership.status, "released");

  const second = createLeadershipCommandHandlers({
    env: sessionEnvironment("session-b", "generation-b"),
    stateFileFactory: () => stateFile,
  });
  assert.equal((await second.acquire({ context })).status, "confirmed");

  assert.equal((await first.renew({ context })).status, "rejected");
  assert.equal((await first.release({ context })).status, "rejected");
  assert.equal(stateFile.value.holder, "session-b");
});

test("leadership CLI dispatches the stateless helper contract", async () => {
  const stateFile = new MemoryStateFile();
  const handlers = createLeadershipCommandHandlers({
    env: sessionEnvironment("session-a", "generation-a"),
    stateFileFactory: () => stateFile,
  });
  const stdout = capture();

  const result = await runPanCli(
    [
      "leadership",
      "acquire",
      "--schema-version",
      "1",
      "--config",
      "domain.json",
      "--json",
    ],
    {
      commandHandlers: { leadership: handlers },
      commandContextFactory: async () => commandContext(),
      stdout,
    },
  );

  assert.equal(result.status, "confirmed");
  assert.equal(JSON.parse(stdout.value).operation, "leadership.acquire");
});

test("mutating leadership helpers require the session environment contract", async () => {
  const handlers = createLeadershipCommandHandlers({
    env: {},
    stateFileFactory: () => new MemoryStateFile(),
  });

  await assert.rejects(handlers.acquire({ context: commandContext() }), /PAN_SESSION_ID/);
  assert.equal((await handlers.status({ context: commandContext() })).status, "confirmed");
});

function commandContext() {
  return {
    gh: {},
    config: {
      state: { branch: "pan-state", leaderPath: ".pan/leader.json" },
      leadership: { leaseSeconds: 120 },
    },
    domain: {
      repository: "example/domain",
      projectOwner: "example",
      projectNumber: 12,
    },
  };
}

function sessionEnvironment(sessionId, generation) {
  return {
    PAN_SESSION_ID: sessionId,
    PAN_LEADERSHIP_HOLDER: sessionId,
    PAN_LEADERSHIP_GENERATION: generation,
  };
}

function capture() {
  return {
    value: "",
    write(value) {
      this.value += value;
    },
  };
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
