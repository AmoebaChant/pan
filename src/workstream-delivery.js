import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
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

  async publish({ operationId, sessionId, workstreamPath } = {}) {
    requireOperationId(operationId);
    requireText(sessionId, "sessionId");
    const receipt = await this.#readReceipt(operationId);
    this.#validateReceipt(receipt, { operationId, sessionId });
    if (workstreamPath !== undefined && workstreamPath !== receipt.workstream.path) {
      throw new Error("Workstream operation does not match the requested workstream path");
    }
    const expiresAt = Date.parse(receipt.expiresAt);
    if (!Number.isFinite(expiresAt) || this.now().getTime() > expiresAt) {
      return rejected(
        "The prepared workstream operation has expired.",
        "Prepare a fresh workspace against the current default branch before publishing.",
      );
    }
    const authority = await this.assertLeadership();
    if (!authority?.asserted) {
      return rejected(
        `Workstream publication requires current leadership${authority?.reason ? `: ${authority.reason}` : "."}`,
        "Restore leadership and re-evaluate the prepared workspace before publishing.",
      );
    }

    await this.#verifyRepository();
    const marker = workstreamMarker(receipt);
    const branch = receipt.target.defaultBranch;
    await this.#fetch(branch);
    const previous = await this.#publishedCommit(marker, branch);
    if (previous) {
      return confirmedPublication(
        previous,
        branch,
        await this.#completeCleanup(receipt),
        { duplicate: true },
      );
    }
    const remote = await this.#validateRemoteState(receipt);
    if (!remote.valid) {
      return rejected(
        remote.reason,
        "Prepare a fresh workspace and re-evaluate the workstream update against the current remote state.",
      );
    }
    let commit = receipt.delivery?.commit;
    if (!commit) {
      let workspace;
      try {
        workspace = await this.#validateWorkspace(receipt);
      } catch (error) {
        return rejected(
          error.message,
          "Remove unrelated, generated, deleted, or symbolic-link changes from the isolated workspace before retrying.",
        );
      }
      if (!workspace.changed) {
        return {
          status: "confirmed",
          noChange: true,
          diagnostics: ["The prepared workstream file has no changes to publish."],
          cleanup: await this.#completeCleanup(receipt),
        };
      }
      const beforeCommit = await this.#readyForMutation(receipt);
      if (!beforeCommit.valid) {
        return rejected(
          beforeCommit.reason,
          "Prepare a fresh workspace and re-evaluate the workstream update before committing.",
        );
      }
      await this.#run([
        "-C",
        receipt.workspace,
        "add",
        "--",
        receipt.workstream.sourcePath,
      ]);
      await this.#run([
        "-C",
        receipt.workspace,
        "commit",
        "-m",
        `PAN workstream update: ${receipt.workstream.path}`,
        "-m",
        commitMetadata(receipt, marker),
      ]);
      commit = await this.#run(["-C", receipt.workspace, "rev-parse", "HEAD"]);
      receipt.delivery = { commit, marker, committedAt: this.now().toISOString() };
      await this.#writeReceipt(receipt);
    }

    const beforePush = await this.#readyForMutation(receipt);
    if (!beforePush.valid) {
      return incompletePublication(
        commit,
        branch,
        beforePush.reason,
        "The local commit is retained in the isolated workspace. Restore leadership or refresh remote state before deciding whether it can be pushed.",
      );
    }
    try {
      await this.#run([
        "-C",
        receipt.workspace,
        "push",
        "origin",
        `HEAD:${branch}`,
      ]);
    } catch (error) {
      await this.#fetch(branch);
      const confirmed = await this.#publishedCommit(marker, branch);
      if (confirmed) {
        return confirmedPublication(
          confirmed,
          branch,
          await this.#completeCleanup(receipt),
        );
      }
      return incompletePublication(
        commit,
        branch,
        `Push was not confirmed: ${error.message}`,
        "The local commit is retained in the isolated workspace. Refresh the remote branch, resolve permissions, protection, or concurrent changes, then retry safely.",
      );
    }
    await this.#fetch(branch);
    const confirmed = await this.#publishedCommit(marker, branch);
    if (!confirmed) {
      return incompletePublication(
        commit,
        branch,
        "The push command completed, but the remote default branch does not confirm the workstream commit.",
        "Do not create another commit. Refresh the remote branch and retry confirmation with this operation ID.",
      );
    }
    return confirmedPublication(
      confirmed,
      branch,
      await this.#completeCleanup(receipt),
    );
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

  async #readReceipt(operationId) {
    const operationPath = path.join(this.operationDirectory, operationId);
    if (!isChildPath(this.operationDirectory, operationPath)) {
      throw new Error("Operation ID escapes the PAN operation directory");
    }
    try {
      return JSON.parse(
        await readFile(path.join(operationPath, "receipt.json"), "utf8"),
      );
    } catch (error) {
      throw new Error(`Unable to read workstream operation ${operationId}: ${error.message}`, {
        cause: error,
      });
    }
  }

  #validateReceipt(receipt, { operationId, sessionId }) {
    if (!receipt || receipt.version !== RECEIPT_VERSION) {
      throw new Error("Workstream operation receipt has an unsupported version");
    }
    if (receipt.operationId !== operationId || receipt.sessionId !== sessionId) {
      throw new Error("Workstream operation does not belong to this session");
    }
    if (
      receipt.domain?.repository !== this.repository ||
      path.resolve(receipt.domain?.path ?? "") !== this.repositoryPath
    ) {
      throw new Error("Workstream operation does not match the configured domain");
    }
    validateWorkstreamPath(receipt.workstream?.path);
    if (
      receipt.workstream.sourcePath !==
      `workstreams/${receipt.workstream.path}/README.md`
    ) {
      throw new Error("Workstream operation has an invalid source path");
    }
    if (
      typeof receipt.target?.defaultBranch !== "string" ||
      !receipt.target.defaultBranch ||
      !/^[0-9a-f]{40,64}$/.test(receipt.target.baseCommit ?? "")
    ) {
      throw new Error("Workstream operation has an invalid remote target");
    }
    const workspace = path.join(this.operationDirectory, operationId, "worktree");
    if (path.resolve(receipt.workspace ?? "") !== path.resolve(workspace)) {
      throw new Error("Workstream operation has an invalid workspace");
    }
    if (
      path.resolve(receipt.filePath ?? "") !==
      path.resolve(receipt.workspace, receipt.workstream.sourcePath)
    ) {
      throw new Error("Workstream operation has an invalid file path");
    }
  }

  async #writeReceipt(receipt) {
    await writeFile(
      receipt.cleanup.receiptPath,
      `${JSON.stringify(receipt, null, 2)}\n`,
    );
  }

  async #fetch(branch) {
    await this.#run(["-C", this.repositoryPath, "fetch", "origin", branch]);
  }

  async #validateRemoteState(receipt) {
    const branch = receipt.target.defaultBranch;
    const baseCommit = await this.#run([
      "-C",
      this.repositoryPath,
      "rev-parse",
      `origin/${branch}`,
    ]);
    if (baseCommit !== receipt.target.baseCommit) {
      return {
        valid: false,
        reason: `Remote default branch ${branch} advanced from the prepared base.`,
      };
    }
    const actualBlob = await this.#blobAt(
      baseCommit,
      receipt.workstream.sourcePath,
    );
    if (actualBlob !== (receipt.workstream.expectedBlob ?? undefined)) {
      return {
        valid: false,
        reason: "The prepared workstream target no longer matches the remote default branch.",
      };
    }
    return { valid: true };
  }

  async #readyForMutation(receipt) {
    const authority = await this.assertLeadership();
    if (!authority?.asserted) {
      return {
        valid: false,
        reason: `Leadership is no longer current${authority?.reason ? `: ${authority.reason}` : "."}`,
      };
    }
    await this.#fetch(receipt.target.defaultBranch);
    return this.#validateRemoteState(receipt);
  }

  async #validateWorkspace(receipt) {
    let metadata;
    try {
      metadata = await lstat(receipt.filePath);
    } catch (error) {
      throw new Error(`Prepared workstream README.md is unavailable: ${error.message}`, {
        cause: error,
      });
    }
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error("Prepared workstream README.md must be a regular file");
    }
    if (!(await readFile(receipt.filePath, "utf8")).trim()) {
      throw new Error("Prepared workstream README.md must not be empty");
    }
    const outputs = await Promise.all([
      this.#run(["-C", receipt.workspace, "diff", "--name-only"]),
      this.#run(["-C", receipt.workspace, "diff", "--cached", "--name-only"]),
      this.#run([
        "-C",
        receipt.workspace,
        "ls-files",
        "--others",
        "--exclude-standard",
      ]),
      this.#run([
        "-C",
        receipt.workspace,
        "ls-files",
        "--others",
        "--ignored",
        "--exclude-standard",
      ]),
    ]);
    const records = [
      ...new Set(
        outputs.flatMap((output) => output.split(/\r?\n/).filter(Boolean)),
      ),
    ];
    if (
      records.some((record) => record !== receipt.workstream.sourcePath)
    ) {
      throw new Error(
        "Prepared workspace contains changes outside the intended workstream README.md",
      );
    }
    await this.#run(["-C", receipt.workspace, "diff", "--check"]);
    await this.#run(["-C", receipt.workspace, "diff", "--cached", "--check"]);
    return { changed: records.length > 0 };
  }

  async #publishedCommit(marker, branch) {
    const output = await this.#run([
      "-C",
      this.repositoryPath,
      "log",
      `origin/${branch}`,
      "--format=%H",
      "--fixed-strings",
      "--grep",
      marker,
      "-n",
      "1",
    ]);
    return output || undefined;
  }

  async #completeCleanup(receipt) {
    try {
      if (receipt.cleanup.worktreeCreated) {
        await this.#run([
          "-C",
          this.repositoryPath,
          "worktree",
          "remove",
          "--force",
          receipt.workspace,
        ]);
        receipt.cleanup.worktreeCreated = false;
        await this.#writeReceipt(receipt);
      }
      return { completed: true, receiptPath: receipt.cleanup.receiptPath };
    } catch (error) {
      return {
        completed: false,
        workspace: receipt.workspace,
        receiptPath: receipt.cleanup.receiptPath,
        diagnostic: error.message,
      };
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

function requireOperationId(value) {
  if (
    typeof value !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value)
  ) {
    throw new TypeError("operationId must be a safe operation identifier");
  }
}

function isChildPath(root, candidate) {
  const relative = path.relative(root, candidate);
  return Boolean(relative) && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function workstreamMarker(receipt) {
  return `pan-workstream:${createHash("sha256")
    .update(`${receipt.operationId}\0${receipt.sessionId}\0${receipt.sourceTurn}`)
    .digest("hex")}`;
}

function commitMetadata(receipt, marker) {
  return [
    `PAN-Workstream-Operation: ${receipt.operationId}`,
    `PAN-Workstream-Session: ${receipt.sessionId}`,
    `PAN-Workstream-Source-Turn: ${receipt.sourceTurn}`,
    `PAN-Workstream-Idempotency: ${marker}`,
    `PAN-Workstream-Rationale: ${receipt.rationale}`,
  ].join("\n");
}

function rejected(diagnostic, step) {
  return {
    status: "rejected",
    diagnostics: [diagnostic],
    recovery: { safe: true, steps: [step] },
  };
}

function incompletePublication(commit, branch, diagnostic, step) {
  return {
    status: "incomplete",
    commitCreated: { sha: commit, branch },
    diagnostics: [diagnostic],
    recovery: { safe: true, steps: [step] },
  };
}

function confirmedPublication(commit, branch, cleanup, { duplicate = false } = {}) {
  return {
    status: "confirmed",
    commitCreated: { sha: commit, branch },
    pushConfirmed: { sha: commit, branch },
    cleanup,
    diagnostics: duplicate
      ? ["The workstream operation was already published."]
      : [],
  };
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
