import { spawn } from "node:child_process";
import path from "node:path";

import { DomainIdentity } from "./domain-identity.js";
import { isCurrentPanAssets, PanAssetService } from "./pan-assets.js";
import { ProcessClient } from "./process-client.js";

const REQUIRED_COPILOT_OPTIONS = ["--agent", "--add-dir", "--model", "--no-auto-update"];

/**
 * Launches a foreground Copilot session after validating its one configured domain.
 */
export async function startPanSession({
  config,
  configPath,
  executable = config?.session?.agent?.executable ?? "copilot",
  model = config?.session?.agent?.model,
  env = process.env,
  spawnProcess = spawn,
  assetService = new PanAssetService({ env }),
  domainIdentity = new DomainIdentity(),
  commands = new ProcessClient(),
  verifyCopilot = verifyCopilotContract,
} = {}) {
  if (!config?.domain || !config?.session?.agent || !configPath) {
    throw new TypeError("config and configPath are required");
  }
  if (typeof spawnProcess !== "function") {
    throw new TypeError("spawnProcess must be a function");
  }

  const assets = await assetService.status();
  if (!isCurrentPanAssets(assets)) {
    throw new Error(
      `PAN assets are ${assets.status}; run \`pan assets repair\` before starting a PAN session`,
    );
  }
  const identity = await domainIdentity.validate(config);
  await verifyCopilot({ executable, commands });

  const sessionEnv = buildSessionEnvironment({
    env,
    configPath,
    config,
    identity,
  });
  const args = buildSessionCopilotArgs({ config, model });
  const child = spawnProcess(executable, args, {
    cwd: identity.domain.path,
    env: sessionEnv,
    stdio: "inherit",
    windowsHide: false,
  });
  const { code, signal } = await waitForExit(child);
  return {
    domain: identity.domain,
    project: identity.project,
    model: model ?? "auto",
    exitCode: code ?? 1,
    signal: signal ?? undefined,
  };
}

export function buildSessionCopilotArgs({ config, model = config?.session?.agent?.model } = {}) {
  if (!config?.session?.agent?.name) {
    throw new TypeError("config.session.agent.name is required");
  }
  return [
    "--agent",
    config.session.agent.name,
    "--no-auto-update",
    ...(model ? ["--model", model] : []),
    ...config.session.productContextRoots.flatMap((root) => [
      "--add-dir",
      root.path,
    ]),
  ];
}

export function buildSessionEnvironment({ env, configPath, config, identity }) {
  const inherited = Object.fromEntries(
    Object.entries(env).filter(([name]) => !name.startsWith("PAN_")),
  );
  return {
    ...inherited,
    PAN_SESSION_VERSION: "1",
    PAN_DOMAIN_CONFIG: path.resolve(configPath),
    PAN_DOMAIN_REPOSITORY: config.domain.repository,
    PAN_DOMAIN_ROOT: identity.domain.path,
    PAN_DOMAIN_PROJECT: `${config.domain.projectOwner}/${config.domain.projectNumber}`,
    PAN_PRODUCT_CONTEXT_ROOTS: JSON.stringify(
      config.session.productContextRoots.map(({ label, path }) => ({ label, path })),
    ),
  };
}

export async function verifyCopilotContract({ executable = "copilot", commands = new ProcessClient() } = {}) {
  const help = await commands.run(executable, ["--help"], {
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  const missing = REQUIRED_COPILOT_OPTIONS.filter((option) => !help.includes(option));
  if (missing.length > 0) {
    throw new Error(
      `Copilot CLI does not support the required PAN session options: ${missing.join(", ")}`,
    );
  }
}

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
}
