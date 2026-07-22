import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ProcessClient } from "./process-client.js";
import {
  resolveConfinedWorkstreamReadme,
  resolveNewConfinedWorkstreamReadme,
  validateWorkstreamPath,
} from "./workstream-store.js";

const RECEIPT_VERSION = 1;
const DEFAULT_EXPIRY_MS = 60 * 60 * 1_000;

/**
 * Prepares isolated, optimistic-concurrency workspaces for workstream edits.
 */
export class WorkstreamDeliveryService {
  constructor({
    repositoryPath,
    repository,
    commands = new ProcessClient(),
    assertLeadership = async () => ({ asserted: true }),
    operationDirectory = defaultOperationDirectory(repositoryPath),
    operationIdFactory = randomUUID,
    now = () => new Date(),
    expiryMilliseconds = DEFAULT_EXPIRY_MS,
  } = {}) {
    if (!path.isAbsolute(repositoryPath ?? "")) {
      throw new TypeError("repositoryPath must be an absolute path");
    }
    if (!isRepository(repository)) {
      throw new TypeError("repository must be owner/name");
    }
    if (!commands?.run) {
      throw new TypeError("commands must provide run()");
    }
    if (typeof assertLeadership !== "function") {
      throw new TypeError("assertLeadership must be a function");
    }
    if (!path.isAbsolute(operationDirectory ?? "")) {
      throw new TypeError("operationDirectory must be an absolute path");
    }
    if (
      isChildPath(
        path.resolve(repositoryPath),
        path.resolve(operationDirectory),
      )
    ) {
      throw new TypeError(
        "operationDirectory must be outside the configured repository",
      );
    }
    if (typeof operationIdFactory !== "function") {
      throw new TypeError("operationIdFactory must be a function");
    }
    if (typeof now !== "function") {
      throw new TypeError("now must be a function");
    }
    if (!Number.isInteger(expiryMilliseconds) || expiryMilliseconds < 1) {
      throw new TypeError("expiryMilliseconds must be a positive integer");
    }
    this.repositoryPath = path.resolve(repositoryPath);
    this.repository = repository;
    this.commands = commands;
    this.assertLeadership = assertLeadership;
    this.operationDirectory = path.resolve(operationDirectory);
    this.operationIdFactory = operationIdFactory;
    this.now = now;
    this.expiryMilliseconds = expiryMilliseconds;
  }

  async prepare({
    workstream,
    sessionId,
    rationale = "Workstream update prepared by PAN.",
    sourceTurn,
  } = {}) {
    validateWorkstreamPath(workstream);
    requireText(sessionId, "sessionId");
    requireText(rationale, "rationale");
    const authority = await this.assertLeadership();
    if (!authority?.asserted) {
      return {
        status: "rejected",
        diagnostics: [
          `Workstream preparation requires current leadership${authority?.reason ? `: ${authority.reason}` : "."}`,
        ],
        recovery: {
          safe: true,
          steps: [
            "Acquire or restore leadership, then prepare a fresh workstream workspace.",
          ],
        },
      };
    }

    await this.#verifyRepository();
    const defaultBranch = await this.#defaultBranch();
    await this.#run(["-C", this.repositoryPath, "fetch", "origin", defaultBranch]);
    const baseCommit = await this.#run([
      "-C",
      this.repositoryPath,
      "rev-parse",
      `origin/${defaultBranch}`,
    ]);
    const sourcePath = `workstreams/${workstream}/README.md`;
    const expectedBlob = await this.#blobAt(baseCommit, sourcePath);
    const operationId = this.operationIdFactory();
    requireText(operationId, "operationId");
    const operationPath = await this.#createOperationDirectory(operationId);
    const workspace = path.join(operationPath, "worktree");
    let worktreeCreated = false;

    try {
      await this.#run([
        "-C",
        this.repositoryPath,
        "worktree",
        "add",
        "--detach",
        workspace,
        baseCommit,
      ]);
      worktreeCreated = true;

      const filePath = expectedBlob
        ? await resolveConfinedWorkstreamReadme(workspace, workstream)
        : await this.#prepareNewWorkstream(workspace, workstream);
      const preparedAt = this.now().toISOString();
      const receipt = {
        version: RECEIPT_VERSION,
        operationId,
        sessionId,
        domain: {
          repository: this.repository,
          path: this.repositoryPath,
        },
        workstream: {
          path: workstream,
          sourcePath,
          expectedBlob: expectedBlob ?? null,
          expectedAbsent: expectedBlob === undefined,
        },
        target: {
          defaultBranch,
          baseCommit,
        },
        workspace,
        filePath,
        rationale,
        sourceTurn: sourceTurn ?? sessionId,
        preparedAt,
        expiresAt: new Date(
          Date.parse(preparedAt) + this.expiryMilliseconds,
        ).toISOString(),
        cleanup: {
          operationPath,
          receiptPath: path.join(operationPath, "receipt.json"),
          worktreeCreated,
        },
      };
      await writeFile(
        receipt.cleanup.receiptPath,
        `${JSON.stringify(receipt, null, 2)}\n`,
        { flag: "wx" },
      );
      return { status: "confirmed", receipt };
    } catch (error) {
      await this.#cleanup(operationPath, workspace, worktreeCreated);
      throw new Error(
        `Unable to prepare workstream ${workstream}; no user working tree was changed: ${error.message}`,
        { cause: error },
      );
    }
  }

  async #verifyRepository() {
    const [root, remote] = await Promise.all([
      this.#run(["-C", this.repositoryPath, "rev-parse", "--show-toplevel"]),
      this.#run(["-C", this.repositoryPath, "remote", "get-url", "origin"]),
    ]);
    const [expectedRoot, actualRoot] = await Promise.all([
      realpath(this.repositoryPath),
      realpath(root),
    ]);
    if (expectedRoot !== actualRoot) {
      throw new Error("Configured domain path must be the repository root");
    }
    const actualRepository = normalizeGitHubRepositoryUrl(remote);
    if (actualRepository?.toLowerCase() !== this.repository.toLowerCase()) {
      throw new Error(
        `Configured path origin is ${actualRepository ?? "not a GitHub repository"}, expected ${this.repository}`,
      );
    }
  }

  async #defaultBranch() {
    const output = await this.#run([
      "-C",
      this.repositoryPath,
      "symbolic-ref",
      "--quiet",
      "--short",
      "refs/remotes/origin/HEAD",
    ]);
    const prefix = "origin/";
    if (!output.startsWith(prefix) || !output.slice(prefix.length)) {
      throw new Error("Origin does not advertise a default branch");
    }
    return output.slice(prefix.length);
  }

  async #blobAt(commit, sourcePath) {
    const entries = await this.#run([
      "-C",
      this.repositoryPath,
      "ls-tree",
      commit,
      "--",
      sourcePath,
    ]);
    if (!entries) {
      return undefined;
    }
    const match = entries.match(/^\d+\s+blob\s+([0-9a-f]{40,64})\t/m);
    if (!match) {
      throw new Error(`Target ${sourcePath} is not a regular Git blob`);
    }
    return match[1];
  }

  async #createOperationDirectory(operationId) {
    await mkdir(this.operationDirectory, { recursive: true });
    const root = await realpath(this.operationDirectory);
    if (root !== this.operationDirectory) {
      throw new Error("PAN operation directory must not be a symbolic link");
    }
    const operationPath = path.join(root, operationId);
    if (!isChildPath(root, operationPath)) {
      throw new Error("Operation ID escapes the PAN operation directory");
    }
    await mkdir(operationPath);
    return operationPath;
  }

  async #prepareNewWorkstream(workspace, workstream) {
    const filePath = await resolveNewConfinedWorkstreamReadme(
      workspace,
      workstream,
    );
    await mkdir(path.dirname(filePath), { recursive: true });
    return filePath;
  }

  async #cleanup(operationPath, workspace, worktreeCreated) {
    const errors = [];
    if (worktreeCreated) {
      try {
        await this.#run([
          "-C",
          this.repositoryPath,
          "worktree",
          "remove",
          "--force",
          workspace,
        ]);
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      await rm(operationPath, { recursive: true, force: true });
    } catch (error) {
      errors.push(error);
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, "Unable to clean failed workstream preparation");
    }
  }

  #run(args) {
    return this.commands.run("git", args, {
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
  }
}

export function readWorkstreamOperationReceipt(receiptPath) {
  return readFile(receiptPath, "utf8").then((content) => JSON.parse(content));
}

function defaultOperationDirectory(repositoryPath) {
  const key = createHash("sha256")
    .update(path.resolve(repositoryPath ?? ""))
    .digest("hex");
  return path.join(os.homedir(), ".pan", "workstream-operations", key);
}

function isRepository(value) {
  return typeof value === "string" && /^[^/\s]+\/[^/\s]+$/.test(value);
}

function requireText(value, name) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${name} is required`);
  }
}

function isChildPath(root, candidate) {
  const relative = path.relative(root, candidate);
  return Boolean(relative) && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export function normalizeGitHubRepositoryUrl(url) {
  if (typeof url !== "string") {
    return undefined;
  }
  const trimmed = url.trim().replace(/\/+$/, "");
  const match = trimmed.match(
    /(?:github\.com[:/])([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i,
  );
  return match ? `${match[1]}/${match[2]}` : undefined;
}
