import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ProcessClient } from "./process-client.js";
import {
  processIsAlive,
  terminateProcessByPid,
} from "./process-tree.js";
import {
  resolveConfinedWorkstreamReadme,
  resolveWorkstreamReadme,
} from "./workstream-store.js";

const WORKER_PATH = fileURLToPath(new URL("./task-worker.js", import.meta.url));
const RESULT_POLL_MS = 1_000;
const WORKER_START_GRACE_MS = 30_000;

export class LocalTaskExecutor {
  constructor({
    profile,
    commands = new ProcessClient(),
    spawnProcess = spawn,
    now = () => new Date(),
    sleep = (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
    randomId = randomUUID,
    workerIsAlive = processIsAlive,
    terminateWorker = terminateProcessByPid,
    logger = console,
  }) {
    this.profile = profile;
    this.commands = commands;
    this.spawnProcess = spawnProcess;
    this.now = now;
    this.sleep = sleep;
    this.randomId = randomId;
    this.workerIsAlive = workerIsAlive;
    this.terminateWorker = terminateWorker;
    this.logger = logger;
  }

  async start({ item, repository, runner, playbook, deadline }) {
    const repositoryConfig = this.profile.repositories[repository];
    if (!repositoryConfig) {
      throw new Error(`Runner cannot service repository ${repository}`);
    }
    const selectedPlaybook = playbook ?? {
      id: "legacy",
      instructions: [],
    };

    await mkdir(this.profile.workspaceRoot, { recursive: true });
    await mkdir(this.profile.stateDirectory, { recursive: true });
    const allocation = await this.#allocateTask(item);
    const { taskName, branch, worktreePath, statePath } = allocation;
    if (branch === repositoryConfig.defaultBranch) {
      throw new Error("Task branch must not be the default branch");
    }

    let worktreeCreated = false;
    try {
      const expectedRemote = await this.#run(deadline, "git", [
        "-C",
        repositoryConfig.path,
        "remote",
        "get-url",
        "origin",
      ]);
      const remoteRepository = normalizeGitHubRepositoryUrl(expectedRemote);
      if (remoteRepository?.toLowerCase() !== repository.toLowerCase()) {
        throw new Error(
          `Configured path origin is ${remoteRepository ?? "not a GitHub repository"}, expected ${repository}`,
        );
      }
      await this.#run(deadline, "git", [
        "-C",
        repositoryConfig.path,
        "fetch",
        "origin",
        repositoryConfig.defaultBranch,
      ]);
      await this.#run(deadline, "git", [
        "-C",
        repositoryConfig.path,
        "worktree",
        "add",
        worktreePath,
        "-b",
        branch,
        `origin/${repositoryConfig.defaultBranch}`,
      ]);
      worktreeCreated = true;

      const workstreamPath = await resolveConfinedWorkstreamReadme(
        this.profile.store.path,
        item.fields.workstream,
      );
      const workstream = await readFile(workstreamPath, "utf8");
      const context = {
        version: 1,
        runner,
        issue: {
          number: item.number,
          title: item.title,
          body: item.body,
          url: item.url,
          repository: item.repository,
          comments: item.comments ?? [],
        },
        target: {
          repository,
          defaultBranch: repositoryConfig.defaultBranch,
          branch,
          worktreePath,
        },
        playbook: {
          id: selectedPlaybook.id,
          instructions: selectedPlaybook.instructions,
        },
        workstream: {
          path: item.fields.workstream,
          sourcePath: workstreamPath,
          content: workstream,
        },
        paths: {
          statePath,
          agentResult: path.join(statePath, "agent-result.json"),
          result: path.join(statePath, "result.json"),
          needsHuman: path.join(statePath, "needs-human.json"),
          log: path.join(statePath, "copilot.log"),
          worker: path.join(statePath, "worker.json"),
          cancel: path.join(statePath, "cancel.json"),
        },
        copilot: {
          executable: this.profile.copilot.executable,
          model: this.profile.copilot.model,
          ...this.profile.taskBudget,
          deadline,
        },
      };
      const contextPath = path.join(statePath, "context.json");
      await writeFile(contextPath, `${JSON.stringify(context, null, 2)}\n`);

      const title = terminalTitle(item);
      await launchTerminal({
        executable: this.profile.terminal.executable,
        window: this.profile.terminal.window,
        title,
        workerPath: WORKER_PATH,
        contextPath,
        spawnProcess: this.spawnProcess,
      });

      return new LocalTaskHandle({
        item,
        repository,
        repositoryConfig,
        expectedRemote,
        profile: this.profile,
        commands: this.commands,
        sleep: this.sleep,
        title,
        branch,
        worktreePath,
        statePath,
        resultPath: context.paths.result,
        needsHumanPath: context.paths.needsHuman,
        workerPath: context.paths.worker,
        cancelPath: context.paths.cancel,
        workerStartDeadline:
          this.now().getTime() + WORKER_START_GRACE_MS,
        workerIsAlive: this.workerIsAlive,
        terminateWorker: this.terminateWorker,
        logger: this.logger,
        now: () => this.now().getTime(),
        deadline,
      });
    } catch (error) {
      const cleanupErrors = [];
      if (worktreeCreated) {
        try {
          await this.#runCleanup("git", [
            "-C",
            repositoryConfig.path,
            "worktree",
            "remove",
            "--force",
            worktreePath,
          ]);
          await this.#runCleanup("git", [
            "-C",
            repositoryConfig.path,
            "branch",
            "--delete",
            "--force",
            branch,
          ]);
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
      }
      try {
        await rm(statePath, { recursive: true, force: true });
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
      if (cleanupErrors.length) {
        throw new AggregateError(
          [error, ...cleanupErrors],
          `Task launch failed and cleanup was incomplete: ${error.message}`,
        );
      }
      throw error;
    }
  }

  async #allocateTask(item) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const token = allocationToken(this.randomId());
      const taskName = `issue-${item.number}-${token}`;
      const statePath = path.join(this.profile.stateDirectory, taskName);
      try {
        await mkdir(statePath);
        return {
          taskName,
          branch: `pan/issue-${item.number}-${slugify(item.title)}-${token}`,
          worktreePath: path.join(this.profile.workspaceRoot, taskName),
          statePath,
        };
      } catch (error) {
        if (error.code !== "EEXIST") {
          throw error;
        }
      }
    }
    throw new Error(`Unable to allocate unique workspace for issue ${item.number}`);
  }

  async #run(deadline, executable, args) {
    return this.commands.run(executable, args, {
      timeout: remainingMilliseconds(
        deadline,
        () => this.now().getTime(),
      ),
    });
  }

  async #runCleanup(executable, args) {
    return this.commands.run(executable, args, {
      timeout: 30_000,
    });
  }
}

class LocalTaskHandle {
  constructor(options) {
    Object.assign(this, options);
    this.lastNeedsHuman = undefined;
    this.cancellation = new Promise((resolve) => {
      this.resolveCancellation = resolve;
    });
  }

  async wait({ onNeedsHuman } = {}) {
    while (
      this.deadline === undefined ||
      this.now() < this.deadline + 60_000
    ) {
      if (this.cancelledResult) {
        return this.cancelledResult;
      }
      const needsHuman = await readJsonIfReady(this.needsHumanPath);
      const serialized = needsHuman ? JSON.stringify(needsHuman) : undefined;
      if (
        needsHuman &&
        serialized !== this.lastNeedsHuman &&
        onNeedsHuman
      ) {
        this.lastNeedsHuman = serialized;
        await onNeedsHuman(normalizeNeedsHuman(needsHuman, this));
      }

      const result = await readJsonIfReady(this.resultPath);
      if (result) {
        return normalizeResult(result);
      }
      const worker = await readJsonIfReady(this.workerPath);
      if (worker) {
        if (!Number.isInteger(worker.pid) || worker.pid <= 0) {
          await this.cancel("The task worker reported invalid process state.");
          return this.cancelledResult;
        }
        if (!this.workerIsAlive(worker.pid)) {
          await this.cancel(
            "The task worker exited without reporting a result.",
          );
          return this.cancelledResult;
        }
      } else if (this.now() >= this.workerStartDeadline) {
        await this.cancel("The task worker did not start.");
        return this.cancelledResult;
      }
      const cancelled = await Promise.race([
        this.sleep(RESULT_POLL_MS).then(() => undefined),
        this.cancellation,
      ]);
      if (cancelled) {
        return cancelled;
      }
    }
    await this.cancel(
      "The task worker did not report a result before its budget expired.",
      { budgetExceeded: true },
    );
    return this.cancelledResult;
  }

  async cancel(summary = "The task worker was stopped.", details = {}) {
    if (this.cancelPromise) {
      return this.cancelPromise;
    }
    this.cancelledResult = {
      status: "failed",
      summary,
      ...details,
    };
    this.cancelPromise = (async () => {
      try {
        await writeFile(
          this.cancelPath,
          `${JSON.stringify(this.cancelledResult, null, 2)}\n`,
        );
        const worker = await readJsonIfReady(this.workerPath);
        if (
          Number.isInteger(worker?.pid) &&
          worker.pid > 0 &&
          this.workerIsAlive(worker.pid)
        ) {
          while (this.workerIsAlive(worker.pid)) {
            try {
              await this.terminateWorker(worker.pid);
            } catch (error) {
              this.logger.error?.(
                `Unable to stop task worker ${worker.pid}; retrying.`,
                error,
              );
              await this.sleep(5_000);
            }
          }
        }
      } finally {
        this.resolveCancellation(this.cancelledResult);
      }
    })();
    return this.cancelPromise;
  }

  async complete(result, { assertLease } = {}) {
    await assertLease?.();
    const currentBranch = await this.#run("git", [
      "-C",
      this.worktreePath,
      "branch",
      "--show-current",
    ]);
    if (currentBranch !== this.branch) {
      throw new Error(
        `Task changed branches from ${this.branch} to ${currentBranch}`,
      );
    }
    if (currentBranch === this.repositoryConfig.defaultBranch) {
      throw new Error("Task attempted to work on the default branch");
    }

    const dirty = await this.#run("git", [
      "-C",
      this.worktreePath,
      "status",
      "--porcelain",
    ]);
    if (dirty) {
      await this.#run("git", [
        "-C",
        this.worktreePath,
        "add",
        "--all",
      ]);
      await assertLease?.();
      await this.#run("git", [
        "-c",
        "core.hooksPath=NUL",
        "-C",
        this.worktreePath,
        "commit",
        "-m",
        `Issue #${this.item.number}: ${truncate(this.item.title, 50)}`,
      ]);
    }

    const commitCount = Number(
      await this.#run("git", [
        "-C",
        this.worktreePath,
        "rev-list",
        "--count",
        `origin/${this.repositoryConfig.defaultBranch}..HEAD`,
      ]),
    );
    if (!Number.isInteger(commitCount) || commitCount < 1) {
      throw new Error("Task completed without producing a commit");
    }

    await this.#run("git", [
      "-C",
      this.worktreePath,
      "merge-base",
      "--is-ancestor",
      `origin/${this.repositoryConfig.defaultBranch}`,
      "HEAD",
    ]);
    await assertLease?.();
    const currentRemote = await this.#run("git", [
      "-C",
      this.repositoryConfig.path,
      "remote",
      "get-url",
      "origin",
    ]);
    if (currentRemote !== this.expectedRemote) {
      throw new Error("The task changed the repository origin URL");
    }
    await this.#run("git", [
      "-C",
      this.worktreePath,
      "push",
      "--set-upstream",
      this.expectedRemote,
      `HEAD:refs/heads/${this.branch}`,
    ]);

    await assertLease?.();
    const prUrl = lastNonEmptyLine(
      await this.#run("gh", [
        "pr",
        "create",
        "--repo",
        this.repository,
        "--base",
        this.repositoryConfig.defaultBranch,
        "--head",
        this.branch,
        "--title",
        this.item.title,
        "--body",
        [
          `Source task: ${this.item.url}`,
          "",
          result.summary || "Completed by a PAN runner.",
        ].join("\n"),
      ]),
    );
    if (!/^https:\/\/github\.com\/.+\/pull\/\d+$/.test(prUrl)) {
      throw new Error(`gh pr create returned an invalid PR URL: ${prUrl}`);
    }

    try {
      await this.#run("git", [
        "-C",
        this.repositoryConfig.path,
        "worktree",
        "remove",
        this.worktreePath,
      ]);
    } catch {
      // The PR is the durable handoff; local cleanup can be retried manually.
    }
    return { prUrl };
  }

  locator(localUrl) {
    return {
      machine: this.profile.machine,
      terminalTitle: this.title,
      ...(localUrl ? { localUrl } : {}),
    };
  }

  async #run(executable, args) {
    return this.commands.run(executable, args, {
      timeout: remainingMilliseconds(this.deadline),
    });
  }
}

async function launchTerminal({
  executable,
  window,
  title,
  workerPath,
  contextPath,
  spawnProcess,
}) {
  const child = spawnProcess(
    executable,
    [
      "-w",
      window,
      "nt",
      "--title",
      title,
      "--suppressApplicationTitle",
      process.execPath,
      workerPath,
      "--context",
      contextPath,
    ],
    {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    },
  );
  await new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  child.unref();
}

async function readJsonIfReady(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) {
      return undefined;
    }
    throw error;
  }
}

function normalizeNeedsHuman(record, handle) {
  if (!record || typeof record !== "object") {
    throw new TypeError("needs-human record must be an object");
  }
  if (!["question", "approval", "local-ui"].includes(record.kind)) {
    throw new TypeError("needs-human kind must be question, approval, or local-ui");
  }
  if (typeof record.prompt !== "string" || !record.prompt.trim()) {
    throw new TypeError("needs-human prompt is required");
  }
  return {
    kind: record.kind,
    prompt: record.prompt,
    locator: handle.locator(record.localUrl),
  };
}

function normalizeResult(result) {
  if (!result || typeof result !== "object") {
    throw new TypeError("task result must be an object");
  }
  if (!["completed", "blocked", "failed"].includes(result.status)) {
    throw new TypeError("task result status must be completed, blocked, or failed");
  }
  return {
    ...result,
    summary:
      typeof result.summary === "string" && result.summary.trim()
        ? result.summary.trim()
        : "The daemon did not provide a summary.",
  };
}

function terminalTitle(item) {
  return truncate(`PAN #${item.number} - ${item.title}`, 80);
}

function slugify(value) {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 35);
  return slug || "task";
}

function allocationToken(value) {
  const token = String(value).toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 12);
  if (!token) {
    throw new TypeError("task allocation ID must contain letters or numbers");
  }
  return token;
}

function truncate(value, length) {
  return value.length > length ? `${value.slice(0, length - 3)}...` : value;
}

function lastNonEmptyLine(value) {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
}

function remainingMilliseconds(deadline, now = Date.now) {
  if (deadline === undefined) {
    return undefined;
  }
  const remaining = deadline - now();
  if (remaining <= 0) {
    throw new Error("Task wall-clock budget expired");
  }
  return remaining;
}

export { resolveWorkstreamReadme };

export function normalizeGitHubRepositoryUrl(remote) {
  const scp = /^git@github\.com:(.+?)(?:\.git)?$/i.exec(remote.trim());
  if (scp) {
    return trimRepositoryPath(scp[1]);
  }
  try {
    const url = new URL(remote);
    if (url.hostname.toLowerCase() !== "github.com") {
      return undefined;
    }
    return trimRepositoryPath(url.pathname);
  } catch {
    return undefined;
  }
}

function trimRepositoryPath(value) {
  const repository = value.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
  return /^[^/]+\/[^/]+$/.test(repository) ? repository : undefined;
}
