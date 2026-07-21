import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createServiceLogger } from "../src/index.js";

test("tees timestamped service activity to the console and a file", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pan-logger-"));
  const logFile = path.join(directory, "service.log");
  const lines = [];
  const logger = await createServiceLogger({
    name: "PAN test",
    logFile,
    consoleTarget: {
      log: (line) => lines.push(line),
      error: (line) => lines.push(line),
      warn: (line) => lines.push(line),
    },
    now: () => new Date("2026-07-21T12:00:00.000Z"),
  });

  try {
    logger.info("model=%s", "gpt-5.6-sol");
    logger.error("failed", new Error("example"));
    await logger.close();

    const file = await readFile(logFile, "utf8");
    assert.match(lines[0], /2026-07-21T12:00:00.000Z \[PAN test\] INFO/);
    assert.match(file, /model=gpt-5.6-sol/);
    assert.match(file, /ERROR failed Error: example/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("reports log-file open failures before starting the service", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pan-logger-"));
  const blockedDirectory = path.join(directory, "not-a-directory");
  await writeFile(blockedDirectory, "blocked", "utf8");

  try {
    await assert.rejects(
      createServiceLogger({
        name: "PAN test",
        logFile: path.join(blockedDirectory, "service.log"),
      }),
      /EEXIST|ENOTDIR|not a directory/i,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
