import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";

import { AttentionService } from "./attention-service.js";
import { ActionPolicy } from "./action-policy.js";
import { createPanCommandContext } from "./pan-command-context.js";
import {
  commandResultFromError,
  PanCommandError,
  validatePanCommandResult,
} from "./pan-command-result.js";
import { loadDomainConfig } from "./domain-config.js";
import { GhClient } from "./gh-client.js";
import { GitHubStateFile, LeaderLease } from "./leader-lease.js";
import { PanAgentClient } from "./pan-agent-client.js";
import { PanDaemon } from "./pan-daemon.js";
import { PanHost } from "./pan-host.js";
import {
  connectPan,
  preparePanRuntime,
  startPan,
  stopPan,
} from "./pan-launcher.js";
import { PanReviewService } from "./pan-review-service.js";
import { PanRepairService } from "./pan-repair-service.js";
import { PanRuntime } from "./pan-runtime.js";
import { setupPanDomain } from "./pan-setup.js";
import { PanStore } from "./pan-store.js";
import { PortfolioSnapshotBuilder } from "./portfolio-snapshot.js";
import { PanToolRegistry } from "./pan-tools.js";
import { loadRunnerProfile } from "./runner-profile.js";
import { RunnerProfileSource } from "./runner-profile-source.js";
import { WorkstreamStore } from "./workstream-store.js";
import { createServiceLogger } from "./service-logger.js";

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
    runnerProfileLoader = loadRunnerProfile,
    storeFactory = (options) => new PanStore(options),
    attentionFactory = (options) => new AttentionService(options),
    toolRegistryFactory = (options) => new PanToolRegistry(options),
    reviewServiceFactory,
    repairServiceFactory,
    runtimeFactory = (options) => new PanRuntime(options),
    hostFactory = (options) => new PanHost(options),
    startFactory = startPan,
    stopFactory = stopPan,
    connectFactory = connectPan,
    prepareRuntimeFactory = preparePanRuntime,
    setupFactory = setupPanDomain,
    loggerFactory = createServiceLogger,
    hostname = os.hostname(),
    runnerProfileSourceFactory = (options) => new RunnerProfileSource(options),
    commandContextFactory = createPanCommandContext,
    commandHandlers = {},
  } = {},
) {
  const helper = parsePanHelperArgs(args, { env, handlers: commandHandlers });
  if (helper) {
    return runPanHelperCommand(helper, {
      stdout,
      env,
      commandContextFactory,
      commandHandlers,
    });
  }
  const parsed = parseArgs(args, env);
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
  if (parsed.command === "stop") {
    requireDomainConfiguration(parsed);
    const result = await stopFactory({ configPath: parsed.config, env });
    write(stdout, JSON.stringify(result, null, 2));
    return result;
  }
  const configuration = await loadCliConfiguration(parsed, {
    domainConfigLoader,
    runnerProfileLoader,
  });
  if (configuration.deprecated) {
    write(
      stderr,
      "Warning: --profile and PAN_PROFILE are deprecated for PAN commands; use --config or PAN_CONFIG.",
    );
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

  if (parsed.command === "start" && parsed.background) {
    requireDomainConfiguration(parsed);
    const terminalProfile = parsed.noTerminal
      ? undefined
      : await resolveTerminalProfile({
          directory: configuration.runtime.runnerProfileDirectory,
          machine: hostname,
          runnerProfileSourceFactory,
        });
    const result = await startFactory({
      configPath: parsed.config,
      toolRoot: TOOL_ROOT,
      autonomousApply: parsed.apply,
      openTerminal: !parsed.noTerminal,
      agentName: configuration.agent.name,
      model: configuration.agent?.model,
      terminalProfile,
      env,
    });
    write(stdout, JSON.stringify(result, null, 2));
    return result;
  }

  if (parsed.command === "connect") {
    requireDomainConfiguration(parsed);
    const model = parsed.model ?? configuration.agent?.model;
    write(
      stdout,
      `Connecting PAN chat with model ${model ?? "auto"}; use /model to inspect or change it.`,
    );
    return connectFactory({
      configPath: parsed.config,
      toolRoot: TOOL_ROOT,
      executable: configuration.agent?.executable ?? "copilot",
      agentName: configuration.agent.name,
      model,
      env,
    });
  }
  if (parsed.command === "start" || parsed.command === "host") {
    requireDomainConfiguration(parsed);
    const paths = await prepareRuntimeFactory({
      configPath: parsed.config,
      toolRoot: TOOL_ROOT,
      stateFile: parsed.stateFile,
      env,
    });
    const services = createDomainServices({
      store,
      attention,
      configuration,
      env,
      reviewServiceFactory,
      repairServiceFactory,
      toolRegistryFactory,
    });
    const logger = await loggerFactory({
      name: "PAN host",
      logFile: parsed.stateFile ? undefined : paths.logFile,
    });
    const controller = new AbortController();
    process.once("SIGINT", () => controller.abort());
    process.once("SIGTERM", () => controller.abort());
    logger.info(
      `Starting in the foreground with model ${configuration.agent?.model ?? "auto"}; press Ctrl+C to stop.`,
    );
    logger.info(`Activity log: ${paths.logFile}`);
    const machineProfile = await resolveMachineRunnerProfile({
      directory: configuration.runtime.runnerProfileDirectory,
      machine: hostname,
      runnerProfileSourceFactory,
    });
    try {
      return await hostFactory({
        reviewService: services.reviewService,
        toolRegistry: services.toolRegistry,
        leaderLease: createLeaderLease({
          configuration,
          gh,
          pid,
        }),
        stateFile: paths.stateFile,
        token: randomUUID(),
        pollIntervalSeconds: configuration.runtime.pollIntervalSeconds,
        heartbeatSeconds: configuration.runtime.leaderHeartbeatSeconds,
        autonomousApply: parsed.apply,
        repairService: services.repairService,
        taskStore: store,
        model: configuration.agent?.model,
        configPath: parsed.config,
        runnerProfilePath: machineProfile?.profilePath,
        logger,
      }).run({ signal: controller.signal });
    } finally {
      logger.info("Stopped.");
      await logger.close();
    }
  }
  if (parsed.command === "inbox") {
    const entries = await attention.inbox();
    write(stdout, parsed.json ? JSON.stringify(entries, null, 2) : inboxTable(entries));
    return entries;
  }
  if (parsed.command === "answer") {
    const item = await attention.answer(parsed.identifier, parsed.text);
    const result = { id: item.number ?? item.id, issueUrl: item.url };
    write(stdout, parsed.json ? JSON.stringify(result, null, 2) : item.url);
    return result;
  }
  if (parsed.command === "add") {
    const body = parsed.bodyFile
      ? await readFile(path.resolve(parsed.bodyFile), "utf8")
      : parsed.body;
    const item = await attention.add({ ...parsed, body });
    const result = { id: item.number ?? item.id, issueUrl: item.url };
    write(stdout, parsed.json ? JSON.stringify(result, null, 2) : item.url);
    return result;
  }
  if (parsed.command === "review" || parsed.command === "chat") {
    const reviewService =
      reviewServiceFactory?.({ store, configuration, env }) ??
      createReviewService({ store, configuration, env });
    const userInput = parsed.command === "chat" ? parsed.text : undefined;
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
          }).runOnce({ userInput })
        : await reviewService.run({
            apply: false,
            ...(userInput ? { userInput } : {}),
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
  if (parsed.command === "daemon") {
    const leaderLease = createLeaderLease({
      configuration,
      gh,
      pid,
    });
    const daemon = parsed.config
      ? runtimeFactory({
          reviewService:
            reviewServiceFactory?.({ store, configuration, env }) ??
            createReviewService({ store, configuration, env }),
          leaderLease,
          pollIntervalSeconds: configuration.runtime.pollIntervalSeconds,
          heartbeatSeconds: configuration.runtime.leaderHeartbeatSeconds,
        })
      : new PanDaemon({
          store,
          leaderLease,
          profileSource: new RunnerProfileSource({
            directory: configuration.runtime.runnerProfileDirectory,
          }),
          pollIntervalSeconds: configuration.runtime.pollIntervalSeconds,
          leaderHeartbeatSeconds: configuration.runtime.leaderHeartbeatSeconds,
        });
    if (parsed.once) {
      const result = await daemon.runOnce();
      write(stdout, JSON.stringify(result, null, 2));
      return result;
    }
    const controller = new AbortController();
    process.once("SIGINT", () => controller.abort());
    process.once("SIGTERM", () => controller.abort());
    return daemon.run({ signal: controller.signal });
  }
  throw new Error(`Unknown PAN command: ${parsed.command}`);
}

async function resolveMachineRunnerProfile({
  directory,
  machine,
  runnerProfileSourceFactory,
}) {
  const profiles = await runnerProfileSourceFactory({ directory }).load();
  const matches = profiles.filter(
    (profile) => profile.machine.toLowerCase() === machine.toLowerCase(),
  );
  if (matches.length > 1) {
    throw new Error(
      `Multiple runner profiles match this machine (${machine}); keep exactly one profile per machine`,
    );
  }
  return matches[0];
}

async function resolveTerminalProfile({
  directory,
  machine,
  runnerProfileSourceFactory,
}) {
  const profile = await resolveMachineRunnerProfile({
    directory,
    machine,
    runnerProfileSourceFactory,
  });
  return profile?.terminal.profile;
}

export function parseArgs(args, env = process.env) {
  const remaining = [...args];
  const config = takeOption(remaining, "--config") ?? env.PAN_CONFIG;
  const profile = takeOption(remaining, "--profile") ?? env.PAN_PROFILE;
  if (config && profile) {
    throw new TypeError(
      "PAN domain config and runner profile inputs cannot be used together",
    );
  }

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
    };
  }

  if (!config && !profile) {
    throw new TypeError(
      "Set PAN_CONFIG or pass --config <domain-config.json> (legacy: PAN_PROFILE or --profile)",
    );
  }
  if (
    ![
      "start",
      "stop",
      "host",
      "connect",
      "daemon",
      "review",
      "chat",
      "inbox",
      "answer",
      "add",
    ].includes(command)
  ) {
    throw new TypeError(usage());
  }
  if (command === "start") {
    const apply = takeFlag(remaining, "--apply");
    const noTerminal = takeFlag(remaining, "--no-terminal");
    const background = takeFlag(remaining, "--background");
    if (noTerminal && !background) {
      throw new TypeError("--no-terminal requires --background");
    }
    requireNoArgs(remaining);
    return {
      command,
      ...configuration,
      apply,
      noTerminal,
      background,
    };
  }
  if (command === "stop") {
    requireNoArgs(remaining);
    return { command, ...configuration };
  }
  if (command === "host") {
    const apply = takeFlag(remaining, "--apply");
    const stateFile = takeOption(remaining, "--state-file");
    requireNoArgs(remaining);
    return { command, ...configuration, apply, stateFile };
  }
  if (command === "connect") {
    const model = takeOption(remaining, "--model");
    requireNoArgs(remaining);
    return { command, ...configuration, model };
  }
  if (command === "daemon") {
    const once = takeFlag(remaining, "--once");
    requireNoArgs(remaining);
    return { command, ...configuration, once };
  }
  if (command === "inbox") {
    requireNoArgs(remaining);
    return { command, ...configuration, json };
  }
  if (command === "review") {
    const apply = takeFlag(remaining, "--apply");
    requireNoArgs(remaining);
    return { command, ...configuration, json, apply };
  }
  if (command === "chat") {
    const dryRun = takeFlag(remaining, "--dry-run");
    const text = remaining.join(" ").trim();
    if (!text) {
      throw new TypeError("Usage: pan chat <message> [--dry-run] [--json]");
    }
    return {
      command,
      ...configuration,
      json,
      apply: !dryRun,
      text,
    };
  }
  if (command === "answer") {
    const [identifier, text, ...extra] = remaining;
    if (!identifier || !text || extra.length > 0) {
      throw new TypeError("Usage: pan answer <id> <text> [--json]");
    }
    return { command, ...configuration, json, identifier, text };
  }

  const body = takeOption(remaining, "--body") ?? "";
  const bodyFile = takeOption(remaining, "--body-file");
  if (body && bodyFile) {
    throw new TypeError("--body and --body-file cannot be used together");
  }
  const workstream = takeOption(remaining, "--workstream");
  const owner = takeOption(remaining, "--owner") ?? "unassigned";
  const priority = takeOption(remaining, "--priority") ?? "normal";
  const autonomy = takeOption(remaining, "--autonomy") ?? "manual";
  const requirements = takeOptions(remaining, "--requirement");
  requirements.push(
    ...takeOptions(remaining, "--repo").map((repository) => `repo:${repository}`),
  );
  const title = remaining.shift();
  requireNoArgs(remaining);
  if (!title?.trim()) {
    throw new TypeError("Usage: pan add <title> [options]");
  }
  validateChoice(owner, ["unassigned", "human", "agent"], "--owner");
  validateChoice(priority, ["urgent", "high", "normal", "low"], "--priority");
  validateChoice(
    autonomy,
    ["manual", "full-auto", "agent-reviewer"],
    "--autonomy",
  );
  return {
    command,
    ...configuration,
    json,
    title,
    body,
    bodyFile,
    workstream,
    owner,
    priority,
    autonomy,
    requirements: [...new Set(requirements)],
  };
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
  const options = {};
  let json = false;
  let config = env.PAN_CONFIG;
  let schemaVersion;
  for (let index = 0; index < remaining.length; index += 1) {
    const token = remaining[index];
    if (!token.startsWith("--")) {
      throw new TypeError(
        `Unexpected positional argument for pan ${family} ${operation}: ${token}`,
      );
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
    if (allowedOptions.has(name)) {
      if (Object.hasOwn(options, name)) {
        throw new TypeError(`--${name} may only be specified once`);
      }
      const value = remaining[++index];
      if (!value || value.startsWith("--")) {
        throw new TypeError(`--${name} requires a value`);
      }
      options[name] = value;
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
    domain: context.domain,
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
  { domainConfigLoader, runnerProfileLoader },
) {
  if (parsed.config) {
    const config = await domainConfigLoader(parsed.config);
    const agent = config.session?.agent ?? config.agent;
    const scheduling = config.scheduling ?? {};
    const leadership = config.leadership ?? {};
    return {
      deprecated: false,
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
      selfRepair: config.selfRepair,
      attention: config.attention,
    };
  }

  const profile = await runnerProfileLoader(parsed.profile);
  const leaderLeaseSeconds = Math.max(
    120,
    profile.pollIntervalSeconds * 4,
  );
  return {
    deprecated: true,
    store: profile.store,
    runtime: {
      machine: profile.machine,
      pollIntervalSeconds: profile.pollIntervalSeconds,
      leaderLeaseSeconds,
      leaderHeartbeatSeconds: Math.min(30, leaderLeaseSeconds / 3),
      stateBranch: undefined,
      leaderPath: undefined,
      runnerProfileDirectory: path.join(profile.store.path, "runners"),
    },
    agent: {
      name: "pan",
      executable: "copilot",
      model: undefined,
      turnTimeoutSeconds: undefined,
      maxAiCredits: undefined,
    },
    selfRepair: {
      enabled: false,
      repository: undefined,
      workstream: undefined,
      requirements: [],
    },
    attention: {
      assignee: undefined,
    },
  };
}

function createReviewService({ store, configuration, env }) {
  return createDomainServices({
    store,
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
  repairServiceFactory = (options) => new PanRepairService(options),
  toolRegistryFactory = (options) => new PanToolRegistry(options),
}) {
  const runnerSource = new RunnerProfileSource({
    directory: configuration.runtime.runnerProfileDirectory,
  });
  const workstreamSource = new WorkstreamStore({
    repositoryPath: configuration.store.path,
  });
  const snapshotSource = new PortfolioSnapshotBuilder({
    projectSource: store,
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
  const repairService = configuration.selfRepair?.enabled
    ? repairServiceFactory({
        store,
        policy: configuration.selfRepair,
      })
    : undefined;
  return {
    reviewService,
    repairService,
    toolRegistry: toolRegistryFactory({
      domain: {
        repository: configuration.store.repository,
        projectOwner: configuration.store.projectOwner,
        projectNumber: configuration.store.projectNumber,
        path: configuration.store.path,
      },
      snapshotSource,
      projectSource: store,
      workstreamSource,
      runnerSource,
      attentionSource: attention,
      actionPolicy,
    }),
  };
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

function requireDomainConfiguration(parsed) {
  if (!parsed.config) {
    throw new TypeError(
      `pan ${parsed.command} requires --config or PAN_CONFIG`,
    );
  }
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
  return [
    `PAN domain ready: ${result.repository}`,
    `Clone: ${result.directory}`,
    `Project: ${result.projectUrl ?? `${result.projectOwner}#${result.projectNumber}`}`,
    `Config: ${result.configPath}`,
    `Runner profile: ${result.runnerProfilePath} (offline)`,
    `Copilot approvals: ${result.approvalMode}`,
  ].join("\n");
}

function inboxTable(entries) {
  if (entries.length === 0) {
    return "Inbox is empty.";
  }
  const rows = [
    ["ID", "Kind", "Priority", "Title", "Location"],
    ...entries.map((entry) => [
      String(entry.id),
      entry.kind,
      entry.priority,
      entry.title,
      entry.pullRequestUrl ??
        entry.locator?.localUrl ??
        entry.locator?.terminalTitle ??
        entry.issueUrl,
    ]),
  ];
  const widths = rows[0].map((_, column) =>
    Math.max(...rows.map((row) => String(row[column] ?? "").length)),
  );
  return rows
    .map((row, index) => {
      const line = row
        .map((cell, column) => String(cell ?? "").padEnd(widths[column]))
        .join("  ")
        .trimEnd();
      return index === 0
        ? `${line}\n${widths.map((width) => "-".repeat(width)).join("  ")}`
        : line;
    })
    .join("\n");
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
    "  pan setup [--repository <owner/name>] [--path <path>] [--approval-mode <prompt|allow-all>]",
    "  pan start [--apply] --config <path>",
    "  pan start --background [--no-terminal] [--apply] --config <path>",
    "  pan stop --config <path>",
    "  pan connect [--model <id>] --config <path>",
    "  pan daemon [--once] --config <path>",
    "  pan review [--apply] [--json] --config <path>",
    "  pan chat <message> [--dry-run] [--json] --config <path>",
    "  pan inbox [--json] --config <path>",
    "  pan answer <id> <text> [--json] --config <path>",
    "  pan add <title> [options] --config <path>",
  ].join("\n");
}
