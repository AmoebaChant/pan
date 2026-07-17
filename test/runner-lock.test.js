import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { acquireRunnerLock } from "../src/index.js";

test("prevents two processes from using the same runner profile", async () => {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "pan-lock-"));
  const profile = { id: "runner-a", stateDirectory };
  const lock = await acquireRunnerLock(profile);

  try {
    await assert.rejects(
      acquireRunnerLock(profile),
      /Runner runner-a is already active/,
    );
  } finally {
    await lock.release();
    await rm(stateDirectory, { recursive: true, force: true });
  }
});
