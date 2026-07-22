import { createHash } from "node:crypto";
import {
  lstat,
  readFile,
  readdir,
  realpath,
  stat,
} from "node:fs/promises";
import path from "node:path";

import { ProcessClient } from "./process-client.js";

const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;
const DEFAULT_SEARCH_LIMIT = 100;
const DEFAULT_HISTORY_LIMIT = 50;

export class WorkstreamStore {
  constructor({
    repositoryPath,
    commands = new ProcessClient(),
    commandTimeout = 10_000,
    maxFileBytes = DEFAULT_MAX_FILE_BYTES,
    searchLimit = DEFAULT_SEARCH_LIMIT,
    historyLimit = DEFAULT_HISTORY_LIMIT,
  }) {
    if (!path.isAbsolute(repositoryPath ?? "")) {
      throw new TypeError("repositoryPath must be an absolute path");
    }
    for (const [name, value] of Object.entries({
      commandTimeout,
      maxFileBytes,
      searchLimit,
      historyLimit,
    })) {
      if (!Number.isInteger(value) || value < 1) {
        throw new TypeError(`${name} must be a positive integer`);
      }
    }
    this.repositoryPath = path.resolve(repositoryPath);
    this.commands = commands;
    this.commandTimeout = commandTimeout;
    this.maxFileBytes = maxFileBytes;
    this.searchLimit = searchLimit;
    this.historyLimit = historyLimit;
  }

  async list() {
    const [repositoryRoot, root] = await Promise.all([
      realpath(this.repositoryPath),
      realpath(path.join(this.repositoryPath, "workstreams")),
    ]);
    assertWithinRoot(repositoryRoot, root);
    const workstreams = [];
    const errors = [];
    await enumerateDirectories(root, [], workstreams, errors);
    workstreams.sort((left, right) => left.path.localeCompare(right.path));

    const known = new Set(workstreams.map((entry) => entry.path));
    for (const entry of workstreams) {
      entry.children = workstreams
        .filter((candidate) => candidate.parent === entry.path)
        .map((candidate) => candidate.path);
      if (entry.parent && !known.has(entry.parent)) {
        errors.push({
          path: entry.parent,
          reason: `Parent workstream ${entry.parent} has no readable README.md`,
        });
      }
    }

    return {
      revision: await this.#revision(),
      complete: errors.length === 0,
      workstreams,
      errors: deduplicateErrors(errors),
    };
  }

  async read(workstream) {
    const sourcePath = await resolveConfinedWorkstreamReadme(
      this.repositoryPath,
      workstream,
    );
    const metadata = await stat(sourcePath);
    if (!metadata.isFile()) {
      throw new Error(`Workstream ${workstream} README.md is not a file`);
    }
    if (metadata.size > this.maxFileBytes) {
      throw new Error(
        `Workstream ${workstream} README.md exceeds the ${this.maxFileBytes}-byte read limit`,
      );
    }
    const content = await readFile(sourcePath, "utf8");
    return {
      path: workstream,
      sourcePath: `workstreams/${workstream}/README.md`,
      content,
      contentHash: `sha256:${createHash("sha256").update(content).digest("hex")}`,
      modifiedAt: metadata.mtime.toISOString(),
      revision: await this.#revision(),
    };
  }

  async search(pattern, options = {}) {
    const matcher = createMatcher(pattern, options);
    const limit = boundedLimit(
      options.limit ?? this.searchLimit,
      this.searchLimit,
      "search limit",
    );
    const listed = await this.list();
    const errors = [...listed.errors];
    const matches = [];

    for (const entry of listed.workstreams) {
      if (matches.length >= limit) {
        break;
      }
      let workstream;
      try {
        workstream = await this.read(entry.path);
      } catch (error) {
        errors.push({ path: entry.path, reason: error.message });
        continue;
      }
      for (const [index, line] of workstream.content.split(/\r?\n/).entries()) {
        if (line.length > this.maxFileBytes) {
          errors.push({
            path: entry.path,
            reason: `Line ${index + 1} exceeds the bounded search length`,
          });
          break;
        }
        if (matcher(line)) {
          matches.push({
            path: entry.path,
            sourcePath: workstream.sourcePath,
            startLine: index + 1,
            endLine: index + 1,
            text: line,
          });
          if (matches.length >= limit) {
            break;
          }
        }
      }
    }

    return {
      revision: listed.revision,
      complete: errors.length === 0 && matches.length < limit,
      matches,
      errors: deduplicateErrors(errors),
      limited: matches.length >= limit,
    };
  }

  async history(workstream, options = {}) {
    await resolveConfinedWorkstreamReadme(this.repositoryPath, workstream);
    const limit = boundedLimit(
      options.limit ?? this.historyLimit,
      this.historyLimit,
      "history limit",
    );
    const sourcePath = `workstreams/${workstream}/README.md`;
    const output = await this.commands.run(
      "git",
      [
        "-C",
        this.repositoryPath,
        "log",
        "-n",
        String(limit),
        "--date=iso-strict",
        "--format=%H%x1f%cI%x1f%s%x1f",
        "--name-only",
        "--",
        sourcePath,
      ],
      {
        timeout: this.commandTimeout,
        maxBuffer: this.maxFileBytes,
      },
    );
    return parseHistory(output, sourcePath);
  }

  async #revision() {
    return this.commands.run(
      "git",
      ["-C", this.repositoryPath, "rev-parse", "HEAD"],
      {
        timeout: this.commandTimeout,
        maxBuffer: 1024,
      },
    );
  }
}

export function resolveWorkstreamReadme(repositoryPath, workstream) {
  validateWorkstreamPath(workstream);
  const root = path.resolve(repositoryPath, "workstreams");
  const candidate = path.resolve(
    root,
    ...workstream.split("/"),
    "README.md",
  );
  assertWithinRoot(root, candidate);
  return candidate;
}

export async function resolveNewConfinedWorkstreamReadme(
  repositoryPath,
  workstream,
) {
  const candidate = resolveWorkstreamReadme(repositoryPath, workstream);
  const repository = path.resolve(repositoryPath);
  const root = path.join(repository, "workstreams");
  const [repositoryRealPath, nearestExistingAncestor] = await Promise.all([
    realpath(repository),
    nearestExistingPath(path.dirname(candidate)),
  ]);
  assertContainedBy(repositoryRealPath, nearestExistingAncestor);

  try {
    const rootRealPath = await realpath(root);
    assertContainedBy(repositoryRealPath, rootRealPath);
    assertContainedBy(rootRealPath, nearestExistingAncestor);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
  return candidate;
}

export async function resolveConfinedWorkstreamReadme(
  repositoryPath,
  workstream,
) {
  const candidate = resolveWorkstreamReadme(repositoryPath, workstream);
  let repositoryRealPath;
  let rootRealPath;
  let candidateRealPath;
  try {
    [repositoryRealPath, rootRealPath, candidateRealPath] = await Promise.all([
      realpath(path.resolve(repositoryPath)),
      realpath(path.resolve(repositoryPath, "workstreams")),
      realpath(candidate),
    ]);
  } catch (error) {
    throw new Error(
      `Unable to read workstream ${workstream}: ${error.message}`,
      { cause: error },
    );
  }
  assertWithinRoot(repositoryRealPath, rootRealPath);
  assertWithinRoot(rootRealPath, candidateRealPath);
  return candidateRealPath;
}

async function enumerateDirectories(root, segments, workstreams, errors) {
  const directory = path.join(root, ...segments);
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    errors.push({
      path: segments.join("/"),
      reason: `Unable to enumerate workstream directory: ${error.message}`,
    });
    return;
  }

  if (segments.length > 0) {
    const workstream = segments.join("/");
    const readme = entries.find((entry) => entry.name === "README.md");
    if (!readme) {
      errors.push({
        path: workstream,
        reason: `Workstream ${workstream} has no README.md`,
      });
    } else {
      try {
        const metadata = await lstat(path.join(directory, readme.name));
        if (!metadata.isFile() && !metadata.isSymbolicLink()) {
          throw new Error("README.md is not a file");
        }
        await resolveConfinedWorkstreamReadme(
          path.dirname(root),
          workstream,
        );
        workstreams.push({
          path: workstream,
          parent:
            segments.length > 1 ? segments.slice(0, -1).join("/") : undefined,
          children: [],
          sourcePath: `workstreams/${workstream}/README.md`,
        });
      } catch (error) {
        errors.push({ path: workstream, reason: error.message });
      }
    }
  }

  for (const entry of entries) {
    if (entry.isDirectory()) {
      await enumerateDirectories(
        root,
        [...segments, entry.name],
        workstreams,
        errors,
      );
    } else if (entry.isSymbolicLink() && entry.name !== "README.md") {
      errors.push({
        path: [...segments, entry.name].join("/"),
        reason: "Symbolic-link workstream directories are not enumerated",
      });
    }
  }
}

export function validateWorkstreamPath(workstream) {
  if (
    typeof workstream !== "string" ||
    !workstream ||
    path.posix.isAbsolute(workstream) ||
    path.isAbsolute(workstream) ||
    workstream.includes("\\") ||
    path.posix.normalize(workstream) !== workstream
  ) {
    throw new Error(
      "Workstream must be a canonical relative path using / separators",
    );
  }
  const segments = workstream.split("/");
  if (
    segments.some(
      (segment) => !segment || segment === "." || segment === "..",
    )
  ) {
    throw new Error("Workstream path contains an invalid segment");
  }
}

async function nearestExistingPath(candidate) {
  let current = candidate;
  for (;;) {
    try {
      return await realpath(current);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
      const parent = path.dirname(current);
      if (parent === current) {
        throw error;
      }
      current = parent;
    }
  }
}

function assertWithinRoot(root, candidate) {
  const relative = path.relative(root, candidate);
  if (
    !relative ||
    relative.startsWith(`..${path.sep}`) ||
    relative === ".." ||
    path.isAbsolute(relative)
  ) {
    throw new Error("Workstream path escapes the configured repository root");
  }
}

function assertContainedBy(root, candidate) {
  const relative = path.relative(root, candidate);
  if (
    relative.startsWith(`..${path.sep}`) ||
    relative === ".." ||
    path.isAbsolute(relative)
  ) {
    throw new Error("Workstream path escapes the configured repository root");
  }
}

function createMatcher(pattern, { regex = false, caseSensitive = false } = {}) {
  if (typeof pattern !== "string" || !pattern || pattern.length > 1_000) {
    throw new TypeError("search pattern must be 1 through 1000 characters");
  }
  if (regex) {
    const expression = new RegExp(pattern, caseSensitive ? "" : "i");
    return (line) => {
      expression.lastIndex = 0;
      return expression.test(line);
    };
  }
  const expected = caseSensitive ? pattern : pattern.toLowerCase();
  return (line) =>
    (caseSensitive ? line : line.toLowerCase()).includes(expected);
}

function boundedLimit(value, maximum, name) {
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`${name} must be an integer from 1 through ${maximum}`);
  }
  return value;
}

function parseHistory(output, sourcePath) {
  if (!output) {
    return [];
  }
  const commits = [];
  let current;
  for (const line of output.split(/\r?\n/)) {
    if (line.includes("\x1f")) {
      const [sha, committedAt, subject] = line.split("\x1f");
      current = { sha, committedAt, subject, changedPath: sourcePath };
      commits.push(current);
    } else if (line.trim() && current) {
      current.changedPath = line.trim().split(path.sep).join("/");
    }
  }
  return commits;
}

function deduplicateErrors(errors) {
  const seen = new Set();
  return errors.filter((error) => {
    const key = `${error.path}\0${error.reason}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}
