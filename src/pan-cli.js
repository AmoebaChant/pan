
import { PanAssetService } from "./pan-assets.js";
import {
  commandResultFromError,
  PanCommandError,
  validatePanCommandResult,
} from "./pan-command-result.js";
import { createPanCommandContext } from "./pan-command-context.js";
import { loadDomainConfig } from "./domain-config.js";
import { GhClient } from "./gh-client.js";
import { createLeadershipCommandHandlers } from "./leadership-commands.js";
import { createActionCommandHandlers } from "./action-commands.js";
import { createEvidenceCommandHandlers } from "./evidence-commands.js";
import { createAttentionCommandHandlers } from "./attention-commands.js";
import { createReconciliationCommandHandlers } from "./reconciliation-commands.js";
import { createWorkstreamCommandHandlers } from "./workstream-commands.js";
import { createConfigCommandHandlers } from "./config-commands.js";
import { startPanOnboarding } from "./pan-onboarding.js";
import { createPanDesktopShortcuts } from "./pan-shortcuts.js";
import { startPanSession } from "./pan-session.js";
import { setupPanDomain } from "./pan-setup.js";
import { assertMatchingDomain, verifyPanSetup } from "./pan-verification.js";
import { loadRunnerProfile } from "./runner-profile.js";

export async function runPanCli(
  args,
  {
    env = process.env,
    stdout = process.stdout,
    stderr = process.stderr,
    gh = new GhClient(),
    domainConfigLoader = loadDomainConfig,
    runnerProfileLoader = loadRunnerProfile,
    onboardingFactory = startPanOnboarding,
    sessionFactory = startPanSession,
    setupFactory = setupPanDomain,
    shortcutFactory = createPanDesktopShortcuts,
    verificationFactory = verifyPanSetup,
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
      config: createConfigCommandHandlers(),
    };
  const helper = parsePanHelperArgs(args, { env, handlers: helpers });
  if (helper) {
    return runPanHelperCommand(helper, {
      stdout,
      env,
      commandContextFactory,
      commandHandlers: helpers,
    });
  }
  const parsed = parseArgs(args, env);
  if (parsed.command === "onboard") {
    const result = await onboardingFactory({ env });
    if (parsed.json) {
      write(stdout, JSON.stringify(result, null, 2));
    }
    return result;
  }
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
  if (parsed.command === "verify") {
    const domainConfig = await domainConfigLoader(parsed.config);
    const result = await verificationFactory({
      config: domainConfig,
      configPath: parsed.config,
      runnerProfilePath: parsed.profile,
      env,
    });
    write(
      stdout,
      parsed.json ? JSON.stringify(result, null, 2) : formatVerificationResult(result),
    );
    return result;
  }
  if (parsed.command === "shortcuts") {
    const [domainConfig, runnerProfile] = await Promise.all([
      domainConfigLoader(parsed.config),
      runnerProfileLoader(parsed.profile),
    ]);
    assertMatchingDomain(domainConfig, runnerProfile, {
      configPath: parsed.config,
      requireConfigPath: true,
    });
    const result = await shortcutFactory({
      configPath: parsed.config,
      runnerProfilePath: parsed.profile,
      domainPath: domainConfig.domain.path,
      selection: parsed.selection,
      desktopPath: parsed.desktopPath,
      env,
    });
    write(
      stdout,
      parsed.json ? JSON.stringify(result, null, 2) : formatShortcutResult(result),
    );
    return result;
  }
  const domainConfig = await domainConfigLoader(parsed.config);
  if (parsed.command === "session") {
    const agent = domainConfig.session?.agent ?? domainConfig.agent;
    const result = await sessionFactory({
      config: domainConfig,
      configPath: parsed.config,
      executable: agent?.executable,
      model: agent?.model,
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

  throw new Error(`Unknown PAN command: ${parsed.command}`);
}

export function parseArgs(args, env = process.env) {
  const remaining = [...args];
  const config = takeOption(remaining, "--config") ?? env.PAN_CONFIG;
  const profile = takeOption(remaining, "--profile") ?? env.PAN_PROFILE;
  const configuration = { config, profile };
  const json = takeFlag(remaining, "--json");
  const command = remaining.shift();
  if (command === "onboard") {
    if (config || profile) {
      throw new TypeError(
        "pan onboard creates configuration and cannot use --config, --profile, PAN_CONFIG, or PAN_PROFILE",
      );
    }
    requireNoArgs(remaining);
    return { command, json };
  }
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
    const projectNumber = optionalPositiveInteger(
      takeOption(remaining, "--project-number"),
      "--project-number",
    );
    const repositoryMode = takeOption(remaining, "--repository-mode");
    const projectMode = takeOption(remaining, "--project-mode");
    const approvalMode = takeOption(remaining, "--approval-mode");
    const installAssets = takeFlag(remaining, "--install-assets");
    if (repositoryMode !== undefined) {
      validateChoice(
        repositoryMode,
        ["create", "connect"],
        "--repository-mode",
      );
    }
    if (projectMode !== undefined) {
      validateChoice(projectMode, ["create", "connect"], "--project-mode");
    }
    if (approvalMode !== undefined) {
      validateChoice(
        approvalMode,
        ["prompt", "allow-all"],
        "--approval-mode",
      );
    }
    if (projectMode === "connect" && projectNumber === undefined) {
      throw new TypeError("--project-mode connect requires --project-number");
    }
    if (projectMode === "create" && projectNumber !== undefined) {
      throw new TypeError("--project-number cannot be used with --project-mode create");
    }
    if (projectNumber !== undefined && projectTitle !== undefined) {
      throw new TypeError("--project-number and --project-title cannot be used together");
    }
    requireNoArgs(remaining);
    return {
      command,
      json,
      repository,
      path: setupPath,
      projectOwner,
      projectTitle,
      projectNumber,
      repositoryMode,
      projectMode,
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
  if (command === "verify") {
    if (!config || !profile) {
      throw new TypeError(
        "pan verify requires --config <domain-config.json> and --profile <runner-profile.json>",
      );
    }
    requireNoArgs(remaining);
    return { command, config, profile, json };
  }
  if (command === "shortcuts") {
    const operation = remaining.shift();
    if (operation !== "create") {
      throw new TypeError(
        "Usage: pan shortcuts create --config <path> --profile <path> --selection <chat|runner|both>",
      );
    }
    if (!config || !profile) {
      throw new TypeError(
        "pan shortcuts create requires --config <path> and --profile <path>",
      );
    }
    const selection = takeOption(remaining, "--selection") ?? "both";
    validateChoice(selection, ["chat", "runner", "both"], "--selection");
    const desktopPath = takeOption(remaining, "--desktop");
    requireNoArgs(remaining);
    return {
      command,
      operation,
      config,
      profile,
      selection,
      desktopPath,
      json,
    };
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
  if (command !== "session") {
    throw new TypeError(usage());
  }
  requireNoArgs(remaining);
  return { command, ...configuration, json };
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
      "Run pan session --config <path> and ask in the ordinary interactive session.",
    review:
      "Run pan session --config <path> and use the ordinary interactive or native scheduled review in that session.",
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

function formatSetupResult(result) {
  const lines = [
    `PAN domain ready: ${result.repository}`,
    `Domain path: ${result.directory}`,
    `Project: ${result.projectUrl ?? `${result.projectOwner}#${result.projectNumber}`}`,
    `Config: ${result.configPath}`,
    `Runner profile: ${result.runnerProfilePath} (${result.runnerOnline ? "online" : "offline"})`,
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

function formatVerificationResult(result) {
  return [
    `PAN setup: ${result.status}`,
    `Repository: ${result.repository}`,
    `Project: ${result.project}`,
    `Config: ${result.configPath}`,
    `Runner profile: ${result.runnerProfilePath}`,
    `Runner: ${result.runnerOnline ? "online" : "offline"}`,
  ].join("\n");
}

function formatShortcutResult(result) {
  return [
    `PAN desktop shortcuts: ${result.status}`,
    ...result.shortcuts.map((shortcut) => `${shortcut.kind}: ${shortcut.path}`),
  ].join("\n");
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

function optionalPositiveInteger(value, option) {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new TypeError(`${option} must be a positive integer`);
  }
  return parsed;
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
    "  pan onboard",
    "  pan setup [--repository <owner/name>] [--repository-mode <create|connect>] [--path <path>] [--project-mode <create|connect>] [--project-number <number>] [--approval-mode <prompt|allow-all>] [--install-assets]",
    "  pan verify --config <path> --profile <path>",
    "  pan shortcuts create --config <path> --profile <path> [--selection <chat|runner|both>]",
    "  pan assets <install|status|repair> [--force] [--json]",
    "  pan session --config <path>",
    "  pan attention <list|answer|add> --schema-version 1 --config <path>",
    "  Session, domain, or scheduling changes: exit and rerun pan session; runner changes: restart pan-runner.",
    "  pan leadership <status|acquire|assert|renew|release> --schema-version 1 --config <path>",
    "  pan reconcile <missing-issues|merged-prs> [--apply] --schema-version 1 --config <path>",
  ].join("\n");
}
