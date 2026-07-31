import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";

import { GhClient, GhCommandError } from "./gh-client.js";

export const SHARED_DOMAIN_CONFIG_VERSION = 3;
export const MACHINE_DOMAIN_CONFIG_VERSION = 1;
export const MACHINE_DOMAIN_CONFIG_KIND = "pan-machine";

export class GitHubDomainConfigStore {
  constructor({ repository, gh = new GhClient() } = {}) {
    validateRepository(repository, "repository");
    if (!gh?.runJson) {
      throw new TypeError("gh must provide runJson()");
    }
    this.repository = repository;
    this.gh = gh;
  }

  async read({ signal } = {}) {
    let response;
    try {
      response = await this.gh.runJson(
        ["api", "--method", "GET", `repos/${this.repository}/contents/pan.json`],
        { signal },
      );
    } catch (error) {
      if (isNotFound(error)) {
        return undefined;
      }
      throw error;
    }
    if (
      typeof response?.sha !== "string" ||
      typeof response?.content !== "string"
    ) {
      throw new Error("GitHub returned an invalid pan.json Contents response");
    }
    let document;
    try {
      document = JSON.parse(
        Buffer.from(response.content.replace(/\s/g, ""), "base64").toString(
          "utf8",
        ),
      );
    } catch (error) {
      throw new Error(
        `The shared pan.json in ${this.repository} is not valid JSON`,
        { cause: error },
      );
    }
    const normalized = normalizeSharedDocument(document);
    return {
      document: normalized.document,
      sha: response.sha,
      path: response.path ?? "pan.json",
      htmlUrl: response.html_url,
      sourceVersion: document.version,
      requiresUpgrade: document.version !== SHARED_DOMAIN_CONFIG_VERSION,
      machineDefaults: normalized.machineDefaults,
    };
  }

  async write(document, { expectedSha, message, signal } = {}) {
    const validated = validateSharedDomainConfig(document);
    if (
      validated.domain.repository.toLowerCase() !==
      this.repository.toLowerCase()
    ) {
      throw new Error(
        `Shared pan.json identifies ${validated.domain.repository}, not ${this.repository}`,
      );
    }
    if (
      expectedSha !== undefined &&
      (typeof expectedSha !== "string" || !expectedSha)
    ) {
      throw new TypeError("expectedSha must be a non-empty blob SHA");
    }
    const commitMessage =
      message ??
      (expectedSha
        ? "Update Pan domain configuration"
        : "Initialize Pan domain configuration");
    const content = Buffer.from(
      `${JSON.stringify(validated, null, 2)}\n`,
    ).toString("base64");
    let response;
    try {
      response = await this.gh.runJson(
        [
          "api",
          "--method",
          "PUT",
          `repos/${this.repository}/contents/pan.json`,
          "-f",
          `message=${commitMessage}`,
          "-f",
          `content=${content}`,
          ...(expectedSha ? ["-f", `sha=${expectedSha}`] : []),
        ],
        { signal },
      );
    } catch (error) {
      if (isConflict(error)) {
        throw new Error(
          "Shared Pan configuration changed on GitHub; fetch the latest pan.json and retry",
          { cause: error },
        );
      }
      throw error;
    }
    const sha = response?.content?.sha;
    if (typeof sha !== "string" || !sha) {
      throw new Error("GitHub did not confirm the pan.json blob SHA");
    }
    return { document: validated, sha, commit: response.commit };
  }

  async update(mutator, { expectedSha, message, signal } = {}) {
    if (typeof mutator !== "function") {
      throw new TypeError("mutator must be a function");
    }
    const current = await this.read({ signal });
    if (!current) {
      throw new Error(`Shared pan.json does not exist in ${this.repository}`);
    }
    if (expectedSha && current.sha !== expectedSha) {
      throw new Error(
        "Shared Pan configuration changed on GitHub; fetch the latest pan.json and retry",
      );
    }
    const next = await mutator(structuredClone(current.document));
    return this.write(next, {
      expectedSha: current.sha,
      message,
      signal,
    });
  }
}

export async function loadMachineDomainConfig(
  configPath,
  { gh = new GhClient() } = {},
) {
  const machine = await readMachineDomainConfig(configPath);
  const shared = await new GitHubDomainConfigStore({
    repository: machine.domain.repository,
    gh,
  }).read();
  if (!shared) {
    throw new Error(
      `The configured domain ${machine.domain.repository} has no pan.json on its default branch`,
    );
  }
  if (
    shared.document.domain.repository.toLowerCase() !==
    machine.domain.repository.toLowerCase()
  ) {
    throw new Error(
      "The local domain locator and shared pan.json identify different repositories",
    );
  }
  return {
    version: SHARED_DOMAIN_CONFIG_VERSION,
    configPath: path.resolve(configPath),
    sharedConfigSha: shared.sha,
    domain: {
      ...shared.document.domain,
      path: path.dirname(path.resolve(configPath)),
    },
    session: {
      agent: {
        ...shared.document.agent,
        ...machine.session.agent,
      },
      productContextRoots: machine.session.productContextRoots,
    },
    scheduling: {
      ...shared.document.scheduling,
      triageAuthority: shared.document.policy.triageAuthority,
    },
    policy: shared.document.policy,
    migration: shared.document.migration,
  };
}

export async function readMachineDomainConfig(configPath) {
  let document;
  try {
    document = JSON.parse(await readFile(configPath, "utf8"));
  } catch (error) {
    throw new Error(
      `Unable to read Pan machine config ${configPath}: ${error.message}`,
      { cause: error },
    );
  }
  return validateMachineDomainConfig(document);
}

export async function writeMachineDomainConfig(configPath, document) {
  const validated = validateMachineDomainConfig(document);
  const target = path.resolve(configPath);
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(
      temporary,
      `${JSON.stringify(validated, null, 2)}\n`,
      "utf8",
    );
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export function validateSharedDomainConfig(document) {
  requireRecord(document, "shared domain config");
  rejectKeys(
    document,
    new Set(["version", "domain", "agent", "scheduling", "policy", "migration"]),
    "shared domain config",
  );
  if (document.version !== SHARED_DOMAIN_CONFIG_VERSION) {
    throw new TypeError(
      `version must be ${SHARED_DOMAIN_CONFIG_VERSION} for shared pan.json`,
    );
  }
  requireRecord(document.domain, "domain");
  rejectKeys(
    document.domain,
    new Set(["repository", "projectOwner", "projectNumber"]),
    "domain",
  );
  validateRepository(document.domain.repository, "domain.repository");
  requireOwner(document.domain.projectOwner, "domain.projectOwner");
  requireInteger(document.domain.projectNumber, "domain.projectNumber");

  requireRecord(document.agent, "agent");
  rejectKeys(
    document.agent,
    new Set(["name", "model", "turnTimeoutSeconds", "maxAiCredits"]),
    "agent",
  );
  requireString(document.agent.name, "agent.name");
  optionalString(document.agent.model, "agent.model");
  optionalNumber(document.agent.turnTimeoutSeconds, "agent.turnTimeoutSeconds", {
    minimum: 30,
    maximum: 3_600,
  });
  optionalNumber(document.agent.maxAiCredits, "agent.maxAiCredits", {
    minimum: 1,
    maximum: 1_000,
  });

  const scheduling = normalizeScheduling(document.scheduling);
  const policy = document.policy ?? {};
  requireRecord(policy, "policy");
  rejectKeys(policy, new Set(["triageAuthority"]), "policy");
  const triageAuthority = policy.triageAuthority ?? "report";
  if (!["report", "triage-fields"].includes(triageAuthority)) {
    throw new TypeError(
      'policy.triageAuthority must be "report" or "triage-fields"',
    );
  }
  const migration = document.migration;
  if (migration !== undefined) {
    requireRecord(migration, "migration");
    rejectKeys(migration, new Set(["workstreamReportIssue"]), "migration");
    if (migration.workstreamReportIssue !== undefined) {
      requireInteger(
        migration.workstreamReportIssue,
        "migration.workstreamReportIssue",
      );
    }
  }
  return {
    version: SHARED_DOMAIN_CONFIG_VERSION,
    domain: { ...document.domain },
    agent: removeUndefined({ ...document.agent }),
    scheduling,
    policy: { triageAuthority },
    ...(migration ? { migration: { ...migration } } : {}),
  };
}

export function validateMachineDomainConfig(document) {
  requireRecord(document, "machine domain config");
  rejectKeys(
    document,
    new Set(["version", "kind", "domain", "session"]),
    "machine domain config",
  );
  if (document.version !== MACHINE_DOMAIN_CONFIG_VERSION) {
    throw new TypeError(
      `machine config version must be ${MACHINE_DOMAIN_CONFIG_VERSION}`,
    );
  }
  if (document.kind !== MACHINE_DOMAIN_CONFIG_KIND) {
    throw new TypeError(`machine config kind must be "${MACHINE_DOMAIN_CONFIG_KIND}"`);
  }
  requireRecord(document.domain, "domain");
  rejectKeys(document.domain, new Set(["repository"]), "domain");
  validateRepository(document.domain.repository, "domain.repository");
  const session = document.session ?? {};
  requireRecord(session, "session");
  rejectKeys(session, new Set(["agent", "productContextRoots"]), "session");
  const agent = session.agent ?? {};
  requireRecord(agent, "session.agent");
  rejectKeys(
    agent,
    new Set(["executable", "model"]),
    "session.agent",
  );
  optionalString(agent.executable, "session.agent.executable");
  optionalString(agent.model, "session.agent.model");
  const roots = session.productContextRoots ?? [];
  if (!Array.isArray(roots)) {
    throw new TypeError("session.productContextRoots must be an array");
  }
  const labels = new Set();
  for (const [index, root] of roots.entries()) {
    requireRecord(root, `session.productContextRoots[${index}]`);
    rejectKeys(
      root,
      new Set(["label", "path"]),
      `session.productContextRoots[${index}]`,
    );
    requireString(root.label, `session.productContextRoots[${index}].label`);
    if (labels.has(root.label)) {
      throw new TypeError("product-context root labels must be unique");
    }
    labels.add(root.label);
    requireString(root.path, `session.productContextRoots[${index}].path`);
    if (!path.isAbsolute(root.path)) {
      throw new TypeError(
        `session.productContextRoots[${index}].path must be absolute`,
      );
    }
  }
  return {
    version: MACHINE_DOMAIN_CONFIG_VERSION,
    kind: MACHINE_DOMAIN_CONFIG_KIND,
    domain: { repository: document.domain.repository },
    session: {
      agent: removeUndefined({ ...agent }),
      productContextRoots: roots.map((root) => ({
        label: root.label,
        path: path.resolve(root.path),
      })),
    },
  };
}

export function defaultSharedDomainConfig({
  repository,
  projectOwner,
  projectNumber,
}) {
  return validateSharedDomainConfig({
    version: SHARED_DOMAIN_CONFIG_VERSION,
    domain: { repository, projectOwner, projectNumber },
    agent: { name: "pan" },
    scheduling: {
      enabled: false,
      startup: "immediate",
      reviewIntervalSeconds: 86_400,
      retrySeconds: 60,
      rateLimitRetrySeconds: 900,
    },
    policy: { triageAuthority: "report" },
  });
}

function normalizeSharedDocument(document) {
  if (document?.version === SHARED_DOMAIN_CONFIG_VERSION) {
    return { document: validateSharedDomainConfig(document) };
  }
  if (document?.version === 2) {
    requireRecord(document.domain, "domain");
    requireRecord(document.session?.agent, "session.agent");
    return {
      document: validateSharedDomainConfig({
        version: SHARED_DOMAIN_CONFIG_VERSION,
        domain: {
          repository: document.domain.repository,
          projectOwner: document.domain.projectOwner,
          projectNumber: document.domain.projectNumber,
        },
        agent: removeUndefined({
          name: document.session.agent.name,
          model: document.session.agent.model,
          turnTimeoutSeconds: document.session.agent.turnTimeoutSeconds,
          maxAiCredits: document.session.agent.maxAiCredits,
        }),
        scheduling: removeUndefined({
          enabled: document.scheduling?.enabled,
          startup: document.scheduling?.startup,
          reviewIntervalSeconds: document.scheduling?.reviewIntervalSeconds,
          retrySeconds: document.scheduling?.retrySeconds,
          rateLimitRetrySeconds:
            document.scheduling?.rateLimitRetrySeconds,
        }),
        policy: {
          triageAuthority:
            document.scheduling?.triageAuthority ?? "report",
        },
      }),
      machineDefaults: {
        agent: removeUndefined({
          executable: document.session.agent.executable,
        }),
        productContextRoots: document.session.productContextRoots ?? [],
      },
    };
  }
  if (document?.version === 1) {
    requireRecord(document.domain, "domain");
    requireRecord(document.agent, "agent");
    return {
      document: validateSharedDomainConfig({
        version: SHARED_DOMAIN_CONFIG_VERSION,
        domain: {
          repository: document.domain.repository,
          projectOwner: document.domain.projectOwner,
          projectNumber: document.domain.projectNumber,
        },
        agent: removeUndefined({
          name: document.agent.name,
          model: document.agent.model,
          turnTimeoutSeconds: document.agent.turnTimeoutSeconds,
          maxAiCredits: document.agent.maxAiCredits,
        }),
        scheduling: {
          enabled: false,
          startup: "immediate",
          reviewIntervalSeconds:
            document.cadences?.fullReviewSeconds ?? 86_400,
          retrySeconds: document.cadences?.retrySeconds ?? 60,
          rateLimitRetrySeconds:
            document.cadences?.rateLimitRetrySeconds ?? 900,
        },
        policy: { triageAuthority: "report" },
      }),
      machineDefaults: {
        agent: removeUndefined({ executable: document.agent.executable }),
        productContextRoots: [],
      },
    };
  }
  throw new TypeError(
    `Shared pan.json version must be 1, 2, or ${SHARED_DOMAIN_CONFIG_VERSION}`,
  );
}

export function defaultMachineConfigPath(repository, env = process.env) {
  validateRepository(repository, "repository");
  const localAppData =
    env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
  return path.join(
    localAppData,
    "PAN",
    "domains",
    repository.toLowerCase().replaceAll("/", "--"),
    "pan-local.json",
  );
}

function normalizeScheduling(scheduling = {}) {
  requireRecord(scheduling, "scheduling");
  rejectKeys(
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
  const normalized = {
    enabled: scheduling.enabled ?? true,
    startup: scheduling.startup ?? "immediate",
    reviewIntervalSeconds: scheduling.reviewIntervalSeconds ?? 86_400,
    retrySeconds: scheduling.retrySeconds ?? 60,
    rateLimitRetrySeconds: scheduling.rateLimitRetrySeconds ?? 900,
  };
  if (typeof normalized.enabled !== "boolean") {
    throw new TypeError("scheduling.enabled must be a boolean");
  }
  if (!["immediate", "after-interval", "manual"].includes(normalized.startup)) {
    throw new TypeError("scheduling.startup is invalid");
  }
  optionalNumber(
    normalized.reviewIntervalSeconds,
    "scheduling.reviewIntervalSeconds",
    { minimum: 300, maximum: 604_800 },
  );
  optionalNumber(normalized.retrySeconds, "scheduling.retrySeconds", {
    minimum: 5,
    maximum: 3_600,
  });
  optionalNumber(
    normalized.rateLimitRetrySeconds,
    "scheduling.rateLimitRetrySeconds",
    { minimum: 60, maximum: 86_400 },
  );
  if (normalized.reviewIntervalSeconds < normalized.retrySeconds) {
    throw new TypeError(
      "scheduling.reviewIntervalSeconds must be greater than or equal to scheduling.retrySeconds",
    );
  }
  if (normalized.rateLimitRetrySeconds < normalized.retrySeconds) {
    throw new TypeError(
      "scheduling.rateLimitRetrySeconds must be greater than or equal to scheduling.retrySeconds",
    );
  }
  return normalized;
}

function validateRepository(value, field) {
  requireString(value, field);
  if (
    !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9._-]+$/.test(
      value,
    )
  ) {
    throw new TypeError(`${field} must use owner/name GitHub repository format`);
  }
}

function requireOwner(value, field) {
  requireString(value, field);
  if (
    !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(value)
  ) {
    throw new TypeError(`${field} must be a GitHub user or organization name`);
  }
}

function requireRecord(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
}

function rejectKeys(value, allowed, field) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new TypeError(`${field}.${key} is not supported`);
    }
  }
}

function requireString(value, field) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
}

function optionalString(value, field) {
  if (value !== undefined) {
    requireString(value, field);
  }
}

function requireInteger(value, field) {
  if (!Number.isInteger(value) || value < 1) {
    throw new TypeError(`${field} must be a positive integer`);
  }
}

function optionalNumber(value, field, { minimum, maximum }) {
  if (
    value !== undefined &&
    (typeof value !== "number" ||
      !Number.isFinite(value) ||
      value < minimum ||
      value > maximum)
  ) {
    throw new TypeError(`${field} must be from ${minimum} through ${maximum}`);
  }
}

function removeUndefined(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  );
}

function isNotFound(error) {
  return (
    (error instanceof GhCommandError || error instanceof Error) &&
    /(?:HTTP )?404|not found/i.test(error.stderr ?? error.message ?? "")
  );
}

function isConflict(error) {
  return (
    error instanceof GhCommandError &&
    /(?:HTTP )?(409|422)|sha.*does not match|conflict/i.test(
      error.stderr ?? error.message,
    )
  );
}
