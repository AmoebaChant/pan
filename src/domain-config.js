import { readFile } from "node:fs/promises";
import path from "node:path";

const ACTION_KINDS = new Set([
  "field-update",
  "canonical-reorder",
  "relative-precedence",
  "issue-create",
  "issue-comment",
  "needs-human",
  "no-op",
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
const V1_KEYS = new Set([
  "version",
  "domain",
  "state",
  "agent",
  "cadences",
  "transcripts",
  "reviewPolicy",
  "selfRepair",
  "attention",
]);
const V2_KEYS = new Set([
  "version",
  "domain",
  "state",
  "session",
  "scheduling",
  "leadership",
  "policy",
  "reviewPolicy",
  "selfRepair",
  "attention",
]);
const DEFAULTS = Object.freeze({
  agent: { executable: "copilot" },
  scheduling: {
    enabled: true,
    reviewIntervalSeconds: 86_400,
    startup: "immediate",
    retrySeconds: 60,
    rateLimitRetrySeconds: 900,
  },
  leadership: { leaseSeconds: 120, heartbeatSeconds: 30 },
  policy: {
    automatic: ["no-op"],
    approvalRequired: [
      "field-update",
      "canonical-reorder",
      "relative-precedence",
      "issue-create",
      "issue-comment",
      "needs-human",
    ],
    prohibited: [],
  },
  reviewPolicy: { higherRisk: { enabled: false, actionKinds: [] } },
  selfRepair: { enabled: false },
  attention: { assignee: undefined },
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
  if (config.version === 1) {
    return normalizeV1(config, configPath);
  }
  if (config.version === 2) {
    return normalizeV2(config, configPath);
  }
  fail("version", "must be 1 or 2");
}

export function migrateDomainConfig(config) {
  requireRecord(config, "domain config");
  if (config.version === 2) {
    validateDomainConfig(config);
    return { document: structuredClone(config), diagnostics: [] };
  }
  if (config.version !== 1) {
    fail("version", "must be 1 or 2");
  }

  const normalized = normalizeV1(config);
  const diagnostics = [
    "version: migrated domain configuration from version 1 to version 2",
    "agent: remapped to session.agent",
    "cadences.fullReviewSeconds: remapped to scheduling.reviewIntervalSeconds",
    "cadences.leaderLeaseSeconds: remapped to leadership.leaseSeconds",
    "cadences.leaderHeartbeatSeconds: remapped to leadership.heartbeatSeconds",
    "cadences.retrySeconds: remapped to scheduling.retrySeconds",
    "cadences.rateLimitRetrySeconds: remapped to scheduling.rateLimitRetrySeconds",
  ];
  for (const field of [
    "activePollSeconds",
    "idlePollSeconds",
    "notificationSeconds",
  ]) {
    if (config.cadences?.[field] !== undefined) {
      diagnostics.push(`cadences.${field}: obsolete host polling setting removed`);
    }
  }
  if (config.transcripts !== undefined) {
    diagnostics.push("transcripts: obsolete host transcript setting removed");
  }

  return {
    document: domainConfigDocument(normalized),
    diagnostics,
  };
}

function normalizeV1(config, configPath) {
  rejectUnexpectedKeys(config, V1_KEYS);
  const identity = normalizeIdentity(config);
  const agent = normalizeAgent(config.agent, "agent");
  const cadences = normalizeV1Cadences(config.cadences);
  validateLeadership(cadences.leaderLeaseSeconds, cadences.leaderHeartbeatSeconds);
  validateScheduling(
    cadences.fullReviewSeconds,
    cadences.retrySeconds,
    cadences.rateLimitRetrySeconds,
  );

  return normalizedConfig({
    configPath,
    identity,
    session: { agent, productContextRoots: [] },
    scheduling: {
      enabled: DEFAULTS.scheduling.enabled,
      startup: DEFAULTS.scheduling.startup,
      reviewIntervalSeconds: cadences.fullReviewSeconds,
      retrySeconds: cadences.retrySeconds,
      rateLimitRetrySeconds: cadences.rateLimitRetrySeconds,
    },
    leadership: {
      leaseSeconds: cadences.leaderLeaseSeconds,
      heartbeatSeconds: cadences.leaderHeartbeatSeconds,
    },
    policy: normalizePolicy(),
    reviewPolicy: normalizeReviewPolicy(config.reviewPolicy),
    selfRepair: normalizeSelfRepair(config.selfRepair),
    attention: normalizeAttention(config.attention),
    migrationDiagnostics: migrationDiagnostics(config),
  });
}

function normalizeV2(config, configPath) {
  rejectUnexpectedKeys(config, V2_KEYS);
  const identity = normalizeIdentity(config);
  requireRecord(config.session, "session");
  rejectObjectKeys(config.session, new Set(["agent", "productContextRoots"]), "session");
  const session = {
    agent: normalizeAgent(config.session.agent, "session.agent"),
    productContextRoots: normalizeProductContextRoots(
      config.session.productContextRoots,
    ),
  };
  const scheduling = normalizeScheduling(config.scheduling);
  const leadership = normalizeLeadership(config.leadership);

  return normalizedConfig({
    configPath,
    identity,
    session,
    scheduling,
    leadership,
    policy: normalizePolicy(config.policy),
    reviewPolicy: normalizeReviewPolicy(config.reviewPolicy),
    selfRepair: normalizeSelfRepair(config.selfRepair),
    attention: normalizeAttention(config.attention),
    migrationDiagnostics: [],
  });
}

function normalizeIdentity(config) {
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
  return {
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
  };
}

function normalizeAgent(agent, field) {
  requireRecord(agent, field);
  rejectObjectKeys(
    agent,
    new Set(["name", "executable", "model", "turnTimeoutSeconds", "maxAiCredits"]),
    field,
  );
  requireString(agent.name, `${field}.name`);
  if (agent.executable !== undefined) {
    requireString(agent.executable, `${field}.executable`);
  }
  if (agent.model !== undefined) {
    requireString(agent.model, `${field}.model`);
  }
  return {
    name: agent.name,
    executable: agent.executable ?? DEFAULTS.agent.executable,
    model: agent.model,
    turnTimeoutSeconds: optionalBoundedNumber(
      agent.turnTimeoutSeconds,
      `${field}.turnTimeoutSeconds`,
      { minimum: 30, maximum: 3_600 },
    ),
    maxAiCredits: optionalBoundedNumber(
      agent.maxAiCredits,
      `${field}.maxAiCredits`,
      { minimum: 1, maximum: 1_000 },
    ),
  };
}

function normalizeProductContextRoots(roots = []) {
  if (!Array.isArray(roots)) {
    fail("session.productContextRoots", "must be an array");
  }
  const labels = new Set();
  return roots.map((root, index) => {
    const field = `session.productContextRoots[${index}]`;
    requireRecord(root, field);
    rejectObjectKeys(root, new Set(["label", "path"]), field);
    requireString(root.label, `${field}.label`);
    if (labels.has(root.label)) {
      fail(`${field}.label`, "must not duplicate another product-context root label");
    }
    labels.add(root.label);
    requireAbsolutePath(root.path, `${field}.path`);
    return { label: root.label, path: path.resolve(root.path) };
  });
}

function normalizeV1Cadences(cadences = {}) {
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
  const activePollSeconds = boundedNumber(
    cadences.activePollSeconds,
    "cadences.activePollSeconds",
    30,
    { minimum: 5, maximum: 300 },
  );
  const idlePollSeconds = boundedNumber(
    cadences.idlePollSeconds,
    "cadences.idlePollSeconds",
    300,
    { minimum: 30, maximum: 3_600 },
  );
  if (idlePollSeconds < activePollSeconds) {
    fail("cadences.idlePollSeconds", "must be greater than or equal to cadences.activePollSeconds");
  }
  return {
    fullReviewSeconds: boundedNumber(
      cadences.fullReviewSeconds,
      "cadences.fullReviewSeconds",
      DEFAULTS.scheduling.reviewIntervalSeconds,
      { minimum: 300, maximum: 604_800 },
    ),
    leaderLeaseSeconds: boundedNumber(
      cadences.leaderLeaseSeconds,
      "cadences.leaderLeaseSeconds",
      DEFAULTS.leadership.leaseSeconds,
      { minimum: 30, maximum: 3_600 },
    ),
    leaderHeartbeatSeconds: boundedNumber(
      cadences.leaderHeartbeatSeconds,
      "cadences.leaderHeartbeatSeconds",
      DEFAULTS.leadership.heartbeatSeconds,
      { minimum: 5, maximum: 1_200 },
    ),
    retrySeconds: boundedNumber(
      cadences.retrySeconds,
      "cadences.retrySeconds",
      DEFAULTS.scheduling.retrySeconds,
      { minimum: 5, maximum: 3_600 },
    ),
    rateLimitRetrySeconds: boundedNumber(
      cadences.rateLimitRetrySeconds,
      "cadences.rateLimitRetrySeconds",
      DEFAULTS.scheduling.rateLimitRetrySeconds,
      { minimum: 60, maximum: 86_400 },
    ),
  };
}

function normalizeScheduling(scheduling = {}) {
  requireRecord(scheduling, "scheduling");
  rejectObjectKeys(
    scheduling,
    new Set([
      "enabled",
      "reviewIntervalSeconds",
      "startup",
      "retrySeconds",
      "rateLimitRetrySeconds",
    ]),
    "scheduling",
  );
  const enabled = scheduling.enabled ?? DEFAULTS.scheduling.enabled;
  requireBoolean(enabled, "scheduling.enabled");
  const startup = scheduling.startup ?? DEFAULTS.scheduling.startup;
  if (!["immediate", "after-interval", "manual"].includes(startup)) {
    fail("scheduling.startup", 'must be "immediate", "after-interval", or "manual"');
  }
  const reviewIntervalSeconds = boundedNumber(
    scheduling.reviewIntervalSeconds,
    "scheduling.reviewIntervalSeconds",
    DEFAULTS.scheduling.reviewIntervalSeconds,
    { minimum: 300, maximum: 604_800 },
  );
  const retrySeconds = boundedNumber(
    scheduling.retrySeconds,
    "scheduling.retrySeconds",
    DEFAULTS.scheduling.retrySeconds,
    { minimum: 5, maximum: 3_600 },
  );
  const rateLimitRetrySeconds = boundedNumber(
    scheduling.rateLimitRetrySeconds,
    "scheduling.rateLimitRetrySeconds",
    DEFAULTS.scheduling.rateLimitRetrySeconds,
    { minimum: 60, maximum: 86_400 },
  );
  validateScheduling(reviewIntervalSeconds, retrySeconds, rateLimitRetrySeconds);
  return {
    enabled,
    startup,
    reviewIntervalSeconds,
    retrySeconds,
    rateLimitRetrySeconds,
  };
}

function normalizeLeadership(leadership = {}) {
  requireRecord(leadership, "leadership");
  rejectObjectKeys(
    leadership,
    new Set(["leaseSeconds", "heartbeatSeconds"]),
    "leadership",
  );
  const leaseSeconds = boundedNumber(
    leadership.leaseSeconds,
    "leadership.leaseSeconds",
    DEFAULTS.leadership.leaseSeconds,
    { minimum: 30, maximum: 3_600 },
  );
  const heartbeatSeconds = boundedNumber(
    leadership.heartbeatSeconds,
    "leadership.heartbeatSeconds",
    DEFAULTS.leadership.heartbeatSeconds,
    { minimum: 5, maximum: 1_200 },
  );
  validateLeadership(leaseSeconds, heartbeatSeconds);
  return { leaseSeconds, heartbeatSeconds };
}

function validateScheduling(reviewIntervalSeconds, retrySeconds, rateLimitRetrySeconds) {
  if (reviewIntervalSeconds < retrySeconds) {
    fail(
      "scheduling.reviewIntervalSeconds",
      "must be greater than or equal to scheduling.retrySeconds",
    );
  }
  if (rateLimitRetrySeconds < retrySeconds) {
    fail(
      "scheduling.rateLimitRetrySeconds",
      "must be greater than or equal to scheduling.retrySeconds",
    );
  }
}

function validateLeadership(leaseSeconds, heartbeatSeconds) {
  if (heartbeatSeconds >= leaseSeconds) {
    fail(
      "leadership.heartbeatSeconds",
      "must be less than leadership.leaseSeconds",
    );
  }
}

function normalizePolicy(policy = {}) {
  requireRecord(policy, "policy");
  rejectObjectKeys(
    policy,
    new Set(["automatic", "approvalRequired", "prohibited"]),
    "policy",
  );
  const normalized = {};
  const classified = new Set();
  for (const [name, fallback] of Object.entries(DEFAULTS.policy)) {
    const values = policy[name] ?? fallback;
    requireStringArray(values, `policy.${name}`);
    for (const action of values) {
      if (!ACTION_KINDS.has(action)) {
        fail(`policy.${name}`, `contains unsupported action kind ${JSON.stringify(action)}`);
      }
      if (classified.has(action)) {
        fail(`policy.${name}`, "must not classify an action more than once");
      }
      classified.add(action);
    }
    normalized[name] = [...values];
  }
  return normalized;
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
  return { higherRisk: { enabled, actionKinds: [...actionKinds] } };
}

function normalizeSelfRepair(selfRepair = {}) {
  requireRecord(selfRepair, "selfRepair");
  rejectObjectKeys(
    selfRepair,
    new Set(["enabled", "repository", "workstream", "requirements"]),
    "selfRepair",
  );
  const enabled = selfRepair.enabled ?? DEFAULTS.selfRepair.enabled;
  requireBoolean(enabled, "selfRepair.enabled");
  const requirements = selfRepair.requirements ?? [];
  requireStringArray(requirements, "selfRepair.requirements");
  if (new Set(requirements).size !== requirements.length) {
    fail("selfRepair.requirements", "must not contain duplicates");
  }
  if (
    requirements.some(
      (requirement) =>
        requirement.startsWith("repo:") || requirement.startsWith("delivery:"),
    )
  ) {
    fail(
      "selfRepair.requirements",
      "must not contain repo: or delivery: entries because PAN supplies them",
    );
  }
  if (enabled) {
    requireRepository(selfRepair.repository, "selfRepair.repository");
    requireString(selfRepair.workstream, "selfRepair.workstream");
  }
  return {
    enabled,
    repository: selfRepair.repository,
    workstream: selfRepair.workstream,
    requirements: [...requirements],
  };
}

function normalizeAttention(attention = {}) {
  requireRecord(attention, "attention");
  rejectObjectKeys(attention, new Set(["assignee"]), "attention");
  if (attention.assignee !== undefined) {
    requireOwner(attention.assignee, "attention.assignee");
  }
  return { assignee: attention.assignee ?? DEFAULTS.attention.assignee };
}

function normalizedConfig({
  configPath,
  identity,
  session,
  scheduling,
  leadership,
  policy,
  reviewPolicy,
  selfRepair,
  attention,
  migrationDiagnostics,
}) {
  return {
    version: 2,
    configPath: configPath ? path.resolve(configPath) : undefined,
    ...identity,
    session,
    scheduling,
    leadership,
    policy,
    reviewPolicy,
    selfRepair,
    attention,
    migrationDiagnostics,
  };
}

function domainConfigDocument(config) {
  return {
    version: 2,
    domain: config.domain,
    state: { branch: config.state.branch, path: config.state.path },
    session: {
      agent: removeUndefined(config.session.agent),
      productContextRoots: config.session.productContextRoots,
    },
    scheduling: config.scheduling,
    leadership: config.leadership,
    policy: config.policy,
    reviewPolicy: config.reviewPolicy,
    selfRepair: removeUndefined(config.selfRepair),
    attention: removeUndefined(config.attention),
  };
}

function migrationDiagnostics(config) {
  const { diagnostics } = migrateDomainConfigUnsafe(config);
  return diagnostics;
}

function migrateDomainConfigUnsafe(config) {
  const diagnostics = [
    "version: migrated domain configuration from version 1 to version 2",
    "agent: remapped to session.agent",
    "cadences.fullReviewSeconds: remapped to scheduling.reviewIntervalSeconds",
    "cadences.leaderLeaseSeconds: remapped to leadership.leaseSeconds",
    "cadences.leaderHeartbeatSeconds: remapped to leadership.heartbeatSeconds",
    "cadences.retrySeconds: remapped to scheduling.retrySeconds",
    "cadences.rateLimitRetrySeconds: remapped to scheduling.rateLimitRetrySeconds",
  ];
  for (const field of [
    "activePollSeconds",
    "idlePollSeconds",
    "notificationSeconds",
  ]) {
    if (config.cadences?.[field] !== undefined) {
      diagnostics.push(`cadences.${field}: obsolete host polling setting removed`);
    }
  }
  if (config.transcripts !== undefined) {
    diagnostics.push("transcripts: obsolete host transcript setting removed");
  }
  return { diagnostics };
}

function removeUndefined(record) {
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) => value !== undefined),
  );
}

function rejectUnexpectedKeys(config, allowed) {
  for (const key of Object.keys(config)) {
    if (RUNNER_ONLY_KEYS.has(key)) {
      fail(
        key,
        "is runner-only and must be kept in an independent runner profile",
      );
    }
    if (!allowed.has(key)) {
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

function optionalBoundedNumber(value, field, bounds) {
  return value === undefined ? undefined : boundedNumber(value, field, undefined, bounds);
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

function fail(field, correction) {
  throw new TypeError(
    `${field} ${correction}; correct the PAN domain config before retrying`,
  );
}
