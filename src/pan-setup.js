import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";

import { validateDomainConfig } from "./domain-config.js";
import { PanAssetService } from "./pan-assets.js";
import { ProcessClient } from "./process-client.js";
import { validateRunnerProfile } from "./runner-profile.js";
import { normalizeGitHubRepositoryUrl } from "./workstream-delivery.js";

const APPROVAL_MODES = ["prompt", "allow-all"];
const SETUP_MODES = ["create", "connect"];
const PROJECT_FIELD_PAGE_SIZE = 100;
const PROJECT_FIELD_SAFETY_LIMIT = 1_000;
const PROJECT_FIELDS_QUERY = `
  query($projectId: ID!, $cursor: String) {
    node(id: $projectId) {
      ... on ProjectV2 {
        fields(first: ${PROJECT_FIELD_PAGE_SIZE}, after: $cursor) {
          pageInfo {
            hasNextPage
            endCursor
          }
          nodes {
            __typename
            ... on ProjectV2Field {
              id
              name
              dataType
            }
            ... on ProjectV2SingleSelectField {
              id
              name
              options {
                name
              }
            }
            ... on ProjectV2IterationField {
              id
              name
              dataType
            }
          }
        }
      }
    }
  }
`;

export async function setupPanDomain(
  options = {},
  {
    gh,
    commands = new ProcessClient(),
    env = process.env,
    cwd = process.cwd(),
    hostname = os.hostname(),
    now = () => new Date(),
    input = process.stdin,
    output = process.stdout,
    ask,
    assetServiceFactory = (options) => new PanAssetService(options),
  } = {},
) {
  if (!gh?.run || !gh?.runJson) {
    throw new TypeError("gh must provide run() and runJson()");
  }

  const prompt = ask ?? createPrompt({ input, output });
  let closePrompt = ask === undefined;
  const created = [];
  try {
    const repositoryMode = options.repositoryMode ?? "create";
    validateSetupMode(repositoryMode, "repository");
    const repository = await resolveRepository(options.repository, {
      gh,
      prompt,
    });
    const [repositoryOwner, repositoryName] = repository.split("/");
    const directory = path.resolve(
      await answer(
        options.path,
        prompt,
        "Local clone path",
        path.resolve(cwd, "..", repositoryName),
      ),
    );
    const projectOwner = await answer(
      options.projectOwner,
      prompt,
      "GitHub Project owner",
      repositoryOwner,
    );
    const projectMode =
      options.projectMode ??
      (options.projectNumber === undefined ? "create" : "connect");
    validateSetupMode(projectMode, "project");
    const projectTitle =
      projectMode === "create"
        ? await answer(
            options.projectTitle,
            prompt,
            "GitHub Project title",
            "PAN",
          )
        : undefined;
    const projectNumber =
      projectMode === "connect"
        ? await positiveIntegerAnswer(
            options.projectNumber,
            prompt,
            "Existing GitHub Project number",
          )
        : undefined;
    const approvalMode = await answer(
      options.approvalMode,
      prompt,
      "Copilot tool approval mode (prompt or allow-all)",
      "prompt",
    );
    validateApprovalMode(approvalMode);
    const repositoryPath = await inspectRepositoryPath({
      directory,
      repository,
      repositoryMode,
      commands,
    });

    let project;
    let projectFieldPlan;
    if (projectMode === "connect") {
      project = normalizeProject(
        await gh.runJson([
          "project",
          "view",
          String(projectNumber),
          "--owner",
          projectOwner,
          "--format",
          "json",
        ]),
      );
      projectFieldPlan = await planProjectFields({
        gh,
        projectId: project.id,
        replaceDefaultStatus: false,
      });
    }

    if (repositoryMode === "create") {
      await gh.run([
        "repo",
        "create",
        repository,
        "--private",
        "--description",
        "Private PAN domain data.",
      ]);
      created.push(`repository ${repository}`);
    } else {
      await verifyPrivateRepository({ gh, repository });
    }

    if (!repositoryPath.exists) {
      await gh.run(["repo", "clone", repository, directory]);
    }

    if (projectMode === "create") {
      project = normalizeProject(
        await gh.runJson([
          "project",
          "create",
          "--owner",
          projectOwner,
          "--title",
          projectTitle,
          "--format",
          "json",
        ]),
      );
      created.push(`Project ${projectOwner}/${project.number}`);
      projectFieldPlan = await planProjectFields({
        gh,
        projectId: project.id,
        replaceDefaultStatus: true,
      });
    }

    const date = now().toISOString().slice(0, 10);
    const machine = hostname.trim();
    if (!machine) {
      throw new TypeError("machine name must be a non-empty string");
    }
    const runnerPath = await resolveRunnerProfilePath(directory, machine);
    const configPath = path.join(directory, "pan.json");
    const configSetup = await existingOrStarterConfig({
      configPath,
      repository,
      projectOwner,
      projectNumber: project.number,
      directory,
    });
    const runnerSetup = await existingOrStarterRunner({
      runnerPath,
      configPath,
      repository,
      projectOwner,
      projectNumber: project.number,
      machine,
      approvalMode,
      directory,
      env,
    });
    const config = configSetup.document;
    const runner = runnerSetup.document;

    validateDomainConfig(config);
    validateRunnerProfile(runner, { profilePath: runnerPath });

    const managedFiles = [
      {
        path: configPath,
        content: configSetup.content,
        preserveExisting: !configSetup.write,
        commitWhenMatching: configSetup.write,
      },
      {
        path: runnerPath,
        content: runnerSetup.content,
        preserveExisting: !runnerSetup.write,
        commitWhenMatching: runnerSetup.write,
      },
      {
        path: path.join(
          directory,
          "workstreams",
          "getting-started",
          "README.md",
        ),
        content: starterWorkstream({
          owner: repositoryOwner,
          date,
          projectUrl: project.url,
        }),
        preserveExisting: true,
      },
    ];
    const readmePath = path.join(directory, "README.md");
    managedFiles.push({
      path: readmePath,
      content: domainReadme({ repository, projectUrl: project.url }),
      preserveExisting: true,
    });
    const { changes, commitPaths } =
      await planManagedFileChanges(managedFiles);
    if (repositoryPath.exists && changes.length > 0) {
      await requireCleanManagedPaths({
        commands,
        directory,
        paths: changes.map((change) => change.path),
      });
    }
    await gh.run([
      "project",
      "link",
      String(project.number),
      "--owner",
      projectOwner,
      "--repo",
      repository,
    ]);
    await applyProjectFieldPlan({
      gh,
      projectOwner,
      projectNumber: project.number,
      plan: projectFieldPlan,
    });

    await mkdir(path.join(directory, "workstreams", "getting-started"), {
      recursive: true,
    });
    await mkdir(path.dirname(runnerPath), { recursive: true });
    await Promise.all(
      changes.map((change) => writeFile(change.path, change.content, "utf8")),
    );

    let committed = false;
    if (commitPaths.length > 0) {
      const relativePaths = commitPaths.map((candidate) =>
        path.relative(directory, candidate),
      );
      await commands.run("git", [
        "-C",
        directory,
        "add",
        "--",
        ...relativePaths,
      ]);
      const staged = await commands.run("git", [
        "-C",
        directory,
        "diff",
        "--cached",
        "--name-only",
        "--",
        ...relativePaths,
      ]);
      if (changes.length > 0 || staged.trim()) {
        await commands.run("git", [
          "-C",
          directory,
          "commit",
          "-m",
          "Bootstrap PAN domain",
        ]);
        committed = true;
      }
    }
    if (
      committed ||
      (await setupCommitNeedsPush({
        commands,
        directory,
      }))
    ) {
      await commands.run("git", [
        "-C",
        directory,
        "push",
        "--set-upstream",
        "origin",
        "HEAD",
      ]);
    }

    const result = {
      repository,
      directory,
      configPath,
      projectOwner,
      projectNumber: project.number,
      projectUrl: project.url,
      runnerProfilePath: runnerPath,
      approvalMode,
      runnerOnline: runner.online,
      repositoryMode,
      projectMode,
    };
    if (options.installAssets) {
      try {
        result.assets = await assetServiceFactory({ env }).install();
      } catch (error) {
        result.assets = {
          status: "failed",
          diagnostics: [error.message],
          ...(error.status ? { details: error.status } : {}),
        };
      }
    }
    return result;
  } catch (error) {
    const suffix =
      created.length > 0
        ? ` Created ${created.join(" and ")}; PAN does not delete remote resources automatically.`
        : "";
    throw new Error(`PAN setup failed: ${error.message}.${suffix}`, {
      cause: error,
    });
  } finally {
    if (closePrompt) {
      prompt.close();
    }
  }
}

async function resolveRepository(repository, { gh, prompt }) {
  if (repository?.trim()) {
    validateRepository(repository);
    return repository.trim();
  }
  const owner = (
    await gh.run(["api", "user", "--jq", ".login"])
  ).trim();
  const value = await answer(
    undefined,
    prompt,
    "Private domain repository (owner/name)",
    `${owner}/pan-domain`,
  );
  validateRepository(value);
  return value;
}

async function planProjectFields({
  gh,
  projectId,
  replaceDefaultStatus,
}) {
  const manifest = JSON.parse(
    await readFile(
      new URL("../schema/project-fields.json", import.meta.url),
      "utf8",
    ),
  );
  const fields = await listProjectFields({ gh, projectId });
  const status = fields.find((field) => field.name === "Status");
  const missing = [];
  for (const field of manifest.fields) {
    const existing = fields.find(
      (candidate) =>
        typeof candidate?.name === "string" &&
        candidate.name.toLowerCase() === field.name.toLowerCase(),
    );
    if (existing && !(field.name === "Status" && replaceDefaultStatus)) {
      validateExistingProjectField(existing, field);
      continue;
    }
    missing.push(field);
  }
  if (status && replaceDefaultStatus && !status.id) {
    throw new Error("The new Project Status field did not include an ID");
  }
  return {
    deleteStatusId: status && replaceDefaultStatus ? status.id : undefined,
    missing,
  };
}

async function listProjectFields({ gh, projectId }) {
  const fields = [];
  const cursors = new Set();
  let cursor;
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
    if (fields.length + page.nodes.length > PROJECT_FIELD_SAFETY_LIMIT) {
      throw new Error(
        `Project fields exceed the ${PROJECT_FIELD_SAFETY_LIMIT}-field safety limit`,
      );
    }
    fields.push(...page.nodes.filter(Boolean));
    if (page.pageInfo?.hasNextPage) {
      cursor = page.pageInfo.endCursor;
      if (!cursor || cursors.has(cursor)) {
        throw new Error("GitHub returned a repeated or missing Project field cursor");
      }
      cursors.add(cursor);
    } else {
      cursor = undefined;
    }
  } while (cursor);
  return fields;
}

async function applyProjectFieldPlan({
  gh,
  projectOwner,
  projectNumber,
  plan,
}) {
  if (plan.deleteStatusId) {
    await gh.run(["project", "field-delete", "--id", plan.deleteStatusId]);
  }
  for (const field of plan.missing) {
    const args = [
      "project",
      "field-create",
      String(projectNumber),
      "--owner",
      projectOwner,
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

function domainConfig({
  repository,
  projectOwner,
  projectNumber,
  directory,
}) {
  return {
    version: 2,
    domain: {
      repository,
      projectOwner,
      projectNumber,
      path: directory,
    },
    state: {
      branch: "pan-state",
      path: ".pan",
    },
    session: {
      agent: {
        name: "pan",
      },
      productContextRoots: [],
    },
    scheduling: {
      enabled: false,
    },
  };
}

function starterRunnerProfile({
  repository,
  projectOwner,
  projectNumber,
  machine,
  approvalMode,
  directory,
  env,
}) {
  const localAppData =
    env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
  const machineRoot = path.join(localAppData, "PAN", fileSlug(machine));
  return {
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
      path: directory,
    },
    repositories: {},
    workspaceRoot: path.join(machineRoot, "worktrees"),
    stateDirectory: path.join(machineRoot, "runner-state"),
    terminal: {
      type: "windows-terminal",
    },
    copilot: {
      approvalMode,
    },
  };
}

async function resolveRunnerProfilePath(directory, machine) {
  const runnersPath = path.join(directory, "runners");
  const filename = `${fileSlug(machine)}.json`;
  let entries;
  try {
    entries = await readdir(runnersPath, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") {
      return path.join(runnersPath, filename);
    }
    throw error;
  }
  const matches = entries.filter(
    (entry) =>
      entry.isFile() && entry.name.toLowerCase() === filename.toLowerCase(),
  );
  if (matches.length > 1) {
    throw new Error(`Multiple runner profiles match machine ${machine}`);
  }
  return path.join(runnersPath, matches[0]?.name ?? filename);
}

async function verifyPrivateRepository({ gh, repository }) {
  const result = await gh.runJson([
    "repo",
    "view",
    repository,
    "--json",
    "nameWithOwner,isPrivate",
  ]);
  if (
    typeof result?.nameWithOwner !== "string" ||
    result.nameWithOwner.toLowerCase() !== repository.toLowerCase()
  ) {
    throw new Error(`GitHub did not return the expected repository ${repository}`);
  }
  if (result.isPrivate !== true) {
    throw new Error("PAN domain repositories must be private");
  }
}

function validateExistingProjectField(existing, required) {
  const expectsSelect = required.type === "single_select";
  if (
    (expectsSelect && existing.__typename !== "ProjectV2SingleSelectField") ||
    (!expectsSelect &&
      (existing.__typename !== "ProjectV2Field" ||
        existing.dataType !== "TEXT"))
  ) {
    throw new Error(
      `Existing Project field ${required.name} has an incompatible type`,
    );
  }
  if (!expectsSelect) {
    return;
  }
  const actualOptions = new Set(
    (existing.options ?? []).map((option) =>
      typeof option === "string" ? option : option.name,
    ),
  );
  const missing = required.options.filter((option) => !actualOptions.has(option));
  if (missing.length > 0) {
    throw new Error(
      `Existing Project field ${required.name} is missing options: ${missing.join(", ")}`,
    );
  }
}

function normalizeProject(project) {
  const number = Number(project?.number);
  if (!Number.isInteger(number) || number < 1) {
    throw new Error("GitHub did not return a valid Project number");
  }
  if (typeof project.id !== "string" || !project.id) {
    throw new Error("GitHub did not return a valid Project ID");
  }
  return {
    id: project.id,
    number,
    url:
      typeof project.url === "string" && project.url
        ? project.url
        : undefined,
  };
}

function createPrompt({ input, output }) {
  const readline = createInterface({ input, output });
  return {
    async question(label, defaultValue) {
      const suffix = defaultValue ? ` [${defaultValue}]` : "";
      const value = await readline.question(`${label}${suffix}: `);
      return value.trim() || defaultValue;
    },
    close() {
      readline.close();
    },
  };
}

async function answer(value, prompt, label, defaultValue) {
  const resolved =
    value === undefined
      ? await prompt.question(label, defaultValue)
      : value;
  if (typeof resolved !== "string" || !resolved.trim()) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return resolved.trim();
}

async function positiveIntegerAnswer(value, prompt, label) {
  const resolved = await answer(
    value === undefined ? undefined : String(value),
    prompt,
    label,
    undefined,
  );
  const parsed = Number(resolved);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new TypeError(`${label} must be a positive integer`);
  }
  return parsed;
}

async function inspectRepositoryPath({
  directory,
  repository,
  repositoryMode,
  commands,
}) {
  let entry;
  try {
    entry = await stat(directory);
  } catch (error) {
    if (error.code === "ENOENT") {
      return { exists: false };
    }
    throw error;
  }
  if (repositoryMode !== "connect") {
    throw new Error(
      `Local clone path already exists: ${directory}. Choose a new empty location`,
    );
  }
  if (!entry.isDirectory()) {
    throw new Error(`Local domain path is not a directory: ${directory}`);
  }
  const [root, remote] = await Promise.all([
    commands.run("git", ["-C", directory, "rev-parse", "--show-toplevel"]),
    commands.run("git", ["-C", directory, "remote", "get-url", "origin"]),
  ]);
  if (!samePath(root.trim(), directory)) {
    throw new Error(`Local domain path must be the repository root: ${directory}`);
  }
  const actualRepository = normalizeGitHubRepositoryUrl(remote.trim());
  if (actualRepository?.toLowerCase() !== repository.toLowerCase()) {
    throw new Error(
      `Local domain origin is ${actualRepository ?? "not a GitHub repository"}, expected ${repository}`,
    );
  }
  return { exists: true };
}

async function existingOrStarterConfig({
  configPath,
  repository,
  projectOwner,
  projectNumber,
  directory,
}) {
  const existing = await readJsonIfExists(configPath, "PAN domain configuration");
  if (existing === undefined) {
    const document = domainConfig({
      repository,
      projectOwner,
      projectNumber,
      directory,
    });
    return { document, content: json(document), write: true };
  }
  const normalized = validateDomainConfig(existing.document, { configPath });
  assertDomainIdentity(normalized.domain, {
    repository,
    projectOwner,
    projectNumber,
    directory,
    label: "Existing PAN domain configuration",
  });
  return { ...existing, write: false };
}

async function existingOrStarterRunner({
  runnerPath,
  configPath,
  repository,
  projectOwner,
  projectNumber,
  machine,
  approvalMode,
  directory,
  env,
}) {
  const existing = await readJsonIfExists(runnerPath, "PAN runner profile");
  if (existing === undefined) {
    const document = starterRunnerProfile({
      repository,
      projectOwner,
      projectNumber,
      machine,
      approvalMode,
      directory,
      env,
    });
    document.domainConfigPath = configPath;
    return { document, content: json(document), write: true };
  }
  const normalized = validateRunnerProfile(existing.document, {
    profilePath: runnerPath,
  });
  assertDomainIdentity(normalized.store, {
    repository,
    projectOwner,
    projectNumber,
    directory,
    label: "Existing PAN runner profile",
  });
  if (
    normalized.store.repository === repository &&
    normalized.store.projectOwner === projectOwner &&
    normalized.store.projectNumber === projectNumber &&
    normalized.store.path !== undefined &&
    samePath(normalized.store.path, directory) &&
    normalized.domainConfigPath !== undefined &&
    samePath(normalized.domainConfigPath, configPath) &&
    normalized.copilot.approvalMode === approvalMode
  ) {
    return { ...existing, write: false };
  }
  const document = {
    ...existing.document,
    store: {
      ...existing.document.store,
      repository,
      projectOwner,
      projectNumber,
      path: directory,
    },
    domainConfigPath: configPath,
    copilot: {
      ...existing.document.copilot,
      approvalMode,
    },
  };
  validateRunnerProfile(document, { profilePath: runnerPath });
  return { document, content: json(document), write: true };
}

function assertDomainIdentity(
  actual,
  { repository, projectOwner, projectNumber, directory, label },
) {
  if (
    actual?.repository?.toLowerCase() !== repository.toLowerCase() ||
    actual?.projectOwner?.toLowerCase() !== projectOwner.toLowerCase() ||
    actual?.projectNumber !== projectNumber ||
    (actual.path !== undefined && !samePath(actual.path, directory))
  ) {
    throw new Error(`${label} targets a different PAN domain`);
  }
}

async function readJsonIfExists(candidate, label) {
  let source;
  try {
    source = await readFile(candidate, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  try {
    return { document: JSON.parse(source), content: source };
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${candidate}`, { cause: error });
  }
}

async function planManagedFileChanges(files) {
  const planned = await Promise.all(
    files.map(async (file) => {
      let existing;
      try {
        existing = await readFile(file.path, "utf8");
      } catch (error) {
        if (error.code !== "ENOENT") {
          throw error;
        }
      }
      const matches = existing === file.content;
      const preservesDifferentExisting =
        existing !== undefined && file.preserveExisting && !matches;
      const excludesMatchingExisting =
        matches && file.commitWhenMatching === false;
      return {
        file,
        change:
          matches || preservesDifferentExisting
            ? undefined
            : file,
        commitPath:
          preservesDifferentExisting || excludesMatchingExisting
            ? undefined
            : file.path,
      };
    }),
  );
  return {
    changes: planned.map(({ change }) => change).filter(Boolean),
    commitPaths: planned
      .map(({ commitPath }) => commitPath)
      .filter(Boolean),
  };
}

async function requireCleanManagedPaths({ commands, directory, paths }) {
  const relativePaths = paths.map((candidate) =>
    path.relative(directory, candidate),
  );
  const dirty = await commands.run("git", [
    "-C",
    directory,
    "status",
    "--porcelain",
    "--",
    ...relativePaths,
  ]);
  if (dirty.trim()) {
    throw new Error(
      `PAN setup-managed files have uncommitted changes: ${relativePaths.join(", ")}`,
    );
  }
}

function samePath(left, right) {
  const resolvedLeft = path.resolve(left);
  const resolvedRight = path.resolve(right);
  return process.platform === "win32"
    ? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase()
    : resolvedLeft === resolvedRight;
}

async function setupCommitNeedsPush({ commands, directory }) {
  const branch = await commands.run("git", [
    "-C",
    directory,
    "status",
    "--porcelain=v2",
    "--branch",
  ]);
  const upstream = /^# branch\.upstream .+$/m.test(branch);
  const ahead = Number(branch.match(/^# branch\.ab \+(\d+) -\d+$/m)?.[1] ?? 0);
  if (upstream && ahead === 0) {
    return false;
  }
  const subject = await commands.run("git", [
    "-C",
    directory,
    "log",
    "-1",
    "--format=%s",
  ]);
  return subject.trim() === "Bootstrap PAN domain";
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

function validateApprovalMode(approvalMode) {
  if (!APPROVAL_MODES.includes(approvalMode)) {
    throw new TypeError(
      `Copilot tool approval mode must be one of ${APPROVAL_MODES.join(", ")}`,
    );
  }
}

function validateSetupMode(mode, target) {
  if (!SETUP_MODES.includes(mode)) {
    throw new TypeError(
      `${target} mode must be one of ${SETUP_MODES.join(", ")}`,
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

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function domainReadme({ repository, projectUrl }) {
  return `# PAN domain

Private domain data for \`${repository}\`.

- Workstream narrative lives under \`workstreams/\`.
- Runner profiles live under \`runners/\`.
- Runtime configuration is in \`pan.json\`.
${projectUrl ? `- Backlog Project: ${projectUrl}\n` : ""}
The generated runner profile is offline until repositories and playbooks are
configured intentionally.
`;
}

function starterWorkstream({ owner, date, projectUrl }) {
  return `---
title: Getting Started
state: Active
owner: ${owner}
tags: [pan]
created: ${date}
updated: ${date}
---

# Getting Started

## Current State

The private PAN domain and backlog Project are initialized.

## Next Steps

- [ ] Replace this starter workstream with the first real area of work.
- [ ] Configure the offline runner profile before enabling it.

## Learnings

## Links

${projectUrl ? `- Backlog: ${projectUrl}` : ""}
`;
}
