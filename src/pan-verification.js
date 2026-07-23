import path from "node:path";

import { verifyCopilotInvocationContract } from "./copilot-contract.js";
import { DomainIdentity } from "./domain-identity.js";
import { PanAssetService, isCurrentPanAssets } from "./pan-assets.js";
import { ProcessClient } from "./process-client.js";
import { loadRunnerProfile } from "./runner-profile.js";
import {
  buildPanLaunchers,
  validatePanLaunchers,
} from "./pan-shortcuts.js";

/** Verifies that the installed assets, domain, session, and runner agree. */
export async function verifyPanSetup({
  config,
  configPath,
  runnerProfilePath,
  env = process.env,
  profileLoader = loadRunnerProfile,
  assetService = new PanAssetService({ env }),
  domainIdentity = new DomainIdentity({ env }),
  commands = new ProcessClient(),
  executable = config?.session?.agent?.executable ?? "copilot",
} = {}) {
  if (!config || !configPath || !runnerProfilePath) {
    throw new TypeError("config, configPath, and runnerProfilePath are required");
  }
  const [assets, profile, identity] = await Promise.all([
    assetService.status(),
    profileLoader(runnerProfilePath),
    domainIdentity.validate(config),
  ]);
  if (!isCurrentPanAssets(assets)) {
    throw new Error(`PAN assets are ${assets.status}; run \`pan assets repair\``);
  }
  assertMatchingDomain(config, profile, {
    configPath,
    requireConfigPath: true,
  });
  await verifyCopilotInvocationContract({
    executable,
    commands,
    requireScheduling: Boolean(config.scheduling?.enabled),
    scheduling: config.scheduling,
  });
  const launchers = buildPanLaunchers({
    configPath: path.resolve(configPath),
    runnerProfilePath: path.resolve(runnerProfilePath),
  });
  await validatePanLaunchers({
    ...launchers,
    selection: "both",
    env,
    commands,
  });
  return {
    status: "ready",
    repository: config.domain.repository,
    project: `${config.domain.projectOwner}/${config.domain.projectNumber}`,
    configPath: path.resolve(configPath),
    runnerProfilePath: path.resolve(runnerProfilePath),
    domainPath: identity.domain.path,
    assets: assets.status,
    runnerOnline: profile.online,
    launchCommands: launchers.launchCommands,
  };
}

export function assertMatchingDomain(
  config,
  profile,
  { configPath, requireConfigPath = false } = {},
) {
  if (
    config.domain.repository !== profile.store.repository ||
    config.domain.projectOwner !== profile.store.projectOwner ||
    config.domain.projectNumber !== profile.store.projectNumber ||
    path.resolve(config.domain.path) !== path.resolve(profile.store.path)
  ) {
    throw new Error("Runner and domain configuration must target the same PAN domain");
  }
  if (requireConfigPath) {
    const referencedConfigPath =
      profile.domainConfigPath ??
      (profile.profilePath
        ? path.resolve(path.dirname(profile.profilePath), "..", "pan.json")
        : undefined);
    if (!referencedConfigPath) {
      throw new Error("Runner profile must identify its PAN domain configuration");
    }
    if (path.resolve(referencedConfigPath) !== path.resolve(configPath)) {
      throw new Error(
        "Runner profile must reference the verified PAN domain configuration",
      );
    }
  }
}
