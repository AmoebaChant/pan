#!/usr/bin/env node

import { runPanCli } from "../src/pan-cli.js";

try {
  await runPanCli(process.argv.slice(2));
} catch (error) {
  if (error.result) {
    process.stdout.write(`${JSON.stringify(error.result)}\n`);
    process.exitCode = 1;
  } else {
    console.error(error.message);
    process.exitCode = 1;
  }
}
