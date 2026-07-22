import { readFile } from "node:fs/promises";
import path from "node:path";

import { normalizePlaybooks } from "./playbook.js";

const DEFAULTS = {
  pollIntervalSeconds: 30,
  leaseSeconds: 600,
  heartbeatSeconds: 120,
  approvalMode: "prompt",
};

export async function loadRunnerProfile(profilePath) {
  if (!profilePath) {
    throw new TypeError("profilePath is required");
  }

  let parsed;
  try {
    parsed = JSON.parse(await readFile(profilePath, "utf8"));
  } catch (error) {
    throw new Error(`Unable to read runner profile ${profilePath}: ${error.message}`, {
      cause: error,
    });
  }
  return validateRunnerProfile(parsed, { profilePath });
}

export function validateRunnerProfile(profile, { profilePath } = {}) {
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
    throw new TypeError("runner profile must be an object");
  }

  requireInteger(profile.version, "version", { minimum: 1 });
  requireString(profile.id, "id");
  requireString(profile.machine, "machine");
  requireBoolean(profile.online, "online");
  requireInteger(profile.maxConcurrentDaemons, "maxConcurrentDaemons", {
    minimum: 1,
  });
  requireStringArray(profile.capabilities, "capabilities", { nonEmpty: true });
  if (new Set(profile.capabilities).size !== profile.capabilities.length) {
    throw new TypeError("capabilities must not contain duplicates");
  }

  const store = normalizeStore(profile.store, profilePath);
  validateStore(store);
  validateRepositories(profile.repositories, profile.capabilities, {
    online: profile.online,
  });
  requireAbsolutePath(profile.workspaceRoot, "workspaceRoot");
  requireAbsolutePath(profile.stateDirectory, "stateDirectory");

  const terminal = profile.terminal ?? {};
  if (terminal.type !== "windows-terminal") {
    throw new TypeError('terminal.type must be "windows-terminal"');
  }
  if (terminal.executable !== undefined) {
    requireString(terminal.executable, "terminal.executable");
  }
  if (terminal.window !== undefined) {
    requireString(terminal.window, "terminal.window");
  }
  if (terminal.profile !== undefined) {
    requireString(terminal.profile, "terminal.profile");
  }

  if (profile.githubAssignee !== undefined) {
    requireString(profile.githubAssignee, "githubAssignee");
  }
  if (
    profile.copilot !== undefined &&
    (!profile.copilot ||
      typeof profile.copilot !== "object" ||
      Array.isArray(profile.copilot))
  ) {
    throw new TypeError("copilot must be an object");
  }
  if (profile.domainConfigPath !== undefined) {
    requireAbsolutePath(profile.domainConfigPath, "domainConfigPath");
  }
  if (profile.copilot?.executable !== undefined) {
    requireString(profile.copilot.executable, "copilot.executable");
  }
  const approvalMode =
    profile.copilot?.approvalMode ?? DEFAULTS.approvalMode;
  if (!["prompt", "allow-all"].includes(approvalMode)) {
    throw new TypeError(
      'copilot.approvalMode must be "prompt" or "allow-all"',
    );
  }

  const normalized = {
    ...profile,
    profilePath: profilePath ? path.resolve(profilePath) : undefined,
    domainConfigPath: profile.domainConfigPath
      ? path.resolve(profile.domainConfigPath)
      : undefined,
    store,
    pollIntervalSeconds: positiveNumber(
      profile.pollIntervalSeconds,
      "pollIntervalSeconds",
      DEFAULTS.pollIntervalSeconds,
    ),
    leaseSeconds: positiveNumber(
      profile.leaseSeconds,
      "leaseSeconds",
      DEFAULTS.leaseSeconds,
    ),
    heartbeatSeconds: positiveNumber(
      profile.heartbeatSeconds,
      "heartbeatSeconds",
      DEFAULTS.heartbeatSeconds,
    ),
    taskBudget: {
      wallClockMinutes: optionalPositiveNumber(
        profile.taskBudget?.wallClockMinutes,
        "taskBudget.wallClockMinutes",
      ),
      maxAiCredits: optionalAiCreditBudget(
        profile.taskBudget?.maxAiCredits,
        "taskBudget.maxAiCredits",
      ),
      maxAutopilotContinues: optionalPositiveInteger(
        profile.taskBudget?.maxAutopilotContinues,
        "taskBudget.maxAutopilotContinues",
      ),
    },
    terminal: {
      type: terminal.type,
      executable: terminal.executable ?? "wt",
      window: terminal.window ?? "0",
      profile: terminal.profile,
    },
    copilot: {
      executable: profile.copilot?.executable ?? "copilot",
      model: profile.copilot?.model,
      approvalMode,
    },
  };
  normalized.playbooks = normalizePlaybooks(normalized);

  if (normalized.heartbeatSeconds >= normalized.leaseSeconds) {
    throw new TypeError("heartbeatSeconds must be less than leaseSeconds");
  }
  return normalized;
}

function normalizeStore(store, profilePath) {
  if (!store || typeof store !== "object" || Array.isArray(store)) {
    throw new TypeError("store must be an object");
  }
  const storePath =
    store.path ??
    (profilePath
      ? path.resolve(path.dirname(profilePath), "..")
      : undefined);
  return { ...store, path: storePath };
}

function validateStore(store) {
  requireString(store.repository, "store.repository");
  requireString(store.projectOwner, "store.projectOwner");
  requireInteger(store.projectNumber, "store.projectNumber", { minimum: 1 });
  requireAbsolutePath(store.path, "store.path");
}

function validateRepositories(repositories, capabilities, { online }) {
  if (
    !repositories ||
    typeof repositories !== "object" ||
    Array.isArray(repositories)
  ) {
    throw new TypeError("repositories must be an object");
  }
  if (online && Object.keys(repositories).length === 0) {
    throw new TypeError(
      "repositories must contain at least one repository when the runner is online",
    );
  }

  for (const [repository, config] of Object.entries(repositories)) {
    requireString(repository, "repository name");
    if (!capabilities.includes(`repo:${repository}`)) {
      throw new TypeError(
        `capabilities must include repo:${repository} for each configured repository`,
      );
    }
    if (!config || typeof config !== "object" || Array.isArray(config)) {
      throw new TypeError(`repositories.${repository} must be an object`);
    }
    requireAbsolutePath(config.path, `repositories.${repository}.path`);
    requireString(
      config.defaultBranch,
      `repositories.${repository}.defaultBranch`,
    );
  }
}

function requireString(value, name) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
}

function requireStringArray(value, name, { nonEmpty = false } = {}) {
  if (
    !Array.isArray(value) ||
    (nonEmpty && value.length === 0) ||
    value.some((entry) => typeof entry !== "string" || !entry.trim())
  ) {
    throw new TypeError(`${name} must be an array of non-empty strings`);
  }
}

function requireBoolean(value, name) {
  if (typeof value !== "boolean") {
    throw new TypeError(`${name} must be a boolean`);
  }
}

function requireInteger(value, name, { minimum } = {}) {
  if (!Number.isInteger(value) || (minimum !== undefined && value < minimum)) {
    throw new TypeError(
      `${name} must be an integer${minimum ? ` >= ${minimum}` : ""}`,
    );
  }
}

function requireAbsolutePath(value, name) {
  requireString(value, name);
  if (!path.isAbsolute(value)) {
    throw new TypeError(`${name} must be an absolute path`);
  }
}

function positiveNumber(value, name, fallback) {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive number`);
  }
  return value;
}

function positiveInteger(value, name, fallback) {
  if (value === undefined) {
    return fallback;
  }
  requireInteger(value, name, { minimum: 1 });
  return value;
}

function optionalPositiveNumber(value, name) {
  return value === undefined
    ? undefined
    : positiveNumber(value, name);
}

function optionalPositiveInteger(value, name) {
  return value === undefined
    ? undefined
    : positiveInteger(value, name);
}

function optionalAiCreditBudget(value, name) {
  if (value === undefined) {
    return undefined;
  }
  const normalized = positiveNumber(value, name);
  if (normalized < 30) {
    throw new TypeError(`${name} must be at least 30`);
  }
  return normalized;
}
