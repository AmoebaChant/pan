import { realpath, stat } from "node:fs/promises";
import path from "node:path";

import { GhClient } from "./gh-client.js";
import { PanStore } from "./pan-store.js";
import { ProcessClient } from "./process-client.js";
import { normalizeGitHubRepositoryUrl } from "./workstream-delivery.js";

/**
 * Verifies that a session can safely use the configured domain as its sole source of truth.
 */
export class DomainIdentity {
  constructor({
    env = process.env,
    commands = new ProcessClient(),
    gh = new GhClient({ env }),
    storeFactory = (options) => new PanStore(options),
    realpathImpl = realpath,
    statImpl = stat,
  } = {}) {
    if (!commands?.run) {
      throw new TypeError("commands must provide run()");
    }
    if (!gh?.run) {
      throw new TypeError("gh must provide run()");
    }
    if (typeof storeFactory !== "function") {
      throw new TypeError("storeFactory must be a function");
    }
    this.commands = commands;
    this.env = env;
    this.gh = gh;
    this.storeFactory = storeFactory;
    this.realpath = realpathImpl;
    this.stat = statImpl;
  }

  async validate(config) {
    const domain = config?.domain;
    const state = config?.state;
    if (!domain?.path || !domain.repository || !state?.branch || !state?.leaderPath) {
      throw new TypeError("A normalized PAN domain configuration is required");
    }

    const domainPath = path.resolve(domain.path);
    await this.#validateDirectory(domainPath, "Configured domain path");
    const [root, remote] = await Promise.all([
      this.#git(["-C", domainPath, "rev-parse", "--show-toplevel"]),
      this.#git(["-C", domainPath, "remote", "get-url", "origin"]),
    ]);
    await this.#validateRoot(domainPath, root);
    const repository = normalizeGitHubRepositoryUrl(remote);
    if (repository?.toLowerCase() !== domain.repository.toLowerCase()) {
      throw new Error(
        `Configured domain path origin is ${repository ?? "not a GitHub repository"}, expected ${domain.repository}`,
      );
    }

    await this.gh.run(["auth", "status", "--hostname", "github.com"]);
    const [defaultBranch, remoteHead, schema] = await Promise.all([
      this.#defaultBranch(domain.repository),
      this.#git(["-C", domainPath, "ls-remote", "--symref", "origin", "HEAD"]),
      this.#schema(config),
    ]);
    const localDefaultBranch = parseRemoteHead(remoteHead);
    if (localDefaultBranch !== defaultBranch) {
      throw new Error(
        `Configured domain origin default branch is ${localDefaultBranch}, expected ${defaultBranch}`,
      );
    }
    this.#validateStateNamespace(state);
    await this.#validateProductContextRoots(config.session?.productContextRoots ?? []);

    return Object.freeze({
      domain: Object.freeze({
        repository: domain.repository,
        path: domainPath,
        defaultBranch,
      }),
      project: Object.freeze({
        owner: domain.projectOwner,
        number: domain.projectNumber,
        id: schema.projectId,
      }),
      state: Object.freeze({
        branch: state.branch,
        path: state.path,
        leaderPath: state.leaderPath,
      }),
    });
  }

  async #validateDirectory(directory, label) {
    let entry;
    try {
      entry = await this.stat(directory);
    } catch (error) {
      throw new Error(`${label} is inaccessible: ${directory}`, {
        cause: error,
      });
    }
    if (!entry.isDirectory()) {
      throw new Error(`${label} is not a directory: ${directory}`);
    }
  }

  async #validateRoot(directory, reportedRoot) {
    const [expected, actual] = await Promise.all([
      this.realpath(directory),
      this.realpath(reportedRoot.trim()),
    ]);
    if (expected !== actual) {
      throw new Error("Configured domain path must be the repository root");
    }
  }

  async #defaultBranch(repository) {
    const branch = (
      await this.gh.run(["api", `repos/${repository}`, "--jq", ".default_branch"])
    ).trim();
    if (!branch) {
      throw new Error(`GitHub did not return a default branch for ${repository}`);
    }
    return branch;
  }

  async #schema(config) {
    const store = this.storeFactory({
      repository: config.domain.repository,
      projectOwner: config.domain.projectOwner,
      projectNumber: config.domain.projectNumber,
      gh: this.gh,
    });
    if (!store?.getSchema) {
      throw new TypeError("storeFactory must return a store with getSchema()");
    }
    return store.getSchema({ refresh: true });
  }

  #validateStateNamespace(state) {
    if (
      state.leaderPath !== `${state.path}/leader.json` ||
      path.isAbsolute(state.path) ||
      state.path.split(/[\\/]/).includes("..")
    ) {
      throw new Error("Configured PAN state namespace is invalid");
    }
  }

  async #validateProductContextRoots(roots) {
    for (const root of roots) {
      await this.#validateDirectory(root.path, "Product-context root");
    }
  }

  #git(args) {
    return this.commands.run("git", args, {
      env: this.env,
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
  }
}

function parseRemoteHead(output) {
  const match = output.match(/^ref:\s+refs\/heads\/([^\s]+)\s+HEAD$/m);
  if (!match) {
    throw new Error(
      "Configured domain origin does not advertise a default branch; run `git fetch origin` and retry",
    );
  }
  return match[1];
}
