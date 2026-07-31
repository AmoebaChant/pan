import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  defaultMachineConfigPath,
  defaultSharedDomainConfig,
  GitHubDomainConfigStore,
  MACHINE_DOMAIN_CONFIG_KIND,
  MACHINE_DOMAIN_CONFIG_VERSION,
  readMachineDomainConfig,
  writeMachineDomainConfig,
} from "./github-domain-config.js";
import { GhCommandError } from "./gh-client.js";
import { validateRunnerProfile } from "./runner-profile.js";

const PROJECT_FIELD_PAGE_SIZE = 100;
const PROJECT_FIELD_SAFETY_LIMIT = 1_000;
const PROJECT_FIELDS_QUERY = `
  query($projectId: ID!, $cursor: String) {
    node(id: $projectId) {
      ... on ProjectV2 {
        fields(first: ${PROJECT_FIELD_PAGE_SIZE}, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            __typename
            ... on ProjectV2Field { id name dataType }
            ... on ProjectV2SingleSelectField { id name options { name } }
          }
        }
      }
    }
  }
`;

export async function setupApiPanDomain(
  options = {},
  {
    gh,
    env = process.env,
    hostname = os.hostname(),
    assetServiceFactory,
  } = {},
) {
  if (!gh?.run || !gh?.runJson) {
    throw new TypeError("gh must provide run() and runJson()");
  }
  const repository = options.repository?.trim();
  validateRepository(repository);
  await validateGitHubAuthentication(gh);

  const repositoryState = await ensureRepository({
    gh,
    repository,
    mode: options.repositoryMode,
  });
  const configStore = new GitHubDomainConfigStore({ repository, gh });
  const existingShared = await configStore.read();

  let project;
  let shared;
  if (existingShared) {
    shared = existingShared.document;
    assertRequestedIdentity(shared, { ...options, repository });
    project = await readProject(
      gh,
      shared.domain.projectOwner,
      shared.domain.projectNumber,
    );
  } else {
    const owner = options.projectOwner?.trim() || repository.split("/")[0];
    project =
      options.projectNumber !== undefined || options.projectMode === "connect"
        ? await readProject(gh, owner, options.projectNumber)
        : await createProject(gh, owner, options.projectTitle ?? "Pan");
    shared = defaultSharedDomainConfig({
      repository,
      projectOwner: owner,
      projectNumber: project.number,
    });
  }

  const machine = hostname.trim();
  if (!machine) {
    throw new TypeError("machine name must be a non-empty string");
  }
  const configPath = path.resolve(
    options.localConfigPath ??
      options.path ??
      defaultMachineConfigPath(repository, env),
  );
  const localRoot = path.dirname(configPath);
  const existingMachine = await readJsonIfExists(configPath);
  if (existingMachine) {
    const normalized = await readMachineDomainConfig(configPath);
    if (
      normalized.domain.repository.toLowerCase() !== repository.toLowerCase()
    ) {
      throw new Error(
        "Existing machine configuration targets a different Pan domain",
      );
    }
  } else {
    await writeMachineDomainConfig(configPath, {
      version: MACHINE_DOMAIN_CONFIG_VERSION,
      kind: MACHINE_DOMAIN_CONFIG_KIND,
      domain: { repository },
      session: {
        agent: existingShared?.machineDefaults?.agent ?? {},
        productContextRoots:
          options.productContextRoots ??
          existingShared?.machineDefaults?.productContextRoots ??
          [],
      },
    });
  }

  let sharedResult = existingShared;
  try {
    if (!existingShared) {
      sharedResult = await configStore.write(shared);
    } else if (existingShared.requiresUpgrade) {
      sharedResult = await configStore.write(shared, {
        expectedSha: existingShared.sha,
        message: `Migrate Pan domain configuration from version ${existingShared.sourceVersion}`,
      });
    }
  } catch (error) {
    if (project.created) {
      const persisted = await configStore.read().catch(() => undefined);
      if (!persisted) {
        try {
          await gh.run([
            "project",
            "delete",
            String(project.number),
            "--owner",
            shared.domain.projectOwner,
            "--confirm",
          ]);
        } catch (cleanupError) {
          throw new Error(
            `${error.message}; cleanup of newly created Project ${project.number} also failed: ${cleanupError.message}`,
            { cause: error },
          );
        }
      }
    }
    throw error;
  }

  const fieldPlan = await planProjectFields(gh, project.id, {
    replaceDefaultStatus: !existingShared && project.created,
  });
  await ensureWorkstreamLabel(gh, repository);
  await gh.run([
    "project",
    "link",
    String(project.number),
    "--owner",
    shared.domain.projectOwner,
    "--repo",
    repository,
  ]);
  await applyProjectFieldPlan(
    gh,
    shared.domain.projectOwner,
    project.number,
    fieldPlan,
  );

  const runnerProfilePath = path.join(
    localRoot,
    "runners",
    `${fileSlug(machine)}.json`,
  );
  const runner = await existingOrStarterRunner({
    runnerProfilePath,
    configPath,
    repository,
    projectOwner: shared.domain.projectOwner,
    projectNumber: shared.domain.projectNumber,
    machine,
    approvalMode: options.approvalMode ?? "prompt",
    localRoot,
    env,
    selfRepair: resolveSelfRepairOptions(options),
  });
  await mkdir(path.dirname(runnerProfilePath), { recursive: true });
  await writeFile(
    runnerProfilePath,
    `${JSON.stringify(runner, null, 2)}\n`,
    "utf8",
  );

  const result = {
    repository,
    directory: localRoot,
    configPath,
    sharedConfigSha: sharedResult.sha,
    projectOwner: shared.domain.projectOwner,
    projectNumber: shared.domain.projectNumber,
    projectUrl: project.url,
    runnerProfilePath,
    approvalMode: runner.copilot.approvalMode,
    runnerOnline: runner.online,
    repositoryMode: repositoryState.created ? "create" : "connect",
    projectMode: project.created ? "create" : "connect",
    apiOnly: true,
  };
  if (options.installAssets && assetServiceFactory) {
    result.assets = await assetServiceFactory({ env }).install();
  }
  return result;
}

async function validateGitHubAuthentication(gh) {
  await gh.run(["auth", "status", "--hostname", "github.com"]);
  const headers = await gh.run(["api", "user", "--include"]);
  const scopeLine = headers
    .split(/\r?\n/)
    .find((line) => /^x-oauth-scopes:/i.test(line));
  if (!scopeLine) {
    return;
  }
  const scopes = new Set(
    scopeLine
      .slice(scopeLine.indexOf(":") + 1)
      .split(",")
      .map((scope) => scope.trim().toLowerCase())
      .filter(Boolean),
  );
  const repositoryAccess =
    scopes.has("repo") || scopes.has("public_repo") || scopes.has("contents");
  const projectAccess =
    scopes.has("project") ||
    scopes.has("write:project");
  if (!repositoryAccess || !projectAccess) {
    throw new Error(
      "GitHub authentication needs repository contents and Projects read/write access",
    );
  }
}

async function ensureRepository({ gh, repository, mode }) {
  let existing;
  try {
    existing = await gh.runJson([
      "repo",
      "view",
      repository,
      "--json",
      "nameWithOwner,isPrivate",
    ]);
  } catch (error) {
    if (!isNotFound(error)) {
      throw error;
    }
  }
  if (existing) {
    if (mode === "create") {
      throw new Error(`Repository ${repository} already exists`);
    }
    if (
      existing.nameWithOwner?.toLowerCase() !== repository.toLowerCase() ||
      existing.isPrivate !== true
    ) {
      throw new Error("Pan domain repositories must be private");
    }
    return { created: false };
  }
  if (mode === "connect") {
    throw new Error(`Repository ${repository} does not exist`);
  }
  await gh.run([
    "repo",
    "create",
    repository,
    "--private",
    "--description",
    "Private Pan domain data.",
  ]);
  return { created: true };
}

async function readProject(gh, owner, number) {
  if (!Number.isInteger(number) || number < 1) {
    throw new TypeError("A positive Project number is required");
  }
  return normalizeProject(
    await gh.runJson([
      "project",
      "view",
      String(number),
      "--owner",
      owner,
      "--format",
      "json",
    ]),
    false,
  );
}

async function createProject(gh, owner, title) {
  return normalizeProject(
    await gh.runJson([
      "project",
      "create",
      "--owner",
      owner,
      "--title",
      title,
      "--format",
      "json",
    ]),
    true,
  );
}

function normalizeProject(project, created) {
  const number = Number(project?.number);
  if (!Number.isInteger(number) || number < 1 || !project?.id) {
    throw new Error("GitHub did not return a valid Project");
  }
  return {
    id: project.id,
    number,
    url: project.url,
    created,
  };
}

async function ensureWorkstreamLabel(gh, repository) {
  const labels = gh.paginateRestJson
    ? await gh.paginateRestJson(`repos/${repository}/labels`)
    : await gh.runJson([
        "api",
        "--method",
        "GET",
        `repos/${repository}/labels?per_page=100`,
      ]);
  if (!Array.isArray(labels)) {
    throw new Error("GitHub returned an invalid label list");
  }
  const exact = labels.find((label) => label?.name === "Workstream");
  const conflicting = labels.find(
    (label) =>
      label?.name?.toLowerCase() === "workstream" &&
      label.name !== "Workstream",
  );
  if (conflicting) {
    throw new Error(
      `Conflicting label "${conflicting.name}" exists; rename it to exactly "Workstream"`,
    );
  }
  if (!exact) {
    await gh.run([
      "label",
      "create",
      "Workstream",
      "--repo",
      repository,
      "--color",
      "5319e7",
      "--description",
      "Long-lived Pan workstream; never add to the backlog Project.",
    ]);
  }
}

async function planProjectFields(gh, projectId, { replaceDefaultStatus }) {
  const manifest = JSON.parse(
    await readFile(
      new URL("../schema/project-fields.json", import.meta.url),
      "utf8",
    ),
  );
  const fields = await listProjectFields(gh, projectId);
  const status = fields.find((field) => field.name === "Status");
  const missing = [];
  for (const required of manifest.fields) {
    const existing = fields.find(
      (field) => field?.name?.toLowerCase() === required.name.toLowerCase(),
    );
    if (existing && !(required.name === "Status" && replaceDefaultStatus)) {
      validateExistingField(existing, required);
    } else {
      missing.push(required);
    }
  }
  return {
    deleteStatusId:
      status && replaceDefaultStatus ? status.id : undefined,
    missing,
  };
}

async function listProjectFields(gh, projectId) {
  const fields = [];
  let cursor;
  const cursors = new Set();
  do {
    const result = await gh.runJson([
      "api",
      "graphql",
      "-f",
      `query=${PROJECT_FIELDS_QUERY}`,
      "-f",
      `projectId=${projectId}`,
      ...(cursor ? ["-f", `cursor=${cursor}`] : []),
    ]);
    const page = result?.data?.node?.fields;
    if (!page || !Array.isArray(page.nodes)) {
      throw new Error("GitHub returned an invalid Project field connection");
    }
    fields.push(...page.nodes.filter(Boolean));
    if (fields.length > PROJECT_FIELD_SAFETY_LIMIT) {
      throw new Error("Project field safety limit exceeded");
    }
    if (page.pageInfo?.hasNextPage) {
      cursor = page.pageInfo.endCursor;
      if (!cursor || cursors.has(cursor)) {
        throw new Error("GitHub returned invalid Project field pagination");
      }
      cursors.add(cursor);
    } else {
      cursor = undefined;
    }
  } while (cursor);
  return fields;
}

async function applyProjectFieldPlan(gh, owner, number, plan) {
  if (plan.deleteStatusId) {
    await gh.run(["project", "field-delete", "--id", plan.deleteStatusId]);
  }
  for (const field of plan.missing) {
    const args = [
      "project",
      "field-create",
      String(number),
      "--owner",
      owner,
      "--name",
      field.name,
      "--data-type",
      field.type === "single_select" ? "SINGLE_SELECT" : "TEXT",
    ];
    if (field.type === "single_select") {
      args.push("--single-select-options", field.options.join(","));
    }
    await gh.run(args);
  }
}

function validateExistingField(existing, required) {
  const select = required.type === "single_select";
  if (
    (select && existing.__typename !== "ProjectV2SingleSelectField") ||
    (!select &&
      (existing.__typename !== "ProjectV2Field" ||
        existing.dataType !== "TEXT"))
  ) {
    throw new Error(
      `Existing Project field ${required.name} has an incompatible type`,
    );
  }
  if (select) {
    const options = new Set(
      (existing.options ?? []).map((option) => option.name ?? option),
    );
    const missing = required.options.filter((option) => !options.has(option));
    if (missing.length) {
      throw new Error(
        `Existing Project field ${required.name} is missing options: ${missing.join(", ")}`,
      );
    }
  }
}

async function existingOrStarterRunner({
  runnerProfilePath,
  configPath,
  repository,
  projectOwner,
  projectNumber,
  machine,
  approvalMode,
  localRoot,
  env,
  selfRepair,
}) {
  const existing = await readJsonIfExists(runnerProfilePath);
  if (existing) {
    const normalized = validateRunnerProfile(existing, {
      profilePath: runnerProfilePath,
    });
    if (
      normalized.store.repository.toLowerCase() !== repository.toLowerCase() ||
      normalized.store.projectOwner.toLowerCase() !==
        projectOwner.toLowerCase() ||
      normalized.store.projectNumber !== projectNumber
    ) {
      throw new Error("Existing runner profile targets a different Pan domain");
    }
    return applySelfRepair(
      {
        ...existing,
        domainConfigPath: configPath,
        store: {
          ...existing.store,
          repository,
          projectOwner,
          projectNumber,
          path: localRoot,
        },
        copilot: { ...existing.copilot, approvalMode },
      },
      selfRepair,
    );
  }
  const machineRoot = path.join(
    env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"),
    "PAN",
    fileSlug(machine),
  );
  return applySelfRepair(
    {
      version: 1,
      id: fileSlug(machine),
      machine,
      online: false,
      maxConcurrentDaemons: 1,
      capabilities: ["env:local"],
      store: {
        repository,
        projectOwner,
        projectNumber,
        path: localRoot,
      },
      repositories: {},
      workspaceRoot: path.join(machineRoot, "worktrees"),
      stateDirectory: path.join(machineRoot, "runner-state"),
      terminal: { type: "windows-terminal" },
      copilot: { approvalMode },
      domainConfigPath: configPath,
    },
    selfRepair,
  );
}

function resolveSelfRepairOptions(options) {
  if (
    options.selfRepairRepository === undefined &&
    options.selfRepairPath === undefined
  ) {
    return undefined;
  }
  if (
    !options.selfRepairRepository ||
    !path.isAbsolute(options.selfRepairPath ?? "")
  ) {
    throw new TypeError(
      "Pan self-repair setup requires a repository and absolute local checkout path",
    );
  }
  return {
    repository: options.selfRepairRepository,
    path: path.resolve(options.selfRepairPath),
    defaultBranch: options.selfRepairDefaultBranch ?? "main",
  };
}

function applySelfRepair(profile, selfRepair) {
  if (!selfRepair) {
    return profile;
  }
  const capability = `repo:${selfRepair.repository}`;
  const playbook = {
    id: "pan-self-repair",
    capacity: 1,
    capabilities: ["env:local", capability],
    repositories: [selfRepair.repository],
    instructions: [
      "Treat reported Pan failures as reusable product defects unless invalid domain data caused them.",
      "Preserve fail-closed mutation behavior and add regression coverage for every code change.",
      "Deliver fixes through the repository's normal branch-and-review workflow.",
    ],
  };
  const existingPlaybooks = profile.playbooks ?? [];
  return {
    ...profile,
    online: true,
    capabilities: [...new Set([...profile.capabilities, capability])],
    repositories: {
      ...profile.repositories,
      [selfRepair.repository]: {
        path: selfRepair.path,
        defaultBranch: selfRepair.defaultBranch,
      },
    },
    playbooks: existingPlaybooks.some(
      (candidate) => candidate.id === playbook.id,
    )
      ? existingPlaybooks
      : [playbook, ...existingPlaybooks],
  };
}

function assertRequestedIdentity(shared, options) {
  const expected = {
    repository: options.repository,
    projectOwner: options.projectOwner,
    projectNumber: options.projectNumber,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (
      value !== undefined &&
      String(shared.domain[key]).toLowerCase() !==
        String(value).toLowerCase()
    ) {
      throw new Error(
        `Existing shared pan.json conflicts with requested ${key}`,
      );
    }
  }
}

async function readJsonIfExists(candidate) {
  try {
    return JSON.parse(await readFile(candidate, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function validateRepository(repository) {
  if (
    typeof repository !== "string" ||
    !/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9._-]+$/.test(
      repository,
    )
  ) {
    throw new TypeError(
      "Private domain repository must use owner/name GitHub format",
    );
  }
}

function fileSlug(value) {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug) {
    throw new TypeError("machine name must contain a filename-safe character");
  }
  return slug;
}

function isNotFound(error) {
  return (
    (error instanceof GhCommandError || error instanceof Error) &&
    /(?:HTTP )?404|not found/i.test(error.stderr ?? error.message)
  );
}
