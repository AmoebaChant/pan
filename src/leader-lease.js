import { randomUUID } from "node:crypto";

import { processIsAlive } from "./process-tree.js";

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
    machine,
    pid,
    sessionId,
    holderKind,
    isProcessAlive = processIsAlive,
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
    if (
      (machine === undefined) !== (pid === undefined) ||
      (machine !== undefined && !machine?.trim()) ||
      (pid !== undefined && (!Number.isInteger(pid) || pid <= 0))
    ) {
      throw new TypeError(
        "machine and a positive integer pid must be provided together",
      );
    }
    if (typeof isProcessAlive !== "function") {
      throw new TypeError("isProcessAlive must be a function");
    }
    if (sessionId !== undefined && !sessionId?.trim()) {
      throw new TypeError("sessionId must be a non-empty string when provided");
    }
    if (holderKind !== undefined && !holderKind?.trim()) {
      throw new TypeError("holderKind must be a non-empty string when provided");
    }
    this.stateFile = stateFile;
    this.holder = holder;
    this.leaseSeconds = leaseSeconds;
    this.now = now;
    this.tokenFactory = tokenFactory;
    this.machine = machine;
    this.pid = pid;
    this.sessionId = sessionId;
    this.holderKind = holderKind;
    this.isProcessAlive = isProcessAlive;
    this.token = undefined;
  }

  async acquire() {
    const current = await this.stateFile.read();
    const active = isActive(current.value, this.now());
    const abandonedLease =
      active && this.#isAbandonedLocalLease(current.value);
    if (active && !abandonedLease) {
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
    return {
      acquired: true,
      lease: confirmed.value,
      ...(abandonedLease ? { reclaimed: current.value } : {}),
    };
  }

  async status() {
    const current = await this.stateFile.read();
    return {
      status: this.#status(current.value),
      lease: current.value,
      version: current.version,
    };
  }

  async assert({ token = this.token, sessionId = this.sessionId } = {}) {
    const current = await this.stateFile.read();
    if (!current.value) {
      return { asserted: false, reason: "absent" };
    }
    if (!isActive(current.value, this.now())) {
      return { asserted: false, reason: "expired", lease: current.value };
    }
    if (!this.#matches(current.value, token, sessionId)) {
      return { asserted: false, reason: "lost", lease: current.value };
    }
    return { asserted: true, lease: current.value, version: current.version };
  }

  async heartbeat() {
    return this.renew();
  }

  async renew({ token = this.token, sessionId = this.sessionId } = {}) {
    const current = await this.stateFile.read();
    if (!token) {
      return { renewed: false, reason: "not-acquired" };
    }
    if (!current.value) {
      return { renewed: false, reason: "absent" };
    }
    if (!isActive(current.value, this.now())) {
      return { renewed: false, reason: "expired" };
    }
    if (!this.#matches(current.value, token, sessionId)) {
      return { renewed: false, reason: "lost" };
    }
    const lease = this.#newLease(token);
    const version = await this.stateFile.write(lease, current.version);
    return version
      ? { renewed: true, lease }
      : { renewed: false, reason: "contended" };
  }

  async release({ token = this.token, sessionId = this.sessionId } = {}) {
    if (!token) {
      return { released: false, reason: "not-acquired" };
    }
    const current = await this.stateFile.read();
    if (!current.value) {
      return { released: false, reason: "absent" };
    }
    if (!isActive(current.value, this.now())) {
      return { released: false, reason: "expired" };
    }
    if (!this.#matches(current.value, token, sessionId)) {
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
      ? { released: true, lease: released }
      : { released: false, reason: "contended" };
  }

  #newLease(token) {
    return {
      version: 1,
      holder: this.holder,
      ...(this.machine === undefined
        ? {}
        : { machine: this.machine, pid: this.pid }),
      token,
      ...(this.sessionId === undefined ? {} : { sessionId: this.sessionId }),
      ...(this.holderKind === undefined ? {} : { holderKind: this.holderKind }),
      expiresAt: new Date(
        this.now().getTime() + this.leaseSeconds * 1_000,
      ).toISOString(),
    };
  }

  #matches(lease, token, sessionId) {
    return (
      lease.holder === this.holder &&
      lease.token === token &&
      (this.sessionId === undefined || lease.sessionId === sessionId)
    );
  }

  #status(lease) {
    if (!lease) {
      return "absent";
    }
    if (!isActive(lease, this.now())) {
      return "expired";
    }
    if (this.#isAbandonedLocalLease(lease)) {
      return "locally-recoverable";
    }
    const process = leaseProcess(lease);
    if (
      process &&
      this.machine !== undefined &&
      process.machine !== this.machine
    ) {
      return "remote-or-unverifiable";
    }
    if (!process && lease.holder !== this.holder) {
      return "remote-or-unverifiable";
    }
    return "active";
  }

  #isAbandonedLocalLease(lease) {
    if (this.machine === undefined) {
      return false;
    }
    const leaseHolder = leaseProcess(lease);
    return (
      leaseHolder?.machine === this.machine &&
      leaseHolder.pid !== this.pid &&
      !this.isProcessAlive(leaseHolder.pid)
    );
  }
}

function leaseProcess(lease) {
  if (
    typeof lease?.machine === "string" &&
    lease.machine &&
    Number.isInteger(lease.pid) &&
    lease.pid > 0
  ) {
    return { machine: lease.machine, pid: lease.pid };
  }
  const match = lease?.holder?.match(/^(.+)\/pan-(\d+)$/);
  const pid = Number(match?.[2]);
  return match && Number.isSafeInteger(pid) && pid > 0
    ? { machine: match[1], pid }
    : undefined;
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
