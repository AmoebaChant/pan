import { createHash } from "node:crypto";

const DEFAULT_SAFETY_LIMIT = 1_000;

/**
 * Reads repository Issues as a complete, immutable evidence source.
 */
export class IssueCatalog {
  constructor({
    repository,
    gh,
    now = () => new Date(),
    safetyLimit = DEFAULT_SAFETY_LIMIT,
  } = {}) {
    if (!/^[^/\s]+\/[^/\s]+$/.test(repository ?? "")) {
      throw new TypeError("repository must be an owner/name pair");
    }
    if (!gh?.paginateRestJson) {
      throw new TypeError("gh must provide paginateRestJson()");
    }
    if (!Number.isInteger(safetyLimit) || safetyLimit < 1) {
      throw new TypeError("safetyLimit must be a positive integer");
    }
    this.repository = repository;
    this.gh = gh;
    this.now = now;
    this.safetyLimit = safetyLimit;
  }

  async read({ includeComments = true, includeRelationships = false, signal } = {}) {
    if (typeof includeComments !== "boolean") {
      throw new TypeError("includeComments must be a boolean");
    }
    if (typeof includeRelationships !== "boolean") {
      throw new TypeError("includeRelationships must be a boolean");
    }

    const diagnostics = [];
    const states = await Promise.all(
      ["open", "closed"].map((state) => this.#readState(state, signal)),
    );
    await Promise.all(
      states.map((result) => this.#verifyState(result, signal)),
    );
    const rawIssues = [];
    for (const result of states) {
      rawIssues.push(...result.records);
      if (result.error) {
        diagnostics.push(result.error);
      }
    }

    const seenNumbers = new Set();
    let excludedPullRequests = 0;
    const issues = [];
    for (const raw of rawIssues) {
      if (raw?.pull_request) {
        excludedPullRequests += 1;
        continue;
      }
      try {
        const issue = normalizeIssue(raw, this.repository);
        if (seenNumbers.has(issue.number)) {
          throw new Error(`Issue #${issue.number} appeared more than once`);
        }
        seenNumbers.add(issue.number);
        issues.push(issue);
      } catch (error) {
        diagnostics.push(diagnostic("issues", "malformed-issue", error));
      }
    }

    if (includeComments) {
      await Promise.all(
        issues.map(async (issue) => {
          try {
            issue.comments = await this.#readComments(issue.number, signal);
          } catch (error) {
            diagnostics.push(
              diagnostic(`issue:${issue.number}:comments`, "comments-incomplete", error),
            );
          }
        }),
      );
    }

    issues.sort((left, right) => left.number - right.number);
    const complete =
      diagnostics.length === 0 &&
      (includeComments || issues.every((issue) => issue.comments === undefined));
    const source = {
      issues: {
        complete: diagnostics.every(
          (entry) => !entry.source.startsWith("issues"),
        ),
        states: Object.fromEntries(
          states.map((result) => [
            result.state,
            { complete: !result.error, count: result.records.length },
          ]),
        ),
      },
      comments: {
        complete:
          includeComments &&
          diagnostics.every((entry) => entry.code !== "comments-incomplete"),
        excluded: !includeComments,
      },
      relationships: {
        complete: false,
        excluded: !includeRelationships,
        diagnostics: includeRelationships
          ? ["Relationship evidence is not supported by the GitHub Issue REST source."]
          : ["Relationship evidence was intentionally excluded from this catalog."],
      },
    };
    if (includeRelationships) {
      diagnostics.push({
        source: "relationships",
        code: "relationships-unsupported",
        message:
          "Relationship evidence is not supported by the GitHub Issue REST source.",
      });
    }

    const durable = {
      version: 1,
      repository: this.repository,
      complete: complete && !includeRelationships,
      source,
      excludedPullRequests,
      diagnostics,
      issues,
    };
    return deepFreeze({
      id: stableIdentity(durable),
      capturedAt: this.now().toISOString(),
      ...durable,
    });
  }

  async #readState(state, signal) {
    try {
      const records = await this.gh.paginateRestJson(
        `repos/${this.repository}/issues?state=${state}`,
        { safetyLimit: this.safetyLimit, signal },
      );
      return { state, records };
    } catch (error) {
      return {
        state,
        records: [],
        error: diagnostic(`issues:${state}`, "issues-incomplete", error),
      };
    }
  }

  async #verifyState(result, signal) {
    if (result.error) {
      return;
    }
    try {
      const verified = await this.gh.paginateRestJson(
        `repos/${this.repository}/issues?state=${result.state}`,
        { safetyLimit: this.safetyLimit, signal },
      );
      if (stableStringify(result.records) !== stableStringify(verified)) {
        result.error = {
          source: `issues:${result.state}`,
          code: "issues-changed",
          message: `The ${result.state} Issue catalog changed while it was being read.`,
        };
      }
    } catch (error) {
      result.error = diagnostic(
        `issues:${result.state}`,
        "issues-verification-failed",
        error,
      );
    }
  }

  async #readComments(number, signal) {
    const comments = await this.gh.paginateRestJson(
      `repos/${this.repository}/issues/${number}/comments`,
      { safetyLimit: this.safetyLimit, signal },
    );
    return comments.map((comment) => normalizeComment(number, comment));
  }
}

function normalizeIssue(value, repository) {
  if (!value || !Number.isInteger(value.number) || value.number < 1) {
    throw new Error("Issue number is missing");
  }
  for (const field of [
    "html_url",
    "title",
    "body",
    "state",
    "created_at",
    "updated_at",
  ]) {
    if (typeof value[field] !== "string") {
      throw new Error(`Issue #${value.number} has no valid ${field} evidence`);
    }
  }
  if (
    !Number.isFinite(Date.parse(value.created_at)) ||
    !Number.isFinite(Date.parse(value.updated_at)) ||
    (value.closed_at !== null &&
      value.closed_at !== undefined &&
      !Number.isFinite(Date.parse(value.closed_at)))
  ) {
    throw new Error(`Issue #${value.number} has invalid timestamp evidence`);
  }
  if (!Array.isArray(value.labels) || !Array.isArray(value.assignees)) {
    throw new Error(`Issue #${value.number} has incomplete label or assignee evidence`);
  }
  return {
    id: value.node_id ?? String(value.id ?? value.number),
    databaseId: Number.isInteger(value.id) ? value.id : undefined,
    number: value.number,
    url: value.html_url,
    state: value.state.toLowerCase(),
    title: value.title,
    body: value.body,
    createdAt: value.created_at,
    updatedAt: value.updated_at,
    closedAt: value.closed_at ?? null,
    repository,
    labels: value.labels.map((label) => {
      if (typeof label?.name !== "string" || !label.name) {
        throw new Error(`Issue #${value.number} has a malformed label`);
      }
      return label.name;
    }),
    assignees: value.assignees.map((assignee) => {
      if (typeof assignee?.login !== "string" || !assignee.login) {
        throw new Error(`Issue #${value.number} has a malformed assignee`);
      }
      return assignee.login;
    }),
    author: typeof value.user?.login === "string" ? value.user.login : undefined,
    relationships: [],
  };
}

function normalizeComment(number, value) {
  if (
    !value ||
    (typeof value.id !== "number" && typeof value.node_id !== "string") ||
    typeof value.body !== "string" ||
    typeof value.html_url !== "string" ||
    !Number.isFinite(Date.parse(value.created_at)) ||
    !Number.isFinite(Date.parse(value.updated_at))
  ) {
    throw new Error(`Issue #${number} has malformed comment evidence`);
  }
  return {
    id: value.node_id ?? String(value.id),
    databaseId: Number.isInteger(value.id) ? value.id : undefined,
    body: value.body,
    url: value.html_url,
    createdAt: value.created_at,
    updatedAt: value.updated_at,
    author: typeof value.user?.login === "string" ? value.user.login : undefined,
  };
}

function diagnostic(source, code, error) {
  return {
    source,
    code,
    message: error instanceof Error ? error.message : String(error),
  };
}

function stableIdentity(value) {
  return `sha256:${createHash("sha256")
    .update(stableStringify(value))
    .digest("hex")}`;
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}
