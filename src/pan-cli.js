import { readFile } from "node:fs/promises";
import path from "node:path";

import { AttentionService } from "./attention-service.js";
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
    gh = new GhClient(),
    pid = process.pid,
  } = {},
) {
  const parsed = parseArgs(args, env);
  const profile = await loadRunnerProfile(parsed.profile);
  const store = new PanStore({
    repository: profile.store.repository,
    projectOwner: profile.store.projectOwner,
    projectNumber: profile.store.projectNumber,
    gh,
  });
  const attention = new AttentionService({ store });

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
    const leaderLeaseSeconds = Math.max(
      120,
      profile.pollIntervalSeconds * 4,
    );
    const leaderLease = new LeaderLease({
      stateFile: new GitHubStateFile({
        gh,
        repository: profile.store.repository,
      }),
      holder: `${profile.machine}/pan-${pid}`,
      leaseSeconds: leaderLeaseSeconds,
    });
    const daemon = new PanDaemon({
      store,
      leaderLease,
      profileSource: new RunnerProfileSource({
        directory: path.join(profile.store.path, "runners"),
      }),
      pollIntervalSeconds: profile.pollIntervalSeconds,
      leaderHeartbeatSeconds: Math.min(30, leaderLeaseSeconds / 3),
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
  const profile = takeOption(remaining, "--profile") ?? env.PAN_PROFILE;
  if (!profile) {
    throw new TypeError(
      "Set PAN_PROFILE or pass --profile <runner-profile.json>",
    );
  }
  const json = takeFlag(remaining, "--json");
  const command = remaining.shift();
  if (!["daemon", "inbox", "answer", "add"].includes(command)) {
    throw new TypeError(usage());
  }
  if (command === "daemon") {
    const once = takeFlag(remaining, "--once");
    requireNoArgs(remaining);
    return { command, profile, once };
  }
  if (command === "inbox") {
    requireNoArgs(remaining);
    return { command, profile, json };
  }
  if (command === "answer") {
    const [identifier, text, ...extra] = remaining;
    if (!identifier || !text || extra.length > 0) {
      throw new TypeError("Usage: pan answer <id> <text> [--json]");
    }
    return { command, profile, json, identifier, text };
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
    profile,
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
    "  pan daemon [--once] --profile <path>",
    "  pan inbox [--json] --profile <path>",
    "  pan answer <id> <text> [--json] --profile <path>",
    "  pan add <title> [options] --profile <path>",
  ].join("\n");
}
