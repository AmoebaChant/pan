import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { GhClient } from "./gh-client.js";
import { PanStore } from "./pan-store.js";
import {
  parseWorkstreamIssueUrl,
  WORKSTREAM_LABEL,
  WorkstreamIssueStore,
} from "./workstream-issue-store.js";

export const WORKSTREAM_MIGRATION_REPORT_VERSION = 1;

export class WorkstreamMigration {
  constructor({
    repository,
    projectOwner,
    projectNumber,
    gh = new GhClient(),
    store = new PanStore({
      repository,
      projectOwner,
      projectNumber,
      gh,
    }),
    workstreams = new WorkstreamIssueStore({ repository, gh }),
    now = () => new Date(),
  } = {}) {
    if (!repository || !projectOwner || !Number.isInteger(projectNumber)) {
      throw new TypeError(
        "repository, projectOwner, and projectNumber are required",
      );
    }
    this.repository = repository;
    this.projectOwner = projectOwner;
    this.projectNumber = projectNumber;
    this.gh = gh;
    this.store = store;
    this.workstreams = workstreams;
    this.now = now;
  }

  async run({
    dryRun = true,
    resume,
    createRemovalPullRequest = false,
    checkpoint,
    signal,
  } = {}) {
    if (checkpoint !== undefined && typeof checkpoint !== "function") {
      throw new TypeError("checkpoint must be a function");
    }
    const report = initializeReport({
      repository: this.repository,
      projectOwner: this.projectOwner,
      projectNumber: this.projectNumber,
      dryRun,
      resume,
      now: this.now,
    });
    try {
      const inventory = await this.#inventory(signal);
      report.defaultBranch = inventory.defaultBranch;
      report.sources = inventory.sources.map((source) => ({
        path: source.path,
        parentPath: source.parentPath,
        title: source.title,
        contentHash: source.contentHash,
      }));

      const mapping = new Map(Object.entries(report.mapping));
      const effectiveMapping = new Map(mapping);
      for (const source of inventory.sources) {
        if (mapping.has(source.path)) {
          report.skipped.push({
            kind: "workstream",
            source: source.path,
            reason: "present in resume mapping",
          });
          continue;
        }
        if (dryRun) {
          effectiveMapping.set(
            source.path,
            `(planned Workstream Issue for ${source.path})`,
          );
          report.planned.push({
            action: "create-workstream-issue",
            source: source.path,
            title: source.title,
          });
          continue;
        }
        const url = await this.#createWorkstream(source, signal);
        mapping.set(source.path, url);
        effectiveMapping.set(source.path, url);
        report.mapping[source.path] = url;
        report.createdIssues.push({ source: source.path, url });
        await checkpoint?.(report);
      }

      await this.#applyHierarchy(inventory.sources, effectiveMapping, report, {
        dryRun,
        checkpoint,
        signal,
      });
      await this.#migrateTasks(effectiveMapping, report, {
        dryRun,
        checkpoint,
        signal,
      });

      if (!dryRun) {
        await this.#verify(inventory.sources, mapping, report, signal);
        if (
          createRemovalPullRequest &&
          report.errors.length === 0 &&
          report.verification.complete
        ) {
          report.removalPullRequest = await this.#createRemovalPullRequest(
            inventory,
            signal,
          );
          await checkpoint?.(report);
        } else if (createRemovalPullRequest) {
          report.skipped.push({
            kind: "file-removal",
            reason:
              "Workstream files were retained because migration verification was incomplete",
          });
        }
      }
    } catch (error) {
      report.errors.push({ phase: "migration", message: error.message });
    }
    report.completedAt = this.now().toISOString();
    report.complete =
      !dryRun &&
      report.errors.length === 0 &&
      report.verification.complete === true;
    return report;
  }

  async #inventory(signal) {
    const repository = await this.gh.runJson(
      ["api", "--method", "GET", `repos/${this.repository}`],
      { signal },
    );
    const defaultBranch = repository?.default_branch;
    if (!defaultBranch) {
      throw new Error("GitHub did not return the domain default branch");
    }
    const tree = await this.gh.runJson(
      [
        "api",
        "--method",
        "GET",
        `repos/${this.repository}/git/trees/${encodeURIComponent(defaultBranch)}?recursive=1`,
      ],
      { signal },
    );
    if (!Array.isArray(tree?.tree) || tree.truncated) {
      throw new Error(
        "GitHub could not provide a complete recursive domain repository tree",
      );
    }
    const paths = tree.tree
      .filter(
        (entry) =>
          entry.type === "blob" &&
          /^workstreams\/.+\/README\.md$/.test(entry.path),
      )
      .map((entry) => entry.path)
      .sort();
    const sources = [];
    for (const sourcePath of paths) {
      const content = await this.#readRepositoryFile(sourcePath, signal);
      const workstreamPath = sourcePath
        .slice("workstreams/".length, -"/README.md".length);
      const parentPath = workstreamPath.includes("/")
        ? workstreamPath.slice(0, workstreamPath.lastIndexOf("/"))
        : undefined;
      sources.push({
        path: workstreamPath,
        sourcePath,
        parentPath,
        title: workstreamTitle(content, workstreamPath),
        content,
        contentHash: await hashContent(content),
      });
    }
    const known = new Set(sources.map((source) => source.path));
    const missingParent = sources.find(
      (source) => source.parentPath && !known.has(source.parentPath),
    );
    if (missingParent) {
      throw new Error(
        `Workstream ${missingParent.path} has no parent README for ${missingParent.parentPath}`,
      );
    }
    return { defaultBranch, sources };
  }

  async #readRepositoryFile(sourcePath, signal) {
    const result = await this.gh.runJson(
      [
        "api",
        "--method",
        "GET",
        `repos/${this.repository}/contents/${sourcePath}`,
      ],
      { signal },
    );
    if (typeof result?.content !== "string") {
      throw new Error(`GitHub returned no content for ${sourcePath}`);
    }
    return Buffer.from(result.content.replace(/\s/g, ""), "base64").toString(
      "utf8",
    );
  }

  async #createWorkstream(source, signal) {
    const output = await this.gh.run(
      [
        "issue",
        "create",
        "--repo",
        this.repository,
        "--title",
        source.title,
        "--body",
        source.content,
        "--label",
        WORKSTREAM_LABEL,
      ],
      { signal },
    );
    const url = output
      .split(/\r?\n/)
      .find((line) => line.startsWith("https://github.com/"));
    parseWorkstreamIssueUrl(url, this.repository);
    return url;
  }

  async #applyHierarchy(
    sources,
    mapping,
    report,
    { dryRun, checkpoint, signal },
  ) {
    for (const source of sources.filter((candidate) => candidate.parentPath)) {
      const parentUrl = mapping.get(source.parentPath);
      const childUrl = mapping.get(source.path);
      const relationship = {
        parentSource: source.parentPath,
        childSource: source.path,
        parentUrl,
        childUrl,
      };
      if (dryRun) {
        report.planned.push({
          action: "add-sub-issue",
          ...relationship,
        });
        continue;
      }
      if (!parentUrl || !childUrl) {
        report.skipped.push({
          kind: "parent-relationship",
          ...relationship,
          reason: "one or both Workstream Issues are not mapped",
        });
        continue;
      }
      if (
        report.parentRelationships.some(
          (entry) =>
            entry.parentUrl === parentUrl && entry.childUrl === childUrl,
        )
      ) {
        continue;
      }
      const parent = parseWorkstreamIssueUrl(parentUrl, this.repository);
      const child = parseWorkstreamIssueUrl(childUrl, this.repository);
      const childIssue = await this.gh.runJson(
        [
          "api",
          "--method",
          "GET",
          `repos/${this.repository}/issues/${child.number}`,
        ],
        { signal },
      );
      if (!Number.isInteger(childIssue?.id)) {
        throw new Error(`GitHub returned no database ID for ${childUrl}`);
      }
      try {
        await this.gh.runJson(
          [
            "api",
            "--method",
            "POST",
            `repos/${this.repository}/issues/${parent.number}/sub_issues`,
            "-F",
            `sub_issue_id=${childIssue.id}`,
          ],
          { signal },
        );
      } catch (error) {
        if (!/already.*sub-issue|already exists/i.test(error.message)) {
          throw error;
        }
      }
      report.parentRelationships.push(relationship);
      await checkpoint?.(report);
    }
  }

  async #migrateTasks(mapping, report, { dryRun, checkpoint, signal }) {
    const [issues, items] = await Promise.all([
      this.store.listRepositoryIssues({ signal }),
      this.store.listItems(),
    ]);
    const mappedUrls = new Set(mapping.values());
    const itemByUrl = new Map(items.map((item) => [item.url, item]));

    for (const item of items) {
      if (mappedUrls.has(item.url)) {
        const removal = {
          issueUrl: item.url,
          itemId: item.id,
        };
        if (dryRun) {
          report.planned.push({
            action: "remove-workstream-from-project",
            ...removal,
          });
        } else {
          await this.store.removeItem(item.id, { signal });
          report.removedWorkstreamItems.push(removal);
          itemByUrl.delete(item.url);
          await checkpoint?.(report);
        }
        continue;
      }
      const current = item.fields.workstream?.trim();
      if (!current || current.startsWith("https://github.com/")) {
        continue;
      }
      const replacement = mapping.get(current);
      if (!replacement) {
        report.skipped.push({
          kind: "task-workstream",
          issueUrl: item.url,
          previous: current,
          reason: "no reliable Workstream Issue mapping",
        });
        if (!dryRun) {
          await this.store.setFields(item.id, { workstream: "" }, { signal });
        }
        continue;
      }
      const change = {
        issueUrl: item.url,
        itemId: item.id,
        previous: current,
        next: replacement,
      };
      if (dryRun) {
        report.planned.push({
          action: "update-task-workstream",
          ...change,
        });
      } else {
        await this.store.setFields(
          item.id,
          { workstream: replacement },
          { signal },
        );
        report.taskFieldChanges.push(change);
        await checkpoint?.(report);
      }
    }

    for (const issue of issues) {
      if (mappedUrls.has(issue.url)) {
        continue;
      }
      const labels = (issue.labels ?? []).map((label) =>
        typeof label === "string" ? label : label.name,
      );
      if (labels.includes(WORKSTREAM_LABEL)) {
        if (dryRun) {
          report.planned.push({
            action: "remove-workstream-label-from-legacy-task",
            issueUrl: issue.url,
          });
        } else {
          await this.gh.run(
            [
              "issue",
              "edit",
              String(issue.number),
              "--repo",
              this.repository,
              "--remove-label",
              WORKSTREAM_LABEL,
            ],
            { signal },
          );
          await checkpoint?.(report);
        }
      }
      const existingItem = itemByUrl.get(issue.url);
      if (existingItem) {
        if (
          issue.state?.toLowerCase() === "closed" &&
          existingItem.fields.status !== "done"
        ) {
          const change = {
            issueUrl: issue.url,
            itemId: existingItem.id,
            previous: existingItem.fields.status,
            next: "done",
          };
          if (dryRun) {
            report.planned.push({
              action: "complete-legacy-task",
              ...change,
            });
          } else {
            await this.store.setFields(
              existingItem.id,
              { status: "done" },
              { signal },
            );
            report.taskFieldChanges.push(change);
            await checkpoint?.(report);
          }
        }
        continue;
      }
      const registration = {
        issueUrl: issue.url,
        state: issue.state?.toLowerCase(),
      };
      if (dryRun) {
        report.planned.push({
          action: "register-legacy-task",
          ...registration,
        });
      } else {
        const registered = await this.store.addIssueToProject(
          {
            ...issue,
            repository: this.repository,
            labels: labels.filter((label) => label !== WORKSTREAM_LABEL),
          },
          { allowClosed: true, signal },
        );
        report.registeredTasks.push({
          ...registration,
          itemId: registered.id,
          status: registered.fields.status,
        });
        await checkpoint?.(report);
      }
    }
  }

  async #verify(sources, mapping, report, signal) {
    const errors = [];
    for (const source of sources) {
      const url = mapping.get(source.path);
      if (!url) {
        errors.push(`No Issue mapping for ${source.path}`);
        continue;
      }
      try {
        const issue = await this.workstreams.read(url, { signal });
        if (issue.body !== source.content) {
          errors.push(`Issue body does not match ${source.sourcePath}`);
        }
      } catch (error) {
        errors.push(`${source.path}: ${error.message}`);
      }
    }
    for (const source of sources.filter((candidate) => candidate.parentPath)) {
      const parent = parseWorkstreamIssueUrl(
        mapping.get(source.parentPath),
        this.repository,
      );
      const childUrl = mapping.get(source.path);
      const subIssues = await this.gh.runJson(
        [
          "api",
          "--method",
          "GET",
          `repos/${this.repository}/issues/${parent.number}/sub_issues?per_page=100`,
        ],
        { signal },
      );
      if (
        !Array.isArray(subIssues) ||
        !subIssues.some((issue) => issue.html_url === childUrl)
      ) {
        errors.push(
          `Parent relationship is not confirmed for ${source.parentPath} -> ${source.path}`,
        );
      }
    }
    const [items, issues] = await Promise.all([
      this.store.listItems(),
      this.store.listRepositoryIssues({ signal }),
    ]);
    const mappedUrls = new Set(mapping.values());
    const itemByUrl = new Map(items.map((item) => [item.url, item]));
    for (const item of items) {
      if (mappedUrls.has(item.url)) {
        errors.push(`Workstream ${item.url} is still in the backlog Project`);
      }
      const workstream = item.fields.workstream?.trim();
      if (!workstream) {
        continue;
      }
      try {
        await this.workstreams.validate(workstream, { signal });
      } catch (error) {
        errors.push(`Task ${item.url} has invalid workstream: ${error.message}`);
      }
    }
    for (const issue of issues) {
      if (mappedUrls.has(issue.url)) {
        continue;
      }
      const item = itemByUrl.get(issue.url);
      if (!item) {
        errors.push(`Legacy task ${issue.url} is not in the backlog Project`);
      } else if (
        issue.state?.toLowerCase() === "closed" &&
        item.fields.status !== "done"
      ) {
        errors.push(
          `Closed legacy task ${issue.url} does not have Status done`,
        );
      }
    }
    report.verification = {
      complete: errors.length === 0,
      errors,
      verifiedAt: this.now().toISOString(),
    };
    report.errors.push(
      ...errors.map((message) => ({ phase: "verification", message })),
    );
  }

  async #createRemovalPullRequest(inventory, signal) {
    const branch = "pan/migrate-workstreams-to-issues";
    const baseReference = await this.gh.runJson(
      [
        "api",
        "--method",
        "GET",
        `repos/${this.repository}/git/ref/heads/${encodeURIComponent(inventory.defaultBranch)}`,
      ],
      { signal },
    );
    const baseCommitSha = baseReference?.object?.sha;
    if (!baseCommitSha) {
      throw new Error("GitHub returned no default-branch commit SHA");
    }
    let branchHead = baseCommitSha;
    try {
      await this.gh.runJson(
        [
          "api",
          "--method",
          "POST",
          `repos/${this.repository}/git/refs`,
          "-f",
          `ref=refs/heads/${branch}`,
          "-f",
          `sha=${baseCommitSha}`,
        ],
        { signal },
      );
    } catch (error) {
      if (!/Reference already exists|already exists/i.test(error.message)) {
        throw error;
      }
      const existing = await this.gh.runJson(
        [
          "api",
          "--method",
          "GET",
          `repos/${this.repository}/git/ref/heads/${branch}`,
        ],
        { signal },
      );
      branchHead = existing?.object?.sha;
      if (branchHead !== baseCommitSha) {
        const pulls = await this.gh.runJson(
          [
            "api",
            "--method",
            "GET",
            `repos/${this.repository}/pulls?state=open&head=${encodeURIComponent(`${this.repository.split("/")[0]}:${branch}`)}`,
          ],
          { signal },
        );
        const existingPullRequest = pulls?.find(
          (pullRequest) => pullRequest.head?.ref === branch,
        );
        if (existingPullRequest?.html_url) {
          return {
            url: existingPullRequest.html_url,
            branch,
            commit: branchHead,
          };
        }
        throw new Error(
          `Migration branch ${branch} already contains unreviewed changes; inspect or remove it before retrying file removal`,
        );
      }
    }
    const query = `
      mutation($repository: String!, $branch: String!, $head: GitObjectID!, $deletions: [FileDeletion!]!) {
        createCommitOnBranch(input: {
          branch: { repositoryNameWithOwner: $repository, branchName: $branch }
          expectedHeadOid: $head
          message: { headline: "Remove migrated Markdown workstreams" }
          fileChanges: { deletions: $deletions }
        }) {
          commit { oid url }
        }
      }
    `;
    const removal = await this.gh.runJson(
      [
        "api",
        "graphql",
        "-f",
        `query=${query}`,
        "-f",
        `repository=${this.repository}`,
        "-f",
        `branch=${branch}`,
        "-f",
        `head=${branchHead}`,
        ...inventory.sources.flatMap((source) => [
          "-f",
          `deletions[][path]=${source.sourcePath}`,
        ]),
      ],
      { signal },
    );
    const removalCommit = removal?.data?.createCommitOnBranch?.commit;
    if (!removalCommit?.oid) {
      throw new Error("GitHub did not confirm the workstream removal commit");
    }
    const pullRequest = await this.gh.runJson(
      [
        "api",
        "--method",
        "POST",
        `repos/${this.repository}/pulls`,
        "-f",
        "title=Remove migrated Markdown workstreams",
        "-f",
        `head=${branch}`,
        "-f",
        `base=${inventory.defaultBranch}`,
        "-f",
        "body=Workstream content has been verified in Workstream Issues. This pull request removes the migrated Markdown sources.",
      ],
      { signal },
    );
    return {
      url: pullRequest.html_url,
      branch,
      commit: removalCommit.oid,
    };
  }
}

export async function writeMigrationReport(reportPath, report) {
  const temporary = `${reportPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(
      temporary,
      `${JSON.stringify(report, null, 2)}\n`,
      "utf8",
    );
    await rename(temporary, reportPath);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function readMigrationReport(reportPath) {
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  if (report.version !== WORKSTREAM_MIGRATION_REPORT_VERSION) {
    throw new Error("Unsupported Workstream migration report version");
  }
  return report;
}

function initializeReport({
  repository,
  projectOwner,
  projectNumber,
  dryRun,
  resume,
  now,
}) {
  if (
    resume &&
    (resume.repository?.toLowerCase() !== repository.toLowerCase() ||
      resume.projectOwner?.toLowerCase() !== projectOwner.toLowerCase() ||
      resume.projectNumber !== projectNumber)
  ) {
    throw new Error("Resume report targets a different Pan domain");
  }
  return {
    version: WORKSTREAM_MIGRATION_REPORT_VERSION,
    repository,
    projectOwner,
    projectNumber,
    dryRun,
    startedAt: now().toISOString(),
    mapping: { ...(resume?.mapping ?? {}) },
    sources: [],
    createdIssues: [...(resume?.createdIssues ?? [])],
    parentRelationships: [...(resume?.parentRelationships ?? [])],
    taskFieldChanges: [...(resume?.taskFieldChanges ?? [])],
    registeredTasks: [...(resume?.registeredTasks ?? [])],
    removedWorkstreamItems: [...(resume?.removedWorkstreamItems ?? [])],
    skipped: [],
    planned: [],
    errors: [],
    verification: { complete: false, errors: [] },
  };
}

function workstreamTitle(content, workstreamPath) {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content)?.[1];
  const title = frontmatter
    ?.split(/\r?\n/)
    .map((line) => /^title:\s*(.+)$/.exec(line)?.[1]?.trim())
    .find(Boolean);
  const heading = content
    .split(/\r?\n/)
    .map((line) => /^#\s+(.+)$/.exec(line)?.[1]?.trim())
    .find(Boolean);
  return title ?? heading ?? path.posix.basename(workstreamPath);
}

async function hashContent(content) {
  const { createHash } = await import("node:crypto");
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}
