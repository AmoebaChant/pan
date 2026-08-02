#!/usr/bin/env node

import path from "node:path";

import {
  createServiceLogger,
  GhClient,
  LocalTaskExecutor,
  PanStore,
  RunnerDaemon,
  acquireRunnerLock,
  AttentionService,
  createWindowTitleWriter,
  loadDomainConfig,
  loadRunnerProfile,
} from "../src/index.js";

const options = parseArgs(process.argv.slice(2));
const profile = await loadRunnerProfile(options.profile);
const gh = new GhClient();
const domainConfig = profile.domainConfigPath
  ? await loadDomainConfig(profile.domainConfigPath, { gh })
  : undefined;
if (
  domainConfig &&
  (domainConfig.domain.repository.toLowerCase() !==
      profile.store.repository.toLowerCase() ||
    domainConfig.domain.projectOwner.toLowerCase() !==
      profile.store.projectOwner.toLowerCase() ||
    domainConfig.domain.projectNumber !== profile.store.projectNumber)
) {
  throw new Error("Runner and domain configuration must target the same Pan store");
}
const logger = await createServiceLogger({
  name: "Pan runner",
  logFile: path.join(profile.stateDirectory, "runner.log"),
});

if (options.validateProfile) {
  console.log(`Runner profile ${profile.id} is valid.`);
  await logger.close();
  process.exit(0);
}

const store = new PanStore({
  repository: profile.store.repository,
  projectOwner: profile.store.projectOwner,
  projectNumber: profile.store.projectNumber,
  gh,
});
const executor = new LocalTaskExecutor({ profile, logger, gh });
const attention = new AttentionService({ store });
const daemon = new RunnerDaemon({
  store,
  profile,
  executor,
  attention,
  logger,
  setWindowTitle: createWindowTitleWriter(process.stdout),
});
const lock = await acquireRunnerLock(profile);
const controller = new AbortController();
process.once("SIGINT", () => {
  logger.info("Ctrl+C received; waiting for active tasks to stop.");
  controller.abort(new Error("Ctrl+C"));
});
process.once("SIGTERM", () => {
  logger.info("Termination requested; waiting for active tasks to stop.");
  controller.abort(new Error("Termination requested"));
});

try {
  logger.info(
    `Starting ${profile.id}; model=${profile.copilot.model ?? "auto"}, capacity=${profile.maxConcurrentDaemons}, wall-clock=${profile.taskBudget.wallClockMinutes ? `${profile.taskBudget.wallClockMinutes}m` : "unlimited"}, AI credits=${profile.taskBudget.maxAiCredits ?? "unlimited"}.`,
  );
  logger.info(
    `Playbooks: ${profile.playbooks.map((playbook) => `${playbook.id}=${playbook.capacity === 0 ? "disabled" : playbook.capacity}`).join(", ")}.`,
  );
  logger.info(
    `Activity log: ${path.join(profile.stateDirectory, "runner.log")}`,
  );
  if (options.once) {
    await daemon.runOnce({ signal: controller.signal });
  } else {
    await daemon.run({ signal: controller.signal });
  }
} finally {
  await lock.release();
  logger.info("Stopped.");
  await logger.close();
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
