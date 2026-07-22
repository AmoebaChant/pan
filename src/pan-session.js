import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";

import { DomainIdentity } from "./domain-identity.js";
import { GhClient } from "./gh-client.js";
import { GitHubStateFile, LeaderLease } from "./leader-lease.js";
import { isCurrentPanAssets, PanAssetService } from "./pan-assets.js";
import { ProcessClient } from "./process-client.js";
import { terminateProcessTree } from "./process-tree.js";

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
  domainIdentity = new DomainIdentity({ env }),
  commands = new ProcessClient(),
  verifyCopilot = verifyCopilotContract,
  gh = new GhClient({ env }),
  stateFileFactory = (options) => new GitHubStateFile(options),
  leaseFactory = (options) => new LeaderLease(options),
  sessionIdFactory = randomUUID,
  hostname = os.hostname(),
  pid = process.pid,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
  terminateChild = terminateProcessTree,
  signals = process,
  onMode,
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
  if (!hostname?.trim() || !Number.isInteger(pid) || pid <= 0) {
    throw new TypeError("hostname and a positive integer pid are required");
  }

  const assets = await assetService.status();
  if (!isCurrentPanAssets(assets)) {
    throw new Error(
      `PAN assets are ${assets.status}; run \`pan assets repair\` before starting a PAN session`,
    );
  }
  const identity = await domainIdentity.validate(config);
  await verifyCopilot({ executable, commands });

  const sessionId = sessionIdFactory();
  const leaderLease = leaseFactory({
    stateFile: stateFileFactory({
      gh,
      repository: config.domain.repository,
      branch: config.state.branch,
      filePath: config.state.leaderPath,
    }),
    holder: `${hostname}/pan-${pid}`,
    machine: hostname,
    pid,
    sessionId,
    holderKind: "copilot-session",
    leaseSeconds: config.leadership.leaseSeconds,
  });
  const acquisition = await acquireSessionLeadership(leaderLease);
  const mode = acquisition.acquired ? "writing" : "read-only";
  const leadership = acquisition.acquired
    ? {
        holder: acquisition.lease.holder,
        generation: acquisition.lease.token,
        sessionId,
      }
    : undefined;
  const sessionEnv = buildSessionEnvironment({
    env,
    configPath,
    config,
    identity,
    sessionId,
    mode,
    leadership,
  });
  const args = buildSessionCopilotArgs({ config, model });
  let child;
  let guard;
  let leadershipLoss;
  let termination;
  let exit;
  const stopChild = async (reason) => {
    leadershipLoss ??= reason;
    if (!child || termination) {
      return termination;
    }
    termination = Promise.resolve(terminateChild(child)).catch((error) => {
      leadershipLoss ??= error;
    });
    return termination;
  };
  const onSignal = (signal) => {
    void stopForSignal(signal);
  };
  const stopForSignal = async (signal) => {
    try {
      await guard?.stop();
    } catch (error) {
      leadershipLoss ??= error;
    }
    await stopChild(new Error(`PAN session received ${signal}`));
  };

  try {
    child = spawnProcess(executable, args, {
      cwd: identity.domain.path,
      env: sessionEnv,
      stdio: "inherit",
      windowsHide: false,
    });
    onMode?.({
      mode,
      sessionId,
      ...(acquisition.acquired
        ? { leaseExpiresAt: acquisition.lease.expiresAt }
        : { reason: acquisition.reason ?? "held-by-another-session" }),
    });
    if (acquisition.acquired) {
      guard = startSessionLeaseGuard({
        leaderLease,
        heartbeatSeconds: config.leadership.heartbeatSeconds,
        setIntervalImpl,
        clearIntervalImpl,
        onLost: stopChild,
      });
    }
    signals?.once?.("SIGINT", onSignal);
    signals?.once?.("SIGTERM", onSignal);
    exit = await waitForExit(child);
    await termination;
  } finally {
    signals?.removeListener?.("SIGINT", onSignal);
    signals?.removeListener?.("SIGTERM", onSignal);
    try {
      await guard?.stop();
    } catch (error) {
      leadershipLoss ??= error;
      await stopChild(error);
    }
    if (acquisition.acquired) {
      try {
        await leaderLease.release();
      } catch (error) {
        leadershipLoss ??= error;
      }
    }
  }
  return sessionResult({
    identity,
    model,
    mode,
    code: exit?.code,
    signal: exit?.signal,
    leadershipLoss,
  });
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

export function buildSessionEnvironment({
  env,
  configPath,
  config,
  identity,
  sessionId,
  mode = "read-only",
  leadership,
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
    PAN_SESSION_MODE: mode,
    ...(sessionId ? { PAN_SESSION_ID: sessionId } : {}),
    PAN_PRODUCT_CONTEXT_ROOTS: JSON.stringify(
      config.session.productContextRoots.map(({ label, path }) => ({ label, path })),
    ),
    ...(mode === "writing" && leadership
      ? {
          PAN_LEADERSHIP_HOLDER: leadership.holder,
          PAN_LEADERSHIP_GENERATION: leadership.generation,
          PAN_LEADERSHIP_HOLDER_KIND: "copilot-session",
        }
      : {}),
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

async function acquireSessionLeadership(leaderLease) {
  try {
    return await leaderLease.acquire();
  } catch (error) {
    return { acquired: false, reason: "unverifiable", error };
  }
}

function startSessionLeaseGuard({
  leaderLease,
  heartbeatSeconds,
  setIntervalImpl,
  clearIntervalImpl,
  onLost,
}) {
  let timer;
  let inFlight;
  let failure;
  const fail = (error) => {
    if (failure) {
      return;
    }
    failure = error;
    clearIntervalImpl(timer);
    void onLost(error);
  };
  const heartbeat = () => {
    if (inFlight || failure) {
      return;
    }
    inFlight = leaderLease
      .heartbeat()
      .then((result) => {
        if (!result.renewed) {
          fail(new Error(`PAN leadership lost: ${result.reason}`));
        }
      })
      .catch((error) => fail(error))
      .finally(() => {
        inFlight = undefined;
      });
  };
  timer = setIntervalImpl(heartbeat, heartbeatSeconds * 1_000);
  return {
    async stop() {
      clearIntervalImpl(timer);
      await inFlight;
      if (failure) {
        throw failure;
      }
    },
  };
}

function sessionResult({
  identity,
  model,
  mode,
  code,
  signal,
  leadershipLoss,
}) {
  return {
    domain: identity.domain,
    project: identity.project,
    model: model ?? "auto",
    mode,
    exitCode: leadershipLoss ? (code && code !== 0 ? code : 1) : (code ?? 1),
    signal: signal ?? undefined,
    ...(leadershipLoss
      ? {
          leadership: {
            status: "lost",
            diagnostic: leadershipLoss.message,
            guidance:
              "Restart the session to acquire leadership, or continue in read-only mode.",
          },
        }
      : {}),
  };
}
