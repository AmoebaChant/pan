import { readFile } from "node:fs/promises";
import path from "node:path";

const ALLOWED_KEYS = new Set([
  "version",
  "domain",
  "state",
  "agent",
  "cadences",
  "transcripts",
  "reviewPolicy",
]);
const RUNNER_ONLY_KEYS = new Set([
  "id",
  "machine",
  "online",
  "maxConcurrentDaemons",
  "capabilities",
  "store",
  "repositories",
  "workspaceRoot",
  "stateDirectory",
  "terminal",
  "taskBudget",
]);
const DEFAULTS = Object.freeze({
  cadences: {
    activePollSeconds: 30,
    idlePollSeconds: 300,
    fullReviewSeconds: 86_400,
    leaderLeaseSeconds: 120,
    leaderHeartbeatSeconds: 30,
    notificationSeconds: 300,
    retrySeconds: 60,
    rateLimitRetrySeconds: 900,
  },
  agent: {
    executable: "copilot",
    turnTimeoutSeconds: undefined,
    maxAiCredits: undefined,
  },
  transcripts: {
    retentionDays: 30,
  },
  reviewPolicy: {
    higherRisk: {
      enabled: false,
      actionKinds: [],
    },
  },
});

export async function loadDomainConfig(configPath) {
  if (!configPath) {
    throw new TypeError("configPath is required");
  }

  let parsed;
  try {
    parsed = JSON.parse(await readFile(configPath, "utf8"));
  } catch (error) {
    throw new Error(
      `Unable to read PAN domain config ${configPath}: ${error.message}`,
      { cause: error },
    );
  }
  return validateDomainConfig(parsed, { configPath });
}

export function validateDomainConfig(config, { configPath } = {}) {
  requireRecord(config, "domain config");
  rejectUnexpectedKeys(config);
  requireEqual(config.version, 1, "version");

  requireRecord(config.domain, "domain");
  rejectObjectKeys(
    config.domain,
    new Set(["repository", "projectOwner", "projectNumber", "path"]),
    "domain",
  );
  requireRepository(config.domain.repository, "domain.repository");
  requireOwner(config.domain.projectOwner, "domain.projectOwner");
  requireInteger(config.domain.projectNumber, "domain.projectNumber", 1);
  requireAbsolutePath(config.domain.path, "domain.path");

  requireRecord(config.state, "state");
  rejectObjectKeys(config.state, new Set(["branch", "path"]), "state");
  requireBranch(config.state.branch, "state.branch");
  const statePath = requireRepositoryPath(config.state.path, "state.path");

  requireRecord(config.agent, "agent");
  rejectObjectKeys(
    config.agent,
    new Set([
      "name",
      "executable",
      "model",
      "turnTimeoutSeconds",
      "maxAiCredits",
    ]),
    "agent",
  );
  requireString(config.agent.name, "agent.name");
  if (config.agent.executable !== undefined) {
    requireString(config.agent.executable, "agent.executable");
  }
  if (config.agent.model !== undefined) {
    requireString(config.agent.model, "agent.model");
  }
  const agent = {
    name: config.agent.name,
    executable: config.agent.executable ?? DEFAULTS.agent.executable,
    model: config.agent.model,
    turnTimeoutSeconds: optionalBoundedNumber(
      config.agent.turnTimeoutSeconds,
      "agent.turnTimeoutSeconds",
      { minimum: 30, maximum: 3_600 },
    ),
    maxAiCredits: optionalBoundedNumber(
      config.agent.maxAiCredits,
      "agent.maxAiCredits",
      { minimum: 1, maximum: 1_000 },
    ),
  };

  const cadences = normalizeCadences(config.cadences);
  validateCadenceRelationships(cadences);

  const transcripts = normalizeTranscripts(config.transcripts, statePath);
  const reviewPolicy = normalizeReviewPolicy(config.reviewPolicy);

  return {
    version: 1,
    configPath: configPath ? path.resolve(configPath) : undefined,
    domain: {
      repository: config.domain.repository,
      projectOwner: config.domain.projectOwner,
      projectNumber: config.domain.projectNumber,
      path: path.resolve(config.domain.path),
    },
    state: {
      branch: config.state.branch,
      path: statePath,
      leaderPath: `${statePath}/leader.json`,
    },
    agent,
    cadences,
    transcripts,
    reviewPolicy,
  };
}

function optionalBoundedNumber(value, name, bounds) {
  return value === undefined
    ? undefined
    : boundedNumber(value, name, undefined, bounds);
}

function normalizeCadences(cadences = {}) {
  requireRecord(cadences, "cadences");
  rejectObjectKeys(
    cadences,
    new Set([
      "activePollSeconds",
      "idlePollSeconds",
      "fullReviewSeconds",
      "leaderLeaseSeconds",
      "leaderHeartbeatSeconds",
      "notificationSeconds",
      "retrySeconds",
      "rateLimitRetrySeconds",
    ]),
    "cadences",
  );
  return {
    activePollSeconds: boundedNumber(
      cadences.activePollSeconds,
      "cadences.activePollSeconds",
      DEFAULTS.cadences.activePollSeconds,
      { minimum: 5, maximum: 300 },
    ),
    idlePollSeconds: boundedNumber(
      cadences.idlePollSeconds,
      "cadences.idlePollSeconds",
      DEFAULTS.cadences.idlePollSeconds,
      { minimum: 30, maximum: 3_600 },
    ),
    fullReviewSeconds: boundedNumber(
      cadences.fullReviewSeconds,
      "cadences.fullReviewSeconds",
      DEFAULTS.cadences.fullReviewSeconds,
      { minimum: 300, maximum: 604_800 },
    ),
    leaderLeaseSeconds: boundedNumber(
      cadences.leaderLeaseSeconds,
      "cadences.leaderLeaseSeconds",
      DEFAULTS.cadences.leaderLeaseSeconds,
      { minimum: 30, maximum: 3_600 },
    ),
    leaderHeartbeatSeconds: boundedNumber(
      cadences.leaderHeartbeatSeconds,
      "cadences.leaderHeartbeatSeconds",
      DEFAULTS.cadences.leaderHeartbeatSeconds,
      { minimum: 5, maximum: 1_200 },
    ),
    notificationSeconds: boundedNumber(
      cadences.notificationSeconds,
      "cadences.notificationSeconds",
      DEFAULTS.cadences.notificationSeconds,
      { minimum: 30, maximum: 86_400 },
    ),
    retrySeconds: boundedNumber(
      cadences.retrySeconds,
      "cadences.retrySeconds",
      DEFAULTS.cadences.retrySeconds,
      { minimum: 5, maximum: 3_600 },
    ),
    rateLimitRetrySeconds: boundedNumber(
      cadences.rateLimitRetrySeconds,
      "cadences.rateLimitRetrySeconds",
      DEFAULTS.cadences.rateLimitRetrySeconds,
      { minimum: 60, maximum: 86_400 },
    ),
  };
}

function validateCadenceRelationships(cadences) {
  if (cadences.idlePollSeconds < cadences.activePollSeconds) {
    fail(
      "cadences.idlePollSeconds",
      "must be greater than or equal to cadences.activePollSeconds",
    );
  }
  if (cadences.fullReviewSeconds < cadences.idlePollSeconds) {
    fail(
      "cadences.fullReviewSeconds",
      "must be greater than or equal to cadences.idlePollSeconds",
    );
  }
  if (cadences.leaderHeartbeatSeconds >= cadences.leaderLeaseSeconds) {
    fail(
      "cadences.leaderHeartbeatSeconds",
      "must be less than cadences.leaderLeaseSeconds",
    );
  }
  if (cadences.rateLimitRetrySeconds < cadences.retrySeconds) {
    fail(
      "cadences.rateLimitRetrySeconds",
      "must be greater than or equal to cadences.retrySeconds",
    );
  }
}

function normalizeTranscripts(transcripts = {}, statePath) {
  requireRecord(transcripts, "transcripts");
  rejectObjectKeys(
    transcripts,
    new Set(["path", "retentionDays"]),
    "transcripts",
  );
  const transcriptPath = requireRepositoryPath(
    transcripts.path ?? `${statePath}/transcripts`,
    "transcripts.path",
  );
  requireWithinNamespace(transcriptPath, statePath, "transcripts.path");
  return {
    path: transcriptPath,
    retentionDays: boundedInteger(
      transcripts.retentionDays,
      "transcripts.retentionDays",
      DEFAULTS.transcripts.retentionDays,
      { minimum: 1, maximum: 365 },
    ),
  };
}

function normalizeReviewPolicy(reviewPolicy = {}) {
  requireRecord(reviewPolicy, "reviewPolicy");
  rejectObjectKeys(reviewPolicy, new Set(["higherRisk"]), "reviewPolicy");
  const higherRisk = reviewPolicy.higherRisk ?? DEFAULTS.reviewPolicy.higherRisk;
  requireRecord(higherRisk, "reviewPolicy.higherRisk");
  rejectObjectKeys(
    higherRisk,
    new Set(["enabled", "actionKinds"]),
    "reviewPolicy.higherRisk",
  );
  const enabled = higherRisk.enabled ?? false;
  requireBoolean(enabled, "reviewPolicy.higherRisk.enabled");
  const actionKinds = higherRisk.actionKinds ?? [];
  requireStringArray(actionKinds, "reviewPolicy.higherRisk.actionKinds");
  if (new Set(actionKinds).size !== actionKinds.length) {
    fail("reviewPolicy.higherRisk.actionKinds", "must not contain duplicates");
  }
  if (enabled && actionKinds.length === 0) {
    fail(
      "reviewPolicy.higherRisk.actionKinds",
      "must name at least one action kind when higher-risk review is enabled",
    );
  }
  return {
    higherRisk: {
      enabled,
      actionKinds: [...actionKinds],
    },
  };
}

function rejectUnexpectedKeys(config) {
  for (const key of Object.keys(config)) {
    if (RUNNER_ONLY_KEYS.has(key)) {
      fail(
        key,
        "is runner-only and must be kept in an independent runner profile",
      );
    }

    if (!ALLOWED_KEYS.has(key)) {
      fail(key, "is not a supported PAN domain configuration field");
    }
  }
}

function rejectObjectKeys(record, allowed, field) {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      fail(`${field}.${key}`, "is not a supported configuration field");
    }
  }
}

function requireRepository(value, field) {
  requireString(value, field);
  const [owner, name, extra] = value.split("/");
  if (
    extra !== undefined ||
    !isOwner(owner) ||
    typeof name !== "string" ||
    !/^[A-Za-z0-9._-]+$/.test(name)
  ) {
    fail(field, "must use owner/name GitHub repository format");
  }
}

function requireOwner(value, field) {
  requireString(value, field);
  if (!isOwner(value)) {
    fail(field, "must be a GitHub user or organization name");
  }
}

function isOwner(value) {
  return (
    typeof value === "string" &&
    value.length <= 39 &&
    /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(value)
  );
}

function requireBranch(value, field) {
  requireString(value, field);
  if (
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.endsWith(".") ||
    value.endsWith(".lock") ||
    value.includes("..") ||
    value.includes("@{") ||
    /[\s~^:?*[\]\\]/.test(value)
  ) {
    fail(field, "must be a valid Git branch name");
  }
}

function requireRepositoryPath(value, field) {
  requireString(value, field);
  if (
    value.includes("\\") ||
    path.posix.isAbsolute(value) ||
    value.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    fail(field, "must be a confined repository-relative path using / separators");
  }
  return path.posix.normalize(value);
}

function requireWithinNamespace(value, namespace, field) {
  if (value !== namespace && !value.startsWith(`${namespace}/`)) {
    fail(field, `must remain inside the ${namespace} state namespace`);
  }
}

function boundedNumber(value, field, fallback, { minimum, maximum }) {
  const normalized = value ?? fallback;
  if (
    typeof normalized !== "number" ||
    !Number.isFinite(normalized) ||
    normalized < minimum ||
    normalized > maximum
  ) {
    fail(field, `must be a number from ${minimum} through ${maximum}`);
  }
  return normalized;
}

function boundedInteger(value, field, fallback, bounds) {
  const normalized = boundedNumber(value, field, fallback, bounds);
  if (!Number.isInteger(normalized)) {
    fail(field, "must be an integer");
  }
  return normalized;
}

function requireRecord(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(field, "must be an object");
  }
}

function requireString(value, field) {
  if (typeof value !== "string" || !value.trim()) {
    fail(field, "must be a non-empty string");
  }
}

function requireStringArray(value, field) {
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string" || !entry.trim())
  ) {
    fail(field, "must be an array of non-empty strings");
  }
}

function requireInteger(value, field, minimum) {
  if (!Number.isInteger(value) || value < minimum) {
    fail(field, `must be an integer greater than or equal to ${minimum}`);
  }
}

function requireBoolean(value, field) {
  if (typeof value !== "boolean") {
    fail(field, "must be a boolean");
  }
}

function requireAbsolutePath(value, field) {
  requireString(value, field);
  if (!path.isAbsolute(value)) {
    fail(field, "must be an absolute path");
  }
}

function requireEqual(value, expected, field) {
  if (value !== expected) {
    fail(field, `must be ${JSON.stringify(expected)}`);
  }
}

function fail(field, correction) {
  throw new TypeError(
    `${field} ${correction}; correct the PAN domain config before retrying`,
  );
}
