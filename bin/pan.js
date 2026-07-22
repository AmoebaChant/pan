#!/usr/bin/env node

import { runPanCli } from "../src/pan-cli.js";

try {
  const result = await runPanCli(process.argv.slice(2));
  if (result?.signal) {
    process.kill(process.pid, result.signal);
  } else if (Number.isInteger(result?.exitCode)) {
    process.exitCode = result.exitCode;
  }
} catch (error) {
  if (error.result) {
    process.stdout.write(`${JSON.stringify(error.result)}\n`);
    process.exitCode = 1;
  } else {
    console.error(error.message);
    process.exitCode = 1;
  }
}
