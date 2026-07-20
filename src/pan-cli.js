import { readFile } from "node:fs/promises";
import path from "node:path";

import { AttentionService } from "./attention-service.js";
import { loadDomainConfig } from "./domain-config.js";
import { GhClient } from "./gh-client.js";
import { GitHubStateFile, LeaderLease } from "./leader-lease.js";
import { PanDaemon } from "./pan-daemon.js";
import { PanStore } from "./pan-store.js";
import { loadRunnerProfile } from "./runner-profile.js";
import { RunnerProfileSource } from "./runner-profile-source.js";

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
  } = {},
) {
  const parsed = parseArgs(args, env);
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
  const attention = attentionFactory({ store });

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
  if (parsed.command === "daemon") {
    const leaderLeaseSeconds = configuration.runtime.leaderLeaseSeconds;
    const leaderLease = new LeaderLease({
      stateFile: new GitHubStateFile({
        gh,
        repository: configuration.store.repository,
        branch: configuration.runtime.stateBranch,
        filePath: configuration.runtime.leaderPath,
      }),
      holder: `${configuration.runtime.machine}/pan-${pid}`,
      leaseSeconds: leaderLeaseSeconds,
    });
    const daemon = new PanDaemon({
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

export function parseArgs(args, env = process.env) {
  const remaining = [...args];
  const config = takeOption(remaining, "--config") ?? env.PAN_CONFIG;
  const profile = takeOption(remaining, "--profile") ?? env.PAN_PROFILE;
  if (config && profile) {
    throw new TypeError(
      "PAN domain config and runner profile inputs cannot be used together",
    );
  }
  if (!config && !profile) {
    throw new TypeError(
      "Set PAN_CONFIG or pass --config <domain-config.json> (legacy: PAN_PROFILE or --profile)",
    );
  }
  const configuration = { config, profile };
  const json = takeFlag(remaining, "--json");
  const command = remaining.shift();
  if (!["daemon", "inbox", "answer", "add"].includes(command)) {
    throw new TypeError(usage());
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

async function loadCliConfiguration(
  parsed,
  { domainConfigLoader, runnerProfileLoader },
) {
  if (parsed.config) {
    const config = await domainConfigLoader(parsed.config);
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
        pollIntervalSeconds: config.cadences.activePollSeconds,
        leaderLeaseSeconds: config.cadences.leaderLeaseSeconds,
        leaderHeartbeatSeconds: config.cadences.leaderHeartbeatSeconds,
        stateBranch: config.state.branch,
        leaderPath: config.state.leaderPath,
        runnerProfileDirectory: path.join(config.domain.path, "runners"),
      },
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
  };
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
    "  pan daemon [--once] --config <path>",
    "  pan inbox [--json] --config <path>",
    "  pan answer <id> <text> [--json] --config <path>",
    "  pan add <title> [options] --config <path>",
  ].join("\n");
}
