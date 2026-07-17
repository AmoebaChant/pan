#!/usr/bin/env node

import {
  GhClient,
  LocalTaskExecutor,
  PanStore,
  RunnerDaemon,
  acquireRunnerLock,
  loadRunnerProfile,
} from "../src/index.js";

const options = parseArgs(process.argv.slice(2));
const profile = await loadRunnerProfile(options.profile);

if (options.validateProfile) {
  console.log(`Runner profile ${profile.id} is valid.`);
  process.exit(0);
}

const gh = new GhClient();
const store = new PanStore({
  repository: profile.store.repository,
  projectOwner: profile.store.projectOwner,
  projectNumber: profile.store.projectNumber,
  gh,
});
const executor = new LocalTaskExecutor({ profile });
const daemon = new RunnerDaemon({ store, profile, executor });
const lock = await acquireRunnerLock(profile);

try {
  if (options.once) {
    await daemon.runOnce();
  } else {
    const controller = new AbortController();
    process.once("SIGINT", () => controller.abort());
    process.once("SIGTERM", () => controller.abort());
    await daemon.run({ signal: controller.signal });
  }
} finally {
  await lock.release();
}

function parseArgs(args) {
  const profileIndex = args.indexOf("--profile");
  if (profileIndex === -1 || !args[profileIndex + 1]) {
    throw new TypeError(
      "Usage: pan-runner --profile <path> [--once] [--validate-profile]",
    );
  }
  return {
    profile: args[profileIndex + 1],
    once: args.includes("--once"),
    validateProfile: args.includes("--validate-profile"),
  };
}
