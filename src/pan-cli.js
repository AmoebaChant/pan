
import { readFile } from "node:fs/promises";

import { PanAssetService } from "./pan-assets.js";
import { loadDomainConfig } from "./domain-config.js";
import {
  GitHubDomainConfigStore,
  readMachineDomainConfig,
} from "./github-domain-config.js";
import { GhClient } from "./gh-client.js";
import { startPanOnboarding } from "./pan-onboarding.js";
import { createPanDesktopShortcuts } from "./pan-shortcuts.js";
import { startPanSession } from "./pan-session.js";
import { setupPanDomain } from "./pan-setup.js";
import { assertMatchingDomain, verifyPanSetup } from "./pan-verification.js";
import { loadRunnerProfile } from "./runner-profile.js";
import {
  readMigrationReport,
  WorkstreamMigration,
  writeMigrationReport,
} from "./workstream-migration.js";

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
  } = {},
) {
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
  if (parsed.command === "migrate-workstreams") {
    const domainConfig = await domainConfigLoader(parsed.config, { gh });
    const resume = parsed.resume
      ? await readMigrationReport(parsed.resume)
      : undefined;
    const result = await new WorkstreamMigration({
      repository: domainConfig.domain.repository,
      projectOwner: domainConfig.domain.projectOwner,
      projectNumber: domainConfig.domain.projectNumber,
      gh,
    }).run({
      dryRun: parsed.dryRun,
      resume,
      createRemovalPullRequest: parsed.createRemovalPullRequest,
      checkpoint: (report) => writeMigrationReport(parsed.report, report),
    });
    await writeMigrationReport(parsed.report, result);
    write(
      stdout,
      parsed.json
        ? JSON.stringify(result, null, 2)
        : `Workstream migration ${result.dryRun ? "dry-run" : "run"} report: ${parsed.report}`,
    );
    return result;
  }
  if (parsed.command === "config") {
    if (parsed.operation === "get") {
      const machine = await readMachineDomainConfig(parsed.config);
      const result = await new GitHubDomainConfigStore({
        repository: machine.domain.repository,
        gh,
      }).read();
      if (!result) {
        throw new Error("The configured domain has no shared pan.json");
      }
      write(stdout, JSON.stringify(result, null, 2));
      return result;
    }
    if (parsed.operation === "update") {
      const machine = await readMachineDomainConfig(parsed.config);
      const document = JSON.parse(await readFile(parsed.document, "utf8"));
      const result = await new GitHubDomainConfigStore({
        repository: machine.domain.repository,
        gh,
      }).write(document, {
        expectedSha: parsed.expectedSha,
        message: parsed.message,
      });
      write(
        stdout,
        parsed.json
          ? JSON.stringify(result, null, 2)
          : `Updated shared pan.json at ${result.sha}.`,
      );
      return result;
    }
    const domainConfig = await domainConfigLoader(parsed.config, { gh });
    const result = {
      status: "valid",
      configPath: parsed.config,
      version: domainConfig.version,
    };
    write(
      stdout,
      parsed.json ? JSON.stringify(result, null, 2) : "Pan configuration is valid.",
    );
    return result;
  }
  if (parsed.command === "verify") {
    const domainConfig = await domainConfigLoader(parsed.config, { gh });
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
      domainConfigLoader(parsed.config, { gh }),
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
      approvalMode: runnerProfile.copilot.approvalMode,
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
  const domainConfig = await domainConfigLoader(parsed.config, { gh });
  if (parsed.command === "session") {
    const agent = domainConfig.session?.agent ?? domainConfig.agent;
    const result = await sessionFactory({
      config: domainConfig,
      configPath: parsed.config,
      executable: agent?.executable,
      model: agent?.model,
      allowAllTools: parsed.allowAllTools,
      env,
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
    return `Pan session exited with code ${result.exitCode}${result.signal ? ` (${result.signal})` : ""}.`;
  }

  throw new Error(`Unknown Pan command: ${parsed.command}`);
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
    const positionalRepository =
      remaining[0] && !remaining[0].startsWith("--")
        ? remaining.shift()
        : undefined;
    const repositoryOption = takeOption(remaining, "--repository");
    if (positionalRepository && repositoryOption) {
      throw new TypeError(
        "Specify the domain repository positionally or with --repository, not both",
      );
    }
    const repository = positionalRepository ?? repositoryOption;
    const setupPath = takeOption(remaining, "--path");
    const localConfigPath = takeOption(remaining, "--local-config");
    const projectOwner = takeOption(remaining, "--project-owner");
    const projectTitle = takeOption(remaining, "--project-title");
    const projectNumber = optionalPositiveInteger(
      takeOption(remaining, "--project-number"),
      "--project-number",
    );
    const repositoryMode = takeOption(remaining, "--repository-mode");
    const projectMode = takeOption(remaining, "--project-mode");
    const approvalMode = takeOption(remaining, "--approval-mode");
    const selfRepairRepository = takeOption(
      remaining,
      "--self-repair-repository",
    );
    const selfRepairPath = takeOption(remaining, "--self-repair-path");
    const selfRepairDefaultBranch = takeOption(
      remaining,
      "--self-repair-default-branch",
    );
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
    if ((selfRepairRepository === undefined) !== (selfRepairPath === undefined)) {
      throw new TypeError(
        "--self-repair-repository and --self-repair-path must be used together",
      );
    }
    if (
      selfRepairDefaultBranch !== undefined &&
      selfRepairRepository === undefined
    ) {
      throw new TypeError(
        "--self-repair-default-branch requires --self-repair-repository",
      );
    }
    requireNoArgs(remaining);
    return {
      command,
      json,
      repository,
      path: setupPath,
      ...(localConfigPath ? { localConfigPath } : {}),
      projectOwner,
      projectTitle,
      projectNumber,
      repositoryMode,
      projectMode,
      approvalMode,
      selfRepairRepository,
      selfRepairPath,
      selfRepairDefaultBranch,
      ...(installAssets ? { installAssets: true } : {}),
    };
  }

  if (command === "migrate-workstreams") {
    if (!config || profile) {
      throw new TypeError(
        "pan migrate-workstreams requires --config <machine-config>",
      );
    }
    const report = takeOption(remaining, "--report");
    const resume = takeOption(remaining, "--resume");
    const apply = takeFlag(remaining, "--apply");
    const dryRunFlag = takeFlag(remaining, "--dry-run");
    const createRemovalPullRequest = takeFlag(
      remaining,
      "--create-removal-pr",
    );
    if (!report) {
      throw new TypeError(
        "pan migrate-workstreams requires --report <path>",
      );
    }
    if (apply && dryRunFlag) {
      throw new TypeError("--apply and --dry-run cannot be used together");
    }
    if (createRemovalPullRequest && !apply) {
      throw new TypeError("--create-removal-pr requires --apply");
    }
    requireNoArgs(remaining);
    return {
      command,
      config,
      report,
      resume,
      dryRun: !apply,
      createRemovalPullRequest,
      json,
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
  if (command === "config") {
    const operation = remaining.shift();
    if (!["validate", "get", "update"].includes(operation)) {
      throw new TypeError(
        "Usage: pan config <validate|get|update> --config <path>",
      );
    }
    if (!config || profile) {
      throw new TypeError(
        "pan config requires --config <path>; --profile is not supported",
      );
    }
    if (operation === "get") {
      requireNoArgs(remaining);
      return { command, operation, config, json };
    }
    if (operation === "update") {
      const document = takeOption(remaining, "--document");
      const expectedSha = takeOption(remaining, "--expected-sha");
      const message = takeOption(remaining, "--message");
      if (!document || !expectedSha) {
        throw new TypeError(
          "pan config update requires --document <path> and --expected-sha <sha>",
        );
      }
      requireNoArgs(remaining);
      return {
        command,
        operation,
        config,
        document,
        expectedSha,
        message,
        json,
      };
    }
    const schemaVersion = takeOption(remaining, "--schema-version");
    if (schemaVersion !== "1") {
      throw new TypeError("pan config validate requires --schema-version 1");
    }
    requireNoArgs(remaining);
    return { command, operation, schemaVersion: 1, config, json };
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
      "Pan sessions run in the foreground. Run pan session --config <path>, then exit that session to stop it.",
    );
  }
  if (config && profile) {
    throw new TypeError(
      "Pan domain config and runner profile inputs cannot be used together",
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
  const allowAllTools = takeFlag(remaining, "--allow-all-tools");
  requireNoArgs(remaining);
  return {
    command,
    ...configuration,
    ...(allowAllTools ? { allowAllTools: true } : {}),
    json,
  };
}

function retiredCommand(command, json) {
  const guidance = {
    start:
      "Run pan session --config <path> in the foreground; Pan no longer starts a host or background process.",
    stop:
      "Pan sessions are foreground processes. Exit the running pan session, then rerun pan session --config <path> when needed.",
    host:
      "Run pan session --config <path> in the foreground; Pan no longer runs a host or bridge.",
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

function formatSetupResult(result) {
  const lines = [
    `Pan domain ready: ${result.repository}`,
    `${result.apiOnly ? "Machine config directory" : "Domain path"}: ${result.directory}`,
    `Project: ${result.projectUrl ?? `${result.projectOwner}#${result.projectNumber}`}`,
    `Config: ${result.configPath}`,
    `Runner profile: ${result.runnerProfilePath} (${result.runnerOnline ? "online" : "offline"})`,
    `Copilot approvals: ${result.approvalMode}`,
  ];
  if (result.assets) {
    lines.push(`Pan assets: ${result.assets.status}`);
    lines.push(...(result.assets.diagnostics ?? []));
  }
  return lines.join("\n");
}

function formatAssetResult(result) {
  const lines = [`Pan assets: ${result.status}`];
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
    `Pan setup: ${result.status}`,
    `Repository: ${result.repository}`,
    `Project: ${result.project}`,
    `Config: ${result.configPath}`,
    `Runner profile: ${result.runnerProfilePath}`,
    `Runner: ${result.runnerOnline ? "online" : "offline"}`,
  ].join("\n");
}

function formatShortcutResult(result) {
  return [
    `Pan desktop shortcuts: ${result.status}`,
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
    "  pan setup <owner/name> [--repository-mode <create|connect>] [--local-config <path>] [--project-mode <create|connect>] [--project-number <number>] [--approval-mode <prompt|allow-all>] [--self-repair-repository <owner/name> --self-repair-path <path> [--self-repair-default-branch <branch>]] [--install-assets]",
    "  pan config validate --schema-version 1 --config <path> [--json]",
    "  pan config get --config <machine-config> [--json]",
    "  pan config update --config <machine-config> --document <pan.json> --expected-sha <sha> [--message <text>] [--json]",
    "  pan migrate-workstreams --config <machine-config> --report <path> [--dry-run|--apply] [--resume <report>] [--create-removal-pr] [--json]",
    "  pan verify --config <path> --profile <path>",
    "  pan shortcuts create --config <path> --profile <path> [--selection <chat|runner|both>]",
    "  pan assets <install|status|repair> [--force] [--json]",
    "  pan session --config <path>",
    "  Session, domain, or scheduling changes: exit and rerun pan session; runner changes: restart pan-runner.",
  ].join("\n");
}
