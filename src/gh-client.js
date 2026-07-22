import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export class GhCommandError extends Error {
  constructor(args, cause) {
    const stderr = cause.stderr?.trim();
    super(`gh ${args.join(" ")} failed${stderr ? `: ${stderr}` : ""}`, { cause });
    this.name = "GhCommandError";
    this.args = args;
    this.exitCode = cause.code;
    this.stderr = cause.stderr;
    this.stdout = cause.stdout;
  }
}

export class GhClient {
  constructor({ executable = "gh", env = process.env } = {}) {
    this.executable = executable;
    this.env = env;
  }

  async run(args, { signal } = {}) {
    try {
      const { stdout } = await execFileAsync(this.executable, args, {
        encoding: "utf8",
        env: this.env,
        maxBuffer: 10 * 1024 * 1024,
        signal,
        windowsHide: true,
      });
      return stdout.trim();
    } catch (error) {
      if (signal?.aborted) {
        throw signal.reason ?? error;
      }
      throw new GhCommandError(args, error);
    }
  }

  async runJson(args, options) {
    const output = await this.run(args, options);
    if (!output) {
      throw new Error(`gh ${args.join(" ")} returned no JSON`);
    }
    return JSON.parse(output);
  }

  async paginateRestJson(
    path,
    { pageSize = 100, safetyLimit = 1_000, signal } = {},
  ) {
    if (typeof path !== "string" || !path.trim()) {
      throw new TypeError("path is required");
    }
    validatePaginationOptions(pageSize, safetyLimit);
    const entries = [];
    for (let page = 1; ; page += 1) {
      const separator = path.includes("?") ? "&" : "?";
      const result = await this.runJson(
        [
          "api",
          "--method",
          "GET",
          `${path}${separator}per_page=${pageSize}&page=${page}`,
        ],
        { signal },
      );
      if (!Array.isArray(result)) {
        throw new Error(`GitHub returned an invalid paginated response for ${path}`);
      }
      if (entries.length + result.length > safetyLimit) {
        throw new Error(
          `GitHub pagination for ${path} exceeded the ${safetyLimit}-entry safety limit`,
        );
      }
      entries.push(...result);
      if (result.length < pageSize) {
        return entries;
      }
    }
  }

  async paginateGraphql({
    query,
    variables = {},
    connection,
    safetyLimit = 1_000,
    signal,
  } = {}) {
    if (typeof query !== "string" || !query.trim()) {
      throw new TypeError("query is required");
    }
    if (typeof connection !== "function") {
      throw new TypeError("connection must select a GraphQL connection");
    }
    if (!Number.isInteger(safetyLimit) || safetyLimit < 1) {
      throw new TypeError("safetyLimit must be a positive integer");
    }

    const nodes = [];
    const cursors = new Set();
    let expectedTotal;
    let cursor;
    do {
      const args = ["api", "graphql", "-f", `query=${query}`];
      for (const [name, value] of Object.entries({
        ...variables,
        ...(cursor ? { cursor } : {}),
      })) {
        args.push("-f", `${name}=${value}`);
      }
      const result = await this.runJson(args, { signal });
      const page = connection(result);
      if (!page || !Array.isArray(page.nodes)) {
        throw new Error("GitHub returned an invalid GraphQL connection");
      }
      if (Number.isInteger(page.totalCount)) {
        expectedTotal ??= page.totalCount;
        if (page.totalCount !== expectedTotal) {
          throw new Error("GitHub GraphQL connection changed during pagination");
        }
        if (expectedTotal > safetyLimit) {
          throw new Error(
            `GitHub GraphQL connection exceeds the ${safetyLimit}-entry safety limit`,
          );
        }
      }
      if (nodes.length + page.nodes.length > safetyLimit) {
        throw new Error(
          `GitHub GraphQL connection exceeded the ${safetyLimit}-entry safety limit`,
        );
      }
      nodes.push(...page.nodes);
      if (page.pageInfo?.hasNextPage) {
        cursor = page.pageInfo.endCursor;
        if (!cursor || cursors.has(cursor)) {
          throw new Error("GitHub returned a repeated or missing GraphQL cursor");
        }
        cursors.add(cursor);
      } else {
        cursor = undefined;
      }
    } while (cursor);
    if (expectedTotal !== undefined && nodes.length !== expectedTotal) {
      throw new Error(
        `GitHub returned ${nodes.length} of ${expectedTotal} GraphQL records`,
      );
    }
    return nodes;
  }
}

function validatePaginationOptions(pageSize, safetyLimit) {
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    throw new TypeError("pageSize must be an integer from 1 through 100");
  }
  if (!Number.isInteger(safetyLimit) || safetyLimit < 1) {
    throw new TypeError("safetyLimit must be a positive integer");
  }
}
