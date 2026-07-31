import { GhClient } from "./gh-client.js";

export const WORKSTREAM_LABEL = "Workstream";

export class WorkstreamIssueStore {
  constructor({ repository, gh = new GhClient() } = {}) {
    validateRepository(repository);
    if (!gh?.runJson) {
      throw new TypeError("gh must provide runJson()");
    }
    this.repository = repository;
    this.gh = gh;
  }

  async list({ state = "all", signal } = {}) {
    const issues = await this.gh.runJson(
      [
        "issue",
        "list",
        "--repo",
        this.repository,
        "--state",
        state,
        "--label",
        WORKSTREAM_LABEL,
        "--limit",
        "1000",
        "--json",
        "number,title,body,url,state,labels,createdAt,updatedAt,closedAt",
      ],
      { signal },
    );
    if (!Array.isArray(issues)) {
      throw new Error("GitHub returned an invalid Workstream Issue list");
    }
    return issues.map((issue) => normalizeWorkstream(issue, this.repository));
  }

  async read(reference, { signal } = {}) {
    const parsed = parseWorkstreamIssueUrl(reference, this.repository);
    const issue = await this.gh.runJson(
      [
        "issue",
        "view",
        String(parsed.number),
        "--repo",
        this.repository,
        "--json",
        "number,title,body,url,state,labels,comments,createdAt,updatedAt,closedAt",
      ],
      { signal },
    );
    return normalizeWorkstream(issue, this.repository);
  }

  async validate(reference, options) {
    return this.read(reference, options);
  }

  async activity(reference, { signal } = {}) {
    const issue = await this.read(reference, { signal });
    const structured = issue.comments.filter((comment) =>
      /<!--\s*pan:workstream-update\b/i.test(comment.body),
    );
    return {
      workstream: issue,
      currentState: issue.body,
      updatedAt: issue.updatedAt,
      structuredUpdates: structured,
      historyComplete: false,
      diagnostics: [
        "GitHub's documented Issue APIs do not expose historical body diffs; the report includes current edit metadata and structured comments only.",
      ],
    };
  }

  async hierarchy(reference, { signal } = {}) {
    const parsed = parseWorkstreamIssueUrl(reference, this.repository);
    const children = await this.gh.runJson(
      [
        "api",
        "--method",
        "GET",
        `repos/${this.repository}/issues/${parsed.number}/sub_issues?per_page=100`,
      ],
      { signal },
    );
    if (!Array.isArray(children)) {
      throw new Error("GitHub returned an invalid sub-issue list");
    }
    let parent;
    try {
      parent = await this.gh.runJson(
        [
          "api",
          "--method",
          "GET",
          `repos/${this.repository}/issues/${parsed.number}/parent`,
        ],
        { signal },
      );
    } catch (error) {
      if (!/(?:HTTP )?404|not found/i.test(error.message)) {
        throw error;
      }
    }
    return {
      parent: parent ? normalizeRelationshipIssue(parent) : undefined,
      children: children.map(normalizeRelationshipIssue),
    };
  }
}

export function parseWorkstreamIssueUrl(value, repository) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError("workstream must be an Issue URL or empty");
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError(
      "workstream must be a full GitHub Issue URL in the configured domain",
    );
  }
  const match = /^\/([^/]+)\/([^/]+)\/issues\/([1-9]\d*)\/?$/.exec(
    url.pathname,
  );
  if (
    url.protocol !== "https:" ||
    url.hostname.toLowerCase() !== "github.com" ||
    !match
  ) {
    throw new TypeError(
      "workstream must be a full https://github.com/<owner>/<repo>/issues/<number> URL",
    );
  }
  const actualRepository = `${match[1]}/${match[2]}`;
  if (
    repository &&
    actualRepository.toLowerCase() !== repository.toLowerCase()
  ) {
    throw new TypeError(
      `workstream must reference an Issue in ${repository}`,
    );
  }
  return {
    repository: actualRepository,
    number: Number(match[3]),
    url: `https://github.com/${actualRepository}/issues/${Number(match[3])}`,
  };
}

export function classifyDomainIssue(issue, projectIssueUrls) {
  const labels = new Set(
    (issue.labels ?? []).map((label) =>
      typeof label === "string" ? label : label.name,
    ),
  );
  const isWorkstream = labels.has(WORKSTREAM_LABEL);
  const inProject = projectIssueUrls.has(issue.url);
  if (isWorkstream && !inProject) {
    return { type: "workstream", valid: true };
  }
  if (!isWorkstream && inProject) {
    return { type: "task", valid: true };
  }
  return {
    type: isWorkstream ? "workstream" : "unclassified",
    valid: false,
    code: isWorkstream
      ? "workstream-in-backlog"
      : "issue-outside-backlog",
    proposal: isWorkstream
      ? "remove-from-project"
      : issue.state?.toLowerCase() === "open"
        ? "add-as-task"
        : undefined,
  };
}

export function classifyDomainIssues(issues, projectItems) {
  const projectIssueUrls = new Set(
    projectItems
      .filter((item) => item.contentClassification === "domain-issue")
      .map((item) => item.url),
  );
  const byUrl = new Map(issues.map((issue) => [issue.url, issue]));
  const results = issues.map((issue) => ({
    issue,
    ...classifyDomainIssue(issue, projectIssueUrls),
  }));
  for (const item of projectItems) {
    if (
      item.contentClassification === "domain-issue" &&
      !byUrl.has(item.url)
    ) {
      results.push({
        issue: item,
        type: "task",
        valid: false,
        code: "project-issue-missing-from-repository-read",
      });
    }
  }
  return results;
}

export async function resolveTaskWorkstreams(
  items,
  workstreamStore,
  { signal } = {},
) {
  const cache = new Map();
  const results = [];
  for (const item of items) {
    const reference = item.fields?.workstream?.trim();
    if (!reference) {
      results.push({ ...item, workstream: undefined });
      continue;
    }
    let workstream = cache.get(reference);
    if (!workstream) {
      workstream = await workstreamStore.read(reference, { signal });
      cache.set(reference, workstream);
    }
    results.push({
      ...item,
      workstream: {
        url: workstream.url,
        title: workstream.title,
        state: workstream.state,
      },
    });
  }
  return results;
}

function normalizeWorkstream(issue, repository) {
  if (
    !Number.isInteger(issue?.number) ||
    typeof issue.title !== "string" ||
    typeof issue.body !== "string" ||
    typeof issue.url !== "string"
  ) {
    throw new Error("GitHub returned incomplete Workstream Issue data");
  }
  parseWorkstreamIssueUrl(issue.url, repository);
  const labels = (issue.labels ?? []).map((label) =>
    typeof label === "string" ? label : label.name,
  );
  if (!labels.includes(WORKSTREAM_LABEL)) {
    throw new Error(
      `Issue ${issue.url} is not a Workstream Issue because it lacks the exact ${WORKSTREAM_LABEL} label`,
    );
  }
  return {
    number: issue.number,
    title: issue.title,
    body: issue.body,
    url: issue.url,
    state: issue.state?.toLowerCase(),
    labels,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    closedAt: issue.closedAt,
    comments: (issue.comments ?? []).map((comment) => ({
      id: comment.id,
      body: comment.body ?? "",
      url: comment.url,
      createdAt: comment.createdAt,
      updatedAt: comment.updatedAt,
      author: comment.author?.login ?? comment.author,
    })),
  };
}

function validateRepository(repository) {
  if (
    typeof repository !== "string" ||
    !/^[^/]+\/[^/]+$/.test(repository)
  ) {
    throw new TypeError("repository must use owner/name format");
  }
}

function normalizeRelationshipIssue(issue) {
  if (
    !Number.isInteger(issue?.number) ||
    typeof issue.title !== "string" ||
    typeof issue.html_url !== "string"
  ) {
    throw new Error("GitHub returned incomplete sub-issue data");
  }
  return {
    number: issue.number,
    title: issue.title,
    url: issue.html_url,
    state: issue.state?.toLowerCase(),
  };
}
