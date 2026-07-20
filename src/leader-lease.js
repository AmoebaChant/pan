import { randomUUID } from "node:crypto";

const DEFAULT_BRANCH = "pan-state";
const DEFAULT_PATH = ".pan/leader.json";

export class GitHubStateFile {
  constructor({
    gh,
    repository,
    branch = DEFAULT_BRANCH,
    filePath = DEFAULT_PATH,
  }) {
    if (!gh?.runJson) {
      throw new TypeError("gh must provide runJson()");
    }
    if (!repository?.includes("/")) {
      throw new TypeError("repository must be owner/name");
    }
    this.gh = gh;
    this.repository = repository;
    this.branch = branch;
    this.filePath = filePath;
    this.branchReady = false;
  }

  async read() {
    await this.#ensureBranch();
    try {
      const result = await this.gh.runJson([
        "api",
        "--method",
        "GET",
        `repos/${this.repository}/contents/${this.filePath}`,
        "-f",
        `ref=${this.branch}`,
      ]);
      return {
        value: JSON.parse(
          Buffer.from(result.content.replaceAll("\n", ""), "base64").toString(
            "utf8",
          ),
        ),
        version: result.sha,
      };
    } catch (error) {
      if (isNotFound(error)) {
        return { value: undefined, version: undefined };
      }
      throw error;
    }
  }

  async write(value, expectedVersion) {
    await this.#ensureBranch();
    const args = [
      "api",
      "--method",
      "PUT",
      `repos/${this.repository}/contents/${this.filePath}`,
      "-f",
      `message=PAN leader lease ${value.holder}`,
      "-f",
      `content=${Buffer.from(`${JSON.stringify(value, null, 2)}\n`).toString("base64")}`,
      "-f",
      `branch=${this.branch}`,
    ];
    if (expectedVersion) {
      args.push("-f", `sha=${expectedVersion}`);
    }
    try {
      const result = await this.gh.runJson(args);
      return result.content?.sha;
    } catch (error) {
      if (isConflict(error)) {
        return undefined;
      }
      throw error;
    }
  }

  async #ensureBranch() {
    if (this.branchReady) {
      return;
    }
    try {
      await this.gh.runJson([
        "api",
        "--method",
        "GET",
        `repos/${this.repository}/git/ref/heads/${this.branch}`,
      ]);
      this.branchReady = true;
      return;
    } catch (error) {
      if (!isNotFound(error)) {
        throw error;
      }
    }

    const repository = await this.gh.runJson([
      "api",
      "--method",
      "GET",
      `repos/${this.repository}`,
    ]);
    const base = await this.gh.runJson([
      "api",
      "--method",
      "GET",
      `repos/${this.repository}/git/ref/heads/${repository.default_branch}`,
    ]);
    try {
      await this.gh.runJson([
        "api",
        "--method",
        "POST",
        `repos/${this.repository}/git/refs`,
        "-f",
        `ref=refs/heads/${this.branch}`,
        "-f",
        `sha=${base.object.sha}`,
      ]);
    } catch (error) {
      if (!isConflict(error)) {
        throw error;
      }
    }
    this.branchReady = true;
  }
}

export class LeaderLease {
  constructor({
    stateFile,
    holder,
    leaseSeconds = 120,
    now = () => new Date(),
    tokenFactory = randomUUID,
  }) {
    if (!stateFile?.read || !stateFile?.write) {
      throw new TypeError("stateFile must provide read() and write()");
    }
    if (!holder?.trim()) {
      throw new TypeError("holder is required");
    }
    if (!Number.isFinite(leaseSeconds) || leaseSeconds <= 0) {
      throw new TypeError("leaseSeconds must be positive");
    }
    this.stateFile = stateFile;
    this.holder = holder;
    this.leaseSeconds = leaseSeconds;
    this.now = now;
    this.tokenFactory = tokenFactory;
    this.token = undefined;
  }

  async acquire() {
    const current = await this.stateFile.read();
    if (
      isActive(current.value, this.now()) &&
      current.value.holder !== this.holder
    ) {
      return { acquired: false, lease: current.value };
    }
    const lease = this.#newLease(this.tokenFactory());
    const version = await this.stateFile.write(lease, current.version);
    if (!version) {
      return { acquired: false, reason: "contended" };
    }
    const confirmed = await this.stateFile.read();
    if (
      confirmed.value?.holder !== lease.holder ||
      confirmed.value?.token !== lease.token
    ) {
      return { acquired: false, reason: "not-confirmed" };
    }
    this.token = lease.token;
    return { acquired: true, lease: confirmed.value };
  }

  async heartbeat() {
    if (!this.token) {
      return { renewed: false, reason: "not-acquired" };
    }
    const current = await this.stateFile.read();
    if (
      current.value?.holder !== this.holder ||
      current.value?.token !== this.token ||
      !isActive(current.value, this.now())
    ) {
      return { renewed: false, reason: "lost" };
    }
    const lease = this.#newLease(this.token);
    const version = await this.stateFile.write(lease, current.version);
    return version
      ? { renewed: true, lease }
      : { renewed: false, reason: "contended" };
  }

  async release() {
    if (!this.token) {
      return { released: false, reason: "not-acquired" };
    }
    const current = await this.stateFile.read();
    if (
      current.value?.holder !== this.holder ||
      current.value?.token !== this.token
    ) {
      this.token = undefined;
      return { released: false, reason: "lost" };
    }
    const released = {
      ...current.value,
      expiresAt: this.now().toISOString(),
    };
    const version = await this.stateFile.write(released, current.version);
    this.token = undefined;
    return version
      ? { released: true }
      : { released: false, reason: "contended" };
  }

  #newLease(token) {
    return {
      version: 1,
      holder: this.holder,
      token,
      expiresAt: new Date(
        this.now().getTime() + this.leaseSeconds * 1_000,
      ).toISOString(),
    };
  }
}

function isActive(lease, now) {
  return lease && Date.parse(lease.expiresAt) > now.getTime();
}

function isNotFound(error) {
  return /\b404\b|not found/i.test(error.stderr ?? error.message);
}

function isConflict(error) {
  return /\b409\b|\b422\b|conflict|sha does not match/i.test(
    error.stderr ?? error.message,
  );
}
