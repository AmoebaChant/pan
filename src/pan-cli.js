import { fileURLToPath } from "node:url";
import path from "node:path";

import { AttentionService } from "./attention-service.js";
import { ActionPolicy } from "./action-policy.js";
import { PanAssetService } from "./pan-assets.js";
import { createPanCommandContext } from "./pan-command-context.js";
import {
  commandResultFromError,
  PanCommandError,
  validatePanCommandResult,
} from "./pan-command-result.js";
import { loadDomainConfig } from "./domain-config.js";
import { GhClient } from "./gh-client.js";
import { GitHubStateFile, LeaderLease } from "./leader-lease.js";
import { createLeadershipCommandHandlers } from "./leadership-commands.js";
import { createActionCommandHandlers } from "./action-commands.js";
import { createEvidenceCommandHandlers } from "./evidence-commands.js";
import { createAttentionCommandHandlers } from "./attention-commands.js";
import { createReconciliationCommandHandlers } from "./reconciliation-commands.js";
import { createWorkstreamCommandHandlers } from "./workstream-commands.js";
import { PanAgentClient } from "./pan-agent-client.js";
import { startPanSession } from "./pan-session.js";
import { PanReviewService } from "./pan-review-service.js";
import { PanRuntime } from "./pan-runtime.js";
import { setupPanDomain } from "./pan-setup.js";
import { PanStore } from "./pan-store.js";
import { PortfolioSnapshotBuilder } from "./portfolio-snapshot.js";
import { RunnerProfileSource } from "./runner-profile-source.js";
import { WorkstreamStore } from "./workstream-store.js";

const TOOL_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

export async function runPanCli(
  args,
  {
    env = process.env,
    stdout = process.stdout,
    stderr = process.stderr,
    gh = new GhClient(),
    pid = process.pid,
    domainConfigLoader = loadDomainConfig,
    storeFactory = (options) => new PanStore(options),
    attentionFactory = (options) => new AttentionService(options),
    reviewServiceFactory,
    runtimeFactory = (options) => new PanRuntime(options),
    sessionFactory = startPanSession,
    setupFactory = setupPanDomain,
    assetServiceFactory = (options) => new PanAssetService(options),
    commandContextFactory = createPanCommandContext,
    commandHandlers,
  } = {},
) {
  const helpers =
    commandHandlers ?? {
      leadership: createLeadershipCommandHandlers({ env }),
      action: createActionCommandHandlers({ env }),
      evidence: createEvidenceCommandHandlers(),
      attention: createAttentionCommandHandlers({ env }),
      reconcile: createReconciliationCommandHandlers({ env }),
      workstream: createWorkstreamCommandHandlers({ env }),
    };
  const normalized = normalizeLegacyAttentionAlias(args);
  const helper = parsePanHelperArgs(normalized.args, { env, handlers: helpers });
  if (helper) {
    if (normalized.guidance) {
      write(stderr, normalized.guidance);
    }
    return runPanHelperCommand(helper, {
      stdout,
      env,
      commandContextFactory,
      commandHandlers: helpers,
    });
  }
  const parsed = parseArgs(normalized.args, env);
  if (parsed.command === "assets") {
    const service = assetServiceFactory({ env });
    const result =
      parsed.operation === "status"
        ? await service.status()
        : parsed.operation === "install"
          ? await service.install()
          : await service.repair({ force: parsed.force });
    write(
      stdout,
      parsed.json ? JSON.stringify(result, null, 2) : formatAssetResult(result),
    );
    return result;
  }
  if (parsed.command === "setup") {
    const result = await setupFactory(parsed, {
      gh,
      env,
      output: stdout,
    });
    write(
      stdout,
      parsed.json
        ? JSON.stringify(result, null, 2)
        : formatSetupResult(result),
    );
    return result;
  }
  const configuration = await loadCliConfiguration(parsed, {
    domainConfigLoader,
  });
  if (parsed.command === "session") {
    const result = await sessionFactory({
      config: configuration.domainConfig,
      configPath: parsed.config,
      executable: configuration.agent.executable,
      model: configuration.agent.model,
      env,
      onMode: parsed.json
        ? undefined
        : ({ mode, reason }) =>
            write(
              stdout,
              mode === "writing"
                ? "PAN writing session started."
                : `PAN read-only session started${reason ? ` (${reason})` : ""}; mutations and scheduled reviews are unavailable.`,
            ),
    });
    write(
      stdout,
      parsed.json
        ? JSON.stringify(result, null, 2)
        : formatSessionResult(result),
    );
    return result;
  }

  function formatSessionResult(result) {
    const mode = result.mode ? ` (${result.mode})` : "";
    const loss = result.leadership?.status === "lost"
      ? ` Leadership lost: ${result.leadership.diagnostic}. ${result.leadership.guidance}`
      : "";
    return `PAN session exited with code ${result.exitCode}${result.signal ? ` (${result.signal})` : ""}${mode}.${loss}`;
  }
  const store = storeFactory({
    repository: configuration.store.repository,
    projectOwner: configuration.store.projectOwner,
    projectNumber: configuration.store.projectNumber,
    gh,
  });
  const attention = attentionFactory({
    store,
    humanAssignee: configuration.attention?.assignee,
  });

  if (parsed.command === "review") {
    const reviewService =
      reviewServiceFactory?.({ store, configuration, env }) ??
      createReviewService({ store, attention, configuration, env });
    let result;
    try {
      result = parsed.apply
        ? await runtimeFactory({
            reviewService,
            leaderLease: createLeaderLease({
              configuration,
              gh,
              pid,
            }),
            heartbeatSeconds: configuration.runtime.leaderHeartbeatSeconds,
            }).runOnce()
        : await reviewService.run({
            apply: false,
            });
    } catch (error) {
      if (error.result) {
        write(
          stdout,
          parsed.json
            ? JSON.stringify(error.result, null, 2)
            : formatReasoningResult(error.result),
        );
        throw new Error(
          "PAN could not safely complete the requested mutation",
          { cause: error },
        );
      }
      throw error;
    }
    if (result.leader === false) {
      write(
        stdout,
        parsed.json
          ? JSON.stringify(result, null, 2)
          : `PAN is already running elsewhere: ${result.reason}`,
      );
      return result;
    }
    write(
      stdout,
      parsed.json ? JSON.stringify(result, null, 2) : formatReasoningResult(result),
    );
    if (result.response.effects?.incomplete?.length > 0) {
      throw new Error("PAN could not safely complete the requested mutation");
    }
    return result;
  }
  throw new Error(`Unknown PAN command: ${parsed.command}`);
}

export function parseArgs(args, env = process.env) {
  const remaining = [...args];
  const config = takeOption(remaining, "--config") ?? env.PAN_CONFIG;
  const profile = takeOption(remaining, "--profile") ?? env.PAN_PROFILE;
  const configuration = { config, profile };
  const json = takeFlag(remaining, "--json");
  const command = remaining.shift();
  if (command === "setup") {
    if (config || profile) {
      throw new TypeError(
        "pan setup creates configuration and cannot use --config, --profile, PAN_CONFIG, or PAN_PROFILE",
      );
    }
    const repository = takeOption(remaining, "--repository");
    const setupPath = takeOption(remaining, "--path");
    const projectOwner = takeOption(remaining, "--project-owner");
    const projectTitle = takeOption(remaining, "--project-title");
    const approvalMode = takeOption(remaining, "--approval-mode");
    const installAssets = takeFlag(remaining, "--install-assets");
    if (approvalMode !== undefined) {
      validateChoice(
        approvalMode,
        ["prompt", "allow-all"],
        "--approval-mode",
      );
    }
    requireNoArgs(remaining);
    return {
      command,
      json,
      repository,
      path: setupPath,
      projectOwner,
      projectTitle,
      approvalMode,
      ...(installAssets ? { installAssets: true } : {}),
    };
  }

  if (command === "assets") {
    const operation = remaining.shift();
    if (!["install", "status", "repair"].includes(operation)) {
      throw new TypeError(
        "Usage: pan assets <install|status|repair> [--force] [--json]",
      );
    }
    const force = takeFlag(remaining, "--force");
    if (force && operation !== "repair") {
      throw new TypeError("--force is only supported by pan assets repair");
    }
    requireNoArgs(remaining);
    return { command, operation, force, json };
  }

  const retirement = retiredCommand(command, json);
  if (retirement) {
    throw retirement;
  }
  if (remaining.includes("--background") || remaining.includes("--no-terminal")) {
    throw retiredCommandError(
      "--background",
      json,
      "PAN sessions run in the foreground. Run pan session --config <path>, then exit that session to stop it.",
    );
  }
  if (config && profile) {
    throw new TypeError(
      "PAN domain config and runner profile inputs cannot be used together",
    );
  }
  if (!config) {
    throw new TypeError(
      `pan ${command ?? "<command>"} requires --config <domain-config.json> or PAN_CONFIG. --profile and PAN_PROFILE belong to pan-runner.`,
    );
  }
  if (!["session", "review"].includes(command)) {
    throw new TypeError(usage());
  }
  if (command === "session") {
    requireNoArgs(remaining);
    return { command, ...configuration, json };
  }
  const apply = takeFlag(remaining, "--apply");
  requireNoArgs(remaining);
  return { command, ...configuration, json, apply };
}

function normalizeLegacyAttentionAlias(args) {
  const [command, ...remaining] = args;
  const operation = {
    inbox: "list",
    answer: "answer",
    add: "add",
  }[command];
  if (!operation) {
    return { args };
  }
  return {
    args: ["attention", operation, ...remaining, "--schema-version", "1"],
    guidance: `Deprecated: pan ${command} is an alias for pan attention ${operation} --schema-version 1. Update scripts to use the attention command.`,
  };
}

function retiredCommand(command, json) {
  const guidance = {
    start:
      "Run pan session --config <path> in the foreground; PAN no longer starts a host or background process.",
    stop:
      "PAN sessions are foreground processes. Exit the running pan session, then rerun pan session --config <path> when needed.",
    host:
      "Run pan session --config <path> in the foreground; PAN no longer runs a host or bridge.",
    connect:
      "Run pan session --config <path> and use that ordinary interactive Copilot session.",
    daemon:
      "Run pan session --config <path>. After domain, session, or scheduling changes, exit and rerun that session; restart pan-runner only after runner changes.",
    chat:
      "Run pan session --config <path> and ask in the ordinary interactive session. Use pan review for a one-shot review.",
  }[command];
  return guidance ? retiredCommandError(command, json, guidance) : undefined;
}

function retiredCommandError(command, json, guidance) {
  const error = new TypeError(`pan ${command} is retired. ${guidance}`);
  if (json) {
    error.result = {
      version: 1,
      status: "retired",
      command,
      replacement: "pan session --config <path>",
      guidance: [guidance],
    };
  }
  return error;
}

export function parsePanHelperArgs(
  args,
  { env = process.env, handlers = {} } = {},
) {
  const [family, operation, ...remaining] = args;
  const families = [
    "evidence",
    "project",
    "action",
    "leadership",
    "attention",
    "reconcile",
    "workstream",
    "config",
  ];
  if (!families.includes(family)) {
    return undefined;
  }
  if (!operation || operation.startsWith("--")) {
    throw new TypeError(`pan ${family} requires an operation`);
  }
  const handler = handlers[family]?.[operation];
  if (typeof handler !== "function") {
    throw new TypeError(`Unknown PAN ${family} operation: ${operation}`);
  }
  const specification = handler.specification ?? {};
  const allowedOptions = new Set(specification.options ?? []);
  const allowedFlags = new Set(specification.flags ?? []);
  const repeatableOptions = new Set(specification.repeatableOptions ?? []);
  const requiredOptions = specification.requiredOptions ?? [];
  const positionalNames = specification.positionals ?? [];
  const options = {};
  let positionalIndex = 0;
  let json = false;
  let config = env.PAN_CONFIG;
  let schemaVersion;
  for (let index = 0; index < remaining.length; index += 1) {
    const token = remaining[index];
    if (!token.startsWith("--")) {
      const name = positionalNames[positionalIndex++];
      if (!name) {
        throw new TypeError(
          `Unexpected positional argument for pan ${family} ${operation}: ${token}`,
        );
      }
      options[name] = token;
      continue;
    }
    if (token === "--json") {
      if (json) {
        throw new TypeError("--json may only be specified once");
      }
      json = true;
      continue;
    }
    const name = token.slice(2);
    if (name === "config") {
      if (config !== env.PAN_CONFIG && config !== undefined) {
        throw new TypeError("--config may only be specified once");
      }
      const value = remaining[++index];
      if (!value || value.startsWith("--")) {
        throw new TypeError("--config requires a value");
      }
      config = value;
      continue;
    }
    if (name === "schema-version") {
      if (schemaVersion !== undefined) {
        throw new TypeError("--schema-version may only be specified once");
      }
      const value = remaining[++index];
      if (value !== "1") {
        throw new TypeError("Unsupported PAN command schema version");
      }
      schemaVersion = 1;
      continue;
    }
    if (allowedFlags.has(name)) {
      if (Object.hasOwn(options, name)) {
        throw new TypeError(`--${name} may only be specified once`);
      }
      options[name] = true;
      continue;
    }
    if (allowedOptions.has(name) || repeatableOptions.has(name)) {
      if (Object.hasOwn(options, name) && !repeatableOptions.has(name)) {
        throw new TypeError(`--${name} may only be specified once`);
      }
      const value = remaining[++index];
      if (!value || value.startsWith("--")) {
        throw new TypeError(`--${name} requires a value`);
      }
      if (repeatableOptions.has(name)) {
        (options[name] ??= []).push(value);
      } else {
        options[name] = value;
      }
      continue;
    }
    throw new TypeError(`Unknown option for pan ${family} ${operation}: --${name}`);
  }
  if (schemaVersion === undefined) {
    throw new TypeError("PAN helper commands require --schema-version 1");
  }
  if (!config) {
    throw new TypeError("PAN helper commands require --config or PAN_CONFIG");
  }
  if (positionalIndex !== positionalNames.length) {
    throw new TypeError(
      `pan ${family} ${operation} requires ${positionalNames
        .slice(positionalIndex)
        .map((name) => `<${name}>`)
        .join(" ")}`,
    );
  }
  for (const name of requiredOptions) {
    if (!Object.hasOwn(options, name)) {
      throw new TypeError(`pan ${family} ${operation} requires --${name}`);
    }
  }
  return { family, operation, config, json, options, schemaVersion };
}

async function runPanHelperCommand(
  parsed,
  { stdout, env, commandContextFactory, commandHandlers },
) {
  const context = await commandContextFactory({
    configPath: parsed.config,
    env,
  });
  const handler = commandHandlers[parsed.family][parsed.operation];
  const details = {
    operation: `${parsed.family}.${parsed.operation}`,
    domain: {
      repository: context.domain.repository,
      projectOwner: context.domain.projectOwner,
      projectNumber: context.domain.projectNumber,
    },
  };
  let result;
  try {
    result = validatePanCommandResult(
      await handler({ context, options: parsed.options }),
    );
    if (result.operation !== details.operation) {
      throw new TypeError(
        `Helper result operation must be ${details.operation}`,
      );
    }
  } catch (error) {
    throw new PanCommandError(
      `PAN helper ${details.operation} failed`,
      commandResultFromError(error, details),
      { cause: error },
    );
  }
  if (result.status !== "confirmed") {
    throw new PanCommandError(
      `PAN helper ${details.operation} did not confirm the requested outcome`,
      result,
    );
  }
  write(
    stdout,
    parsed.json
      ? JSON.stringify(result)
      : `${result.operation}: ${result.confirmedEffects.join("; ") || "confirmed"}`,
  );
  return result;
}

async function loadCliConfiguration(
  parsed,
  { domainConfigLoader },
) {
  const config = await domainConfigLoader(parsed.config);
  const agent = config.session?.agent ?? config.agent;
  const scheduling = config.scheduling ?? {};
  const leadership = config.leadership ?? {};
  return {
    domainConfig: config,
    store: {
      repository: config.domain.repository,
      projectOwner: config.domain.projectOwner,
      projectNumber: config.domain.projectNumber,
      path: config.domain.path,
    },
    runtime: {
      machine: "pan-runtime",
      pollIntervalSeconds:
        scheduling.retrySeconds ?? config.cadences?.activePollSeconds ?? 60,
      leaderLeaseSeconds:
        leadership.leaseSeconds ?? config.cadences?.leaderLeaseSeconds ?? 120,
      leaderHeartbeatSeconds:
        leadership.heartbeatSeconds ??
        config.cadences?.leaderHeartbeatSeconds ??
        30,
      stateBranch: config.state.branch,
      leaderPath: config.state.leaderPath,
      runnerProfileDirectory: path.join(config.domain.path, "runners"),
    },
    agent,
    reviewPolicy: config.reviewPolicy,
    attention: config.attention,
  };
}

function createReviewService({ store, attention, configuration, env }) {
  return createDomainServices({
    store,
    attention,
    configuration,
    env,
  }).reviewService;
}

function createDomainServices({
  store,
  attention,
  configuration,
  env,
  reviewServiceFactory,
}) {
  const runnerSource = new RunnerProfileSource({
    directory: configuration.runtime.runnerProfileDirectory,
  });
  const workstreamSource = new WorkstreamStore({
    repositoryPath: configuration.store.path,
  });
  const snapshotSource = new PortfolioSnapshotBuilder({
    projectSource: store,
    issueCatalogSource: store,
    workstreamSource,
    runnerSource,
  });
  const actionPolicy = new ActionPolicy({
    approvalRequired: configuration.reviewPolicy?.higherRisk.enabled
      ? configuration.reviewPolicy.higherRisk.actionKinds
      : [],
  });
  const reviewService =
    reviewServiceFactory?.({
      store,
      configuration,
      env,
      snapshotSource,
      actionPolicy,
      attention,
    }) ??
    new PanReviewService({
      snapshotSource,
      store,
      attention,
      actionPolicy,
      agentClient: new PanAgentClient({
        executable: configuration.agent.executable,
        agent: configuration.agent.name,
        model: configuration.agent.model,
        timeout: configuration.agent.turnTimeoutSeconds
          ? configuration.agent.turnTimeoutSeconds * 1_000
          : undefined,
        cwd: TOOL_ROOT,
        env,
        inlinePortfolio: true,
        extraArgs:
          configuration.agent.maxAiCredits === undefined
            ? []
            : [
                "--max-ai-credits",
                String(configuration.agent.maxAiCredits),
              ],
      }),
    });
  return { reviewService };
}

function createLeaderLease({ configuration, gh, pid }) {
  return new LeaderLease({
    stateFile: new GitHubStateFile({
      gh,
      repository: configuration.store.repository,
      branch: configuration.runtime.stateBranch,
      filePath: configuration.runtime.leaderPath,
    }),
    holder: `${configuration.runtime.machine}/pan-${pid}`,
    machine: configuration.runtime.machine,
    pid,
    leaseSeconds: configuration.runtime.leaderLeaseSeconds,
  });
}

function formatReasoningResult(result) {
  const lines = [result.response.recommendation];
  if (result.response.appliedActions.length > 0) {
    lines.push(
      "",
      ...result.response.appliedActions.map(
        (action) => `Applied: ${action.summary}`,
      ),
    );
  }

  if (result.response.rejectedActions.length > 0) {
    lines.push(
      "",
      ...result.response.rejectedActions.map(
        (action) => `Not applied: ${action.reason}`,
      ),
    );
  }
  if (result.response.effects?.incomplete?.length > 0) {
    lines.push(
      "",
      ...result.response.effects.incomplete.map(
        (effect) => `INCOMPLETE: ${effect.summary}`,
      ),
    );
  }
  if (!result.applied && result.response.proposedActions.length > 0) {
    lines.push(
      "",
      `${result.response.proposedActions.length} proposed action(s); rerun with --apply to apply them.`,
    );
  }
  return lines.join("\n");
}

function formatSetupResult(result) {
  const lines = [
    `PAN domain ready: ${result.repository}`,
    `Clone: ${result.directory}`,
    `Project: ${result.projectUrl ?? `${result.projectOwner}#${result.projectNumber}`}`,
    `Config: ${result.configPath}`,
    `Runner profile: ${result.runnerProfilePath} (offline)`,
    `Copilot approvals: ${result.approvalMode}`,
  ];
  if (result.assets) {
    lines.push(`PAN assets: ${result.assets.status}`);
    lines.push(...(result.assets.diagnostics ?? []));
  }
  return lines.join("\n");
}

function formatAssetResult(result) {
  const lines = [`PAN assets: ${result.status}`];
  for (const asset of result.assets) {
    lines.push(`${asset.status}: ${asset.destination}`);
  }
  for (const shadow of result.shadows) {
    lines.push(`shadowed: ${shadow.path}`);
  }
  return lines.join("\n");
}

function takeFlag(args, name) {
  const index = args.indexOf(name);
  if (index === -1) {
    return false;
  }
  args.splice(index, 1);
  return true;
}

function takeOption(args, name) {
  const values = takeOptions(args, name);
  if (values.length > 1) {
    throw new TypeError(`${name} may only be specified once`);
  }
  return values[0];
}

function takeOptions(args, name) {
  const values = [];
  for (let index = 0; index < args.length; ) {
    if (args[index] !== name) {
      index += 1;
      continue;
    }
    if (!args[index + 1]) {
      throw new TypeError(`${name} requires a value`);
    }
    values.push(args[index + 1]);
    args.splice(index, 2);
  }
  return values;
}

function validateChoice(value, choices, option) {
  if (!choices.includes(value)) {
    throw new TypeError(`${option} must be one of ${choices.join(", ")}`);
  }
}

function requireNoArgs(args) {
  if (args.length > 0) {
    throw new TypeError(`Unexpected arguments: ${args.join(" ")}`);
  }
}

function write(stdout, value) {
  stdout.write(`${value}\n`);
}

function usage() {
  return [
    "Usage:",
    "  pan setup [--repository <owner/name>] [--path <path>] [--approval-mode <prompt|allow-all>] [--install-assets]",
    "  pan assets <install|status|repair> [--force] [--json]",
    "  pan session --config <path>",
    "  pan review [--apply] [--json] --config <path>",
    "  pan attention <list|answer|add> --schema-version 1 --config <path>",
    "  Session, domain, or scheduling changes: exit and rerun pan session; runner changes: restart pan-runner.",
    "  pan leadership <status|acquire|assert|renew|release> --schema-version 1 --config <path>",
    "  pan reconcile <missing-issues|merged-prs> [--apply] --schema-version 1 --config <path>",
  ].join("\n");
}
