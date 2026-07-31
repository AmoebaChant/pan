import { GhClient } from "./gh-client.js";
import { validateWorkstreamPath } from "./workstream-store.js";

const README_PATTERN = /^workstreams\/(.+)\/README\.md$/;

export class GitHubWorkstreamStore {
  constructor({ repository, gh = new GhClient() } = {}) {
    if (
      typeof repository !== "string" ||
      !/^[^/]+\/[^/]+$/.test(repository)
    ) {
      throw new TypeError("repository must use owner/name format");
    }
    if (!gh?.runJson) {
      throw new TypeError("gh must provide runJson()");
    }
    this.repository = repository;
    this.gh = gh;
    this.branchPromise = undefined;
  }

  async list({ signal } = {}) {
    const branch = await this.#branch(signal);
    const tree = await this.gh.runJson(
      [
        "api",
        "--method",
        "GET",
        `repos/${this.repository}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
      ],
      { signal },
    );
    if (!Array.isArray(tree?.tree) || tree.truncated) {
      throw new Error("GitHub returned an incomplete workstream tree");
    }
    const workstreams = tree.tree
      .filter((entry) => entry.type === "blob")
      .flatMap((entry) => {
        const match = README_PATTERN.exec(entry.path);
        return match
          ? [
              {
                path: match[1],
                parent: parentPath(match[1]),
                children: [],
                sourcePath: entry.path,
                sha: entry.sha,
              },
            ]
          : [];
      })
      .sort((left, right) => left.path.localeCompare(right.path));
    const known = new Set(workstreams.map((entry) => entry.path));
    const errors = [];
    for (const workstream of workstreams) {
      workstream.children = workstreams
        .filter((candidate) => candidate.parent === workstream.path)
        .map((candidate) => candidate.path);
      if (workstream.parent && !known.has(workstream.parent)) {
        errors.push({
          path: workstream.parent,
          reason: `Parent workstream ${workstream.parent} has no README.md`,
        });
      }
    }
    return {
      revision: tree.sha,
      branch,
      complete: errors.length === 0,
      workstreams,
      errors,
    };
  }

  async read(workstream, { signal } = {}) {
    validateWorkstreamPath(workstream);
    const branch = await this.#branch(signal);
    const sourcePath = `workstreams/${workstream}/README.md`;
    const result = await this.gh.runJson(
      [
        "api",
        "--method",
        "GET",
        `repos/${this.repository}/contents/${encodePath(sourcePath)}`,
        "-f",
        `ref=${branch}`,
      ],
      { signal },
    );
    if (
      result?.type !== "file" ||
      typeof result.content !== "string" ||
      typeof result.sha !== "string"
    ) {
      throw new Error(`GitHub returned invalid workstream content for ${workstream}`);
    }
    return {
      path: workstream,
      sourcePath,
      content: Buffer.from(result.content.replace(/\s/g, ""), "base64").toString(
        "utf8",
      ),
      contentHash: `git:${result.sha}`,
      revision: result.sha,
      branch,
      url:
        result.html_url ??
        `https://github.com/${this.repository}/blob/${branch}/${sourcePath}`,
    };
  }

  async validate(workstream, options) {
    return this.read(workstream, options);
  }

  async write(
    workstream,
    content,
    { message, signal, expectedSha } = {},
  ) {
    validateWorkstreamPath(workstream);
    if (typeof content !== "string") {
      throw new TypeError("content must be a string");
    }
    if (typeof message !== "string" || !message.trim()) {
      throw new TypeError("message is required");
    }
    const branch = await this.#branch(signal);
    const sourcePath = `workstreams/${workstream}/README.md`;
    const args = [
      "api",
      "--method",
      "PUT",
      `repos/${this.repository}/contents/${encodePath(sourcePath)}`,
      "-f",
      `message=${message}`,
      "-f",
      `content=${Buffer.from(content).toString("base64")}`,
      "-f",
      `branch=${branch}`,
    ];
    if (expectedSha) {
      args.push("-f", `sha=${expectedSha}`);
    }
    const result = await this.gh.runJson(args, { signal });
    if (typeof result?.content?.sha !== "string") {
      throw new Error("GitHub did not return the written workstream revision");
    }
    return this.read(workstream, { signal });
  }

  async #branch(signal) {
    if (!this.branchPromise) {
      const loading = this.gh
        .runJson(
          ["api", "--method", "GET", `repos/${this.repository}`],
          { signal },
        )
        .then((repository) => {
          if (typeof repository?.default_branch !== "string") {
            throw new Error("GitHub did not return the domain default branch");
          }
          return repository.default_branch;
        });
      this.branchPromise = loading;
      void loading.catch(() => {
        if (this.branchPromise === loading) {
          this.branchPromise = undefined;
        }
      });
    }
    return this.branchPromise;
  }
}

function encodePath(value) {
  return value.split("/").map(encodeURIComponent).join("/");
}

function parentPath(value) {
  const separator = value.lastIndexOf("/");
  return separator === -1 ? undefined : value.slice(0, separator);
}
