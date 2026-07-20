#!/usr/bin/env node

import { runPanCli } from "../src/pan-cli.js";

try {
  await runPanCli(process.argv.slice(2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

