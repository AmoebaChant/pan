import assert from "node:assert/strict";
import test from "node:test";

import { LeaderLease } from "../src/index.js";

test("allows only one concurrent leader lease winner", async () => {
  const stateFile = new MemoryStateFile();
  const first = new LeaderLease({
    stateFile,
    holder: "machine-a",
    tokenFactory: () => "token-a",
  });
  const second = new LeaderLease({
    stateFile,
    holder: "machine-b",
    tokenFactory: () => "token-b",
  });

  const results = await Promise.all([first.acquire(), second.acquire()]);

  assert.equal(results.filter((result) => result.acquired).length, 1);
  assert.equal(stateFile.value.holder, "machine-a");
});

test("heartbeats and releases an owned leader lease", async () => {
  let now = new Date("2026-07-20T16:00:00Z");
  const stateFile = new MemoryStateFile();
  const lease = new LeaderLease({
    stateFile,
    holder: "machine-a",
    leaseSeconds: 60,
    now: () => now,
    tokenFactory: () => "token-a",
  });

  assert.equal((await lease.acquire()).acquired, true);
  now = new Date("2026-07-20T16:00:30Z");
  assert.equal((await lease.heartbeat()).renewed, true);
  assert.equal(stateFile.value.expiresAt, "2026-07-20T16:01:30.000Z");
  assert.equal((await lease.release()).released, true);
  assert.equal(stateFile.value.expiresAt, now.toISOString());
});

test("cannot renew a lease after another holder takes it", async () => {
  const stateFile = new MemoryStateFile();
  const lease = new LeaderLease({
    stateFile,
    holder: "machine-a",
    tokenFactory: () => "token-a",
  });
  await lease.acquire();
  stateFile.value = {
    version: 1,
    holder: "machine-b",
    token: "token-b",
    expiresAt: "2099-01-01T00:00:00.000Z",
  };
  stateFile.version += 1;

  assert.deepEqual(await lease.heartbeat(), {
    renewed: false,
    reason: "lost",
  });
});

test("reclaims an active lease held by a dead process on the same machine", async () => {
  const stateFile = new MemoryStateFile();
  stateFile.value = {
    version: 1,
    holder: "machine-a/pan-1234",
    machine: "machine-a",
    pid: 1234,
    token: "old-token",
    expiresAt: "2099-01-01T00:00:00.000Z",
  };
  stateFile.version = 1;
  const lease = new LeaderLease({
    stateFile,
    holder: "machine-a/pan-5678",
    machine: "machine-a",
    pid: 5678,
    isProcessAlive: () => false,
    tokenFactory: () => "new-token",
  });

  const result = await lease.acquire();

  assert.equal(result.acquired, true);
  assert.equal(result.reclaimed.pid, 1234);
  assert.equal(stateFile.value.holder, "machine-a/pan-5678");
  assert.equal(stateFile.value.machine, "machine-a");
  assert.equal(stateFile.value.pid, 5678);
});

test("reclaims a legacy local lease whose PID is encoded in its holder", async () => {
  const stateFile = new MemoryStateFile();
  stateFile.value = {
    version: 1,
    holder: "machine-a/pan-1234",
    token: "old-token",
    expiresAt: "2099-01-01T00:00:00.000Z",
  };
  stateFile.version = 1;
  const lease = new LeaderLease({
    stateFile,
    holder: "machine-a/pan-5678",
    machine: "machine-a",
    pid: 5678,
    isProcessAlive: () => false,
    tokenFactory: () => "new-token",
  });

  assert.equal((await lease.acquire()).acquired, true);
});

test("preserves an active lease when its local process is still alive", async () => {
  const stateFile = new MemoryStateFile();
  stateFile.value = {
    version: 1,
    holder: "machine-a/pan-1234",
    machine: "machine-a",
    pid: 1234,
    token: "old-token",
    expiresAt: "2099-01-01T00:00:00.000Z",
  };
  stateFile.version = 1;
  const lease = new LeaderLease({
    stateFile,
    holder: "machine-a/pan-5678",
    machine: "machine-a",
    pid: 5678,
    isProcessAlive: () => true,
    tokenFactory: () => "new-token",
  });

  const result = await lease.acquire();

  assert.equal(result.acquired, false);
  assert.equal(result.lease.holder, "machine-a/pan-1234");
});

test("never reclaims an active lease from another machine", async () => {
  const stateFile = new MemoryStateFile();
  stateFile.value = {
    version: 1,
    holder: "machine-b/pan-1234",
    machine: "machine-b",
    pid: 1234,
    token: "old-token",
    expiresAt: "2099-01-01T00:00:00.000Z",
  };
  stateFile.version = 1;
  let checkedProcess = false;
  const lease = new LeaderLease({
    stateFile,
    holder: "machine-a/pan-5678",
    machine: "machine-a",
    pid: 5678,
    isProcessAlive: () => {
      checkedProcess = true;
      return false;
    },
    tokenFactory: () => "new-token",
  });

  const result = await lease.acquire();

  assert.equal(result.acquired, false);
  assert.equal(checkedProcess, false);
});

test("stateless callers revalidate their session generation before renewal or release", async () => {
  let now = new Date("2026-07-20T16:00:00Z");
  const stateFile = new MemoryStateFile();
  const first = new LeaderLease({
    stateFile,
    holder: "session-a",
    sessionId: "session-a",
    holderKind: "copilot-session",
    now: () => now,
    tokenFactory: () => "generation-a",
  });
  assert.equal((await first.acquire()).acquired, true);

  const stateless = new LeaderLease({
    stateFile,
    holder: "session-a",
    sessionId: "session-a",
    now: () => now,
  });
  assert.equal(
    (await stateless.assert({
      token: "generation-a",
      sessionId: "session-a",
    })).asserted,
    true,
  );
  assert.equal(
    (await stateless.renew({
      token: "generation-a",
      sessionId: "session-a",
    })).renewed,
    true,
  );

  assert.equal(
    (await stateless.release({
      token: "generation-a",
      sessionId: "session-a",
    })).released,
    true,
  );
  const second = new LeaderLease({
    stateFile,
    holder: "session-b",
    sessionId: "session-b",
    now: () => now,
    tokenFactory: () => "generation-b",
  });
  assert.equal((await second.acquire()).acquired, true);

  assert.deepEqual(
    await stateless.renew({
      token: "generation-a",
      sessionId: "session-a",
    }),
    { renewed: false, reason: "lost" },
  );
  assert.deepEqual(
    await stateless.release({
      token: "generation-a",
      sessionId: "session-a",
    }),
    { released: false, reason: "lost" },
  );
});

test("reports absent, expired, locally recoverable, and remote leader states", async () => {
  let now = new Date("2026-07-20T16:00:00Z");
  const stateFile = new MemoryStateFile();
  const lease = new LeaderLease({
    stateFile,
    holder: "machine-a/pan-5678",
    machine: "machine-a",
    pid: 5678,
    now: () => now,
    isProcessAlive: () => false,
  });

  assert.equal((await lease.status()).status, "absent");
  stateFile.value = {
    holder: "machine-a/pan-1234",
    machine: "machine-a",
    pid: 1234,
    token: "generation-a",
    expiresAt: "2026-07-20T15:59:59.000Z",
  };
  stateFile.version = 1;
  assert.equal((await lease.status()).status, "expired");
  stateFile.value.expiresAt = "2026-07-20T16:10:00.000Z";
  assert.equal((await lease.status()).status, "locally-recoverable");
  stateFile.value.machine = "machine-b";
  assert.equal((await lease.status()).status, "remote-or-unverifiable");
});

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
