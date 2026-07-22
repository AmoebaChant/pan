import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";

import { validateDomainConfig } from "./domain-config.js";
import { ProcessClient } from "./process-client.js";
import { validateRunnerProfile } from "./runner-profile.js";

const APPROVAL_MODES = ["prompt", "allow-all"];

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
  } = {},
) {
  if (!gh?.run || !gh?.runJson) {
    throw new TypeError("gh must provide run() and runJson()");
  }

  const prompt = ask ?? createPrompt({ input, output });
  let closePrompt = ask === undefined;
  const created = [];
  try {
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
    const projectTitle = await answer(
      options.projectTitle,
      prompt,
      "GitHub Project title",
      "PAN",
    );
    const approvalMode = await answer(
      options.approvalMode,
      prompt,
      "Copilot tool approval mode (prompt or allow-all)",
      "prompt",
    );
    validateApprovalMode(approvalMode);
    await requireMissingPath(directory);

    await gh.run([
      "repo",
      "create",
      repository,
      "--private",
      "--description",
      "Private PAN domain data.",
    ]);
    created.push(`repository ${repository}`);

    await gh.run(["repo", "clone", repository, directory]);

    const project = normalizeProject(
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

    await gh.run([
      "project",
      "link",
      String(project.number),
      "--owner",
      projectOwner,
      "--repo",
      repository,
    ]);
    await bootstrapProjectFields({
      gh,
      projectOwner,
      projectNumber: project.number,
    });

    const date = now().toISOString().slice(0, 10);
    const machine = hostname.trim();
    if (!machine) {
      throw new TypeError("machine name must be a non-empty string");
    }
    const config = domainConfig({
      repository,
      projectOwner,
      projectNumber: project.number,
      directory,
    });
    const runner = starterRunnerProfile({
      repository,
      projectOwner,
      projectNumber: project.number,
      machine,
      approvalMode,
      directory,
      env,
    });
    validateDomainConfig(config);
    validateRunnerProfile(runner);

    const runnerPath = path.join(
      directory,
      "runners",
      `${fileSlug(machine)}.json`,
    );
    const configPath = path.join(directory, "pan.json");
    await mkdir(path.join(directory, "workstreams", "getting-started"), {
      recursive: true,
    });
    await mkdir(path.dirname(runnerPath), { recursive: true });
    await Promise.all([
      writeFile(
        path.join(directory, "README.md"),
        domainReadme({ repository, projectUrl: project.url }),
        "utf8",
      ),
      writeFile(configPath, json(config), "utf8"),
      writeFile(runnerPath, json(runner), "utf8"),
      writeFile(
        path.join(
          directory,
          "workstreams",
          "getting-started",
          "README.md",
        ),
        starterWorkstream({
          owner: repositoryOwner,
          date,
          projectUrl: project.url,
        }),
        "utf8",
      ),
    ]);

    await commands.run("git", ["-C", directory, "add", "--all"]);
    await commands.run("git", [
      "-C",
      directory,
      "commit",
      "-m",
      "Bootstrap PAN domain",
    ]);
    await commands.run("git", [
      "-C",
      directory,
      "push",
      "--set-upstream",
      "origin",
      "HEAD",
    ]);

    return {
      repository,
      directory,
      configPath,
      projectOwner,
      projectNumber: project.number,
      projectUrl: project.url,
      runnerProfilePath: runnerPath,
      approvalMode,
      runnerOnline: false,
    };
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

async function bootstrapProjectFields({ gh, projectOwner, projectNumber }) {
  const manifest = JSON.parse(
    await readFile(
      new URL("../schema/project-fields.json", import.meta.url),
      "utf8",
    ),
  );
  const listed = await gh.runJson([
    "project",
    "field-list",
    String(projectNumber),
    "--owner",
    projectOwner,
    "--format",
    "json",
  ]);
  const fields = Array.isArray(listed) ? listed : listed.fields;
  if (!Array.isArray(fields)) {
    throw new Error("gh project field-list returned an unexpected response");
  }
  const status = fields.find((field) => field.name === "Status");
  if (status) {
    if (!status.id) {
      throw new Error("The new Project Status field did not include an ID");
    }
    await gh.run(["project", "field-delete", "--id", status.id]);
  }

  for (const field of manifest.fields) {
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
    version: 1,
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
    agent: {
      name: "pan",
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

function normalizeProject(project) {
  const number = Number(project?.number);
  if (!Number.isInteger(number) || number < 1) {
    throw new Error("gh project create did not return a valid Project number");
  }
  return {
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

async function requireMissingPath(directory) {
  try {
    await stat(directory);
  } catch (error) {
    if (error.code === "ENOENT") {
      return;
    }
    throw error;
  }
  throw new Error(
    `Local clone path already exists: ${directory}. Choose a new empty location`,
  );
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
