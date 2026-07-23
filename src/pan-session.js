import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DomainIdentity } from "./domain-identity.js";
import { isCurrentPanAssets, PanAssetService } from "./pan-assets.js";
import {
  buildScheduleBootstrapPrompt,
  nativeScheduleIntervalSeconds,
  verifyCopilotInvocationContract,
} from "./copilot-contract.js";
import { ProcessClient } from "./process-client.js";
import { terminateProcessTree } from "./process-tree.js";
import { createSessionDueState } from "./session-due-state.js";

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
  domainIdentity = new DomainIdentity({ env }),
  commands = new ProcessClient(),
  verifyCopilot = verifyCopilotContract,
  dueStateFactory = createSessionDueState,
  sessionIdFactory = randomUUID,
  terminateChild = terminateProcessTree,
  signals = process,
} = {}) {
  if (!config?.domain || !config?.session?.agent || !configPath) {
    throw new TypeError("config and configPath are required");
  }
  if (typeof spawnProcess !== "function") {
    throw new TypeError("spawnProcess must be a function");
  }
  if (typeof sessionIdFactory !== "function") {
    throw new TypeError("sessionIdFactory must be a function");
  }
  const assets = await assetService.status();
  if (!isCurrentPanAssets(assets)) {
    throw new Error(
      `PAN assets are ${assets.status}; run \`pan assets repair\` before starting a PAN session`,
    );
  }
  const identity = await domainIdentity.validate(config);

  const sessionId = sessionIdFactory();
  let child;
  let dueState;
  let termination;
  let exit;
  const stopChild = async () => {
    if (!child || termination) {
      return termination;
    }
    termination = Promise.resolve(terminateChild(child));
    return termination;
  };
  const onSignal = (signal) => {
    void stopForSignal(signal);
  };
  const stopForSignal = async (signal) => {
    await stopChild();
  };

  try {
    const schedulingEnabled = config.scheduling?.enabled;
    await verifyCopilot({
      executable,
      commands,
      requireScheduling: schedulingEnabled,
      scheduling: config.scheduling,
    });
    if (schedulingEnabled) {
      dueState = await dueStateFactory({
        sessionId,
        reviewIntervalSeconds: config.scheduling.reviewIntervalSeconds,
        directory: sessionDueStateDirectory(env),
      });
    }
    const sessionEnv = buildSessionEnvironment({
      env,
      configPath,
      config,
      identity,
      sessionId,
      dueState,
    });
    const args = buildSessionCopilotArgs({
      config,
      model,
      bootstrapPrompt: schedulingEnabled
        ? buildScheduleBootstrapPrompt({
            scheduling: config.scheduling,
            dueStatePath: dueState.path,
          })
        : undefined,
    });
    child = spawnProcess(executable, args, {
      cwd: identity.domain.path,
      env: sessionEnv,
      stdio: "inherit",
      windowsHide: false,
    });
    signals?.once?.("SIGINT", onSignal);
    signals?.once?.("SIGTERM", onSignal);
    exit = await waitForExit(child);
    await termination;
  } finally {
    signals?.removeListener?.("SIGINT", onSignal);
    signals?.removeListener?.("SIGTERM", onSignal);
    await dueState?.dispose().catch(() => {});
  }
  return sessionResult({
    identity,
    model,
    code: exit?.code,
    signal: exit?.signal,
  });
}

export function buildSessionCopilotArgs({
  config,
  model = config?.session?.agent?.model,
  bootstrapPrompt,
} = {}) {
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
    ...(bootstrapPrompt ? ["--interactive", bootstrapPrompt] : []),
  ];
}

export function buildSessionEnvironment({
  env,
  configPath,
  config,
  identity,
  sessionId,
  dueState,
}) {
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
    PAN_PROJECT_SCHEMA: fileURLToPath(
      new URL("../schema/project-fields.json", import.meta.url),
    ),
    ...(sessionId ? { PAN_SESSION_ID: sessionId } : {}),
    ...(dueState
      ? {
          PAN_SCHEDULE_DUE_STATE: dueState.path,
          PAN_SCHEDULE_INTERVAL_SECONDS: String(
            nativeScheduleIntervalSeconds(config.scheduling.reviewIntervalSeconds),
          ),
        }
      : {}),
    PAN_PRODUCT_CONTEXT_ROOTS: JSON.stringify(
      config.session.productContextRoots.map(({ label, path }) => ({ label, path })),
    ),
  };
}

export async function verifyCopilotContract({
  executable = "copilot",
  commands = new ProcessClient(),
  requireScheduling = false,
  scheduling,
} = {}) {
  return verifyCopilotInvocationContract({
    executable,
    commands,
    requireScheduling,
    scheduling,
  });
}

function sessionDueStateDirectory(env) {
  return path.join(
    env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"),
    "PAN",
    "sessions",
  );
}

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
}

function sessionResult({ identity, model, code, signal }) {
  return {
    domain: identity.domain,
    project: identity.project,
    model: model ?? "auto",
    exitCode: code ?? 1,
    signal: signal ?? undefined,
  };
}
