import assert from "node:assert/strict";
import test from "node:test";

import { ProcessClient } from "../src/process-client.js";

test("captures successful process output", async () => {
  const client = new ProcessClient();

  const output = await client.run(process.execPath, [
    "-e",
    'process.stdout.write("ok")',
  ]);

  assert.equal(output, "ok");
});

test("terminates a process when its deadline expires", async () => {
  const client = new ProcessClient();

  await assert.rejects(
    client.run(
      process.execPath,
      ["-e", "setTimeout(() => {}, 60_000)"],
      { timeout: 50 },
    ),
    /failed/,
  );
});
