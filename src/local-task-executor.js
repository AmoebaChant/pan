import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { normalizeGitHubRepositoryUrl } from "./github-repository.js";
export { normalizeGitHubRepositoryUrl } from "./github-repository.js";
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
    sessionIdFactory = randomUUID,
    launchIdFactory = randomUUID,
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
    this.sessionIdFactory = sessionIdFactory;
    this.launchIdFactory = launchIdFactory;
    this.workerIsAlive = workerIsAlive;
    this.terminateWorker = terminateWorker;
    this.logger = logger;
  }

  async start({
    item,
    repository,
    runner,
    playbook,
    deadline,
    resumeAffinity,
    onResume,
  }) {
    const repositoryConfig = this.profile.repositories[repository];
    if (!repositoryConfig) {
      throw new Error(`Runner cannot service repository ${repository}`);
    }
    const selectedPlaybook = playbook ?? {
      id: "legacy",
      instructions: [],
    };
    const workingDirectory = selectedPlaybook.workingDirectory;
    const agentManaged = Boolean(workingDirectory);

    await mkdir(this.profile.workspaceRoot, { recursive: true });
    await mkdir(this.profile.stateDirectory, { recursive: true });
    const resumePath = taskResumePath(this.profile.stateDirectory, item.id);
    const resumed = await this.#resumeTask({
      item,
      repository,
      repositoryConfig,
      runner,
      playbook: selectedPlaybook,
      deadline,
      resumePath,
      resumeAffinity,
      onResume,
    });
    if (resumed) {
      return resumed;
    }

    const allocation = await this.#allocateTask(item);
    const { taskName, branch, worktreePath, statePath } = allocation;
    if (!agentManaged && branch === repositoryConfig.defaultBranch) {
      throw new Error("Task branch must not be the default branch");
    }

    let worktreeCreated = false;
    try {
      const remotes = agentManaged
        ? undefined
        : await this.#readRepositoryRemotes(
            deadline,
            repository,
            repositoryConfig,
          );
      if (!agentManaged) {
        await this.#run(deadline, "git", [
          "-C",
          repositoryConfig.path,
          "fetch",
          remotes.base.name,
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
          `${remotes.base.name}/${repositoryConfig.defaultBranch}`,
        ]);
        worktreeCreated = true;
      }
      const baseCommit = agentManaged
        ? undefined
        : await this.#run(deadline, "git", [
            "-C",
            worktreePath,
            "rev-parse",
            "HEAD",
          ]);

      const workstreamPath = await resolveConfinedWorkstreamReadme(
        this.profile.store.path,
        item.fields.workstream,
      );
      const workstream = await readFile(workstreamPath, "utf8");
      const launchId = this.launchIdFactory();
      const paths = taskStatePaths(statePath, launchId);
      const sessionId = this.sessionIdFactory();
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
        target: agentManaged
          ? {
              repository,
              workingDirectory,
            }
          : {
              repository,
              defaultBranch: repositoryConfig.defaultBranch,
              baseRemote: remotes.base.name,
              baseRemoteUrl: remotes.base.url,
              baseRemotePushUrl: remotes.base.pushUrl,
              pushRemote: remotes.push.name,
              pushRemoteUrl: remotes.push.url,
              pushRemotePushUrl: remotes.push.pushUrl,
              pushRepository: remotes.push.pushRepository,
              baseCommit,
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
        paths,
        copilot: {
          executable: this.profile.copilot.executable,
          model: this.profile.copilot.model,
          approvalMode: this.profile.copilot.approvalMode,
          ...this.profile.taskBudget,
          deadline,
          sessionId,
          resume: false,
        },
      };
      const contextPath = taskContextPath(statePath, launchId);
      await writeTaskContext(statePath, contextPath, context);
      await writeResumePointer(resumePath, {
        statePath,
        contextPath,
        sessionId,
        itemId: item.id,
        issueNumber: item.number,
        runner,
        target: context.target,
        launchPaths: {
          worker: paths.worker,
          cancel: paths.cancel,
        },
        resumeAffinity,
        requeue: false,
        savedAt: this.now().toISOString(),
      });

      const title = terminalTitle(item);
      await onResume?.({
        event: "started",
        runner,
        machine: this.profile.machine,
        playbook: selectedPlaybook.id,
        repository,
        branch: agentManaged ? undefined : branch,
        worktreePath: agentManaged ? workingDirectory : worktreePath,
        terminalTitle: title,
        resumed: false,
      });
      await launchTerminal({
        executable: this.profile.terminal.executable,
        window: this.profile.terminal.window,
        profile: this.profile.terminal.profile,
        title,
        workerPath: WORKER_PATH,
        contextPath,
        spawnProcess: this.spawnProcess,
      });

      return this.#createHandle({
        item,
        repository,
        repositoryConfig,
        runner,
        agentManaged,
        expectedRemotes: remotes,
        baseCommit,
        profile: this.profile,
        commands: this.commands,
        sleep: this.sleep,
        title,
        branch: agentManaged ? undefined : branch,
        worktreePath: agentManaged ? workingDirectory : worktreePath,
        statePath,
        paths,
        deadline,
        resumePath,
        sessionId,
        contextPath,
        resumeAffinity,
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
      try {
        await rm(resumePath, { force: true });
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

  async #resumeTask({
    item,
    repository,
    repositoryConfig,
    runner,
    playbook,
    deadline,
    resumePath,
    resumeAffinity,
    onResume,
  }) {
    const agentManaged = Boolean(playbook.workingDirectory);
    const workingDirectory = playbook.workingDirectory;
    const pointer = await readJsonIfReady(resumePath);
    if (!pointer) {
      return undefined;
    }
    if (
      pointer.version !== 1 ||
      typeof pointer.statePath !== "string" ||
      typeof pointer.contextPath !== "string" ||
      typeof pointer.sessionId !== "string" ||
      !validSavedTarget(pointer.target, { agentManaged }) ||
      !pointer.launchPaths
    ) {
      throw new Error(`Saved task state is invalid for issue ${item.number}`);
    }
    const statePath = confinedStatePath(
      this.profile.stateDirectory,
      pointer.statePath,
    );
    const previousContextPath = confinedChildPath(
      statePath,
      pointer.contextPath,
    );
    const previous = await readJsonIfReady(previousContextPath);
    if (
      !previous ||
      previous.issue?.number !== item.number ||
      previous.issue?.repository !== item.repository ||
      pointer.itemId !== item.id ||
      previous.target?.repository !== repository ||
      previous.playbook?.id !== playbook.id ||
      previous.copilot?.sessionId !== pointer.sessionId
    ) {
      throw new Error(`Saved task context does not match issue ${item.number}`);
    }

    const remotes = agentManaged
      ? undefined
      : await this.#readRepositoryRemotes(
          deadline,
          repository,
          repositoryConfig,
        );
    if (!agentManaged) {
      if (
        (pointer.target.baseRemote ?? "origin") !== remotes.base.name ||
        (pointer.target.pushRemote ?? "origin") !== remotes.push.name ||
        pointer.target.baseRemoteUrl !== remotes.base.url ||
        pointer.target.baseRemotePushUrl !== remotes.base.pushUrl ||
        pointer.target.pushRemoteUrl !== remotes.push.url ||
        pointer.target.pushRemotePushUrl !== remotes.push.pushUrl ||
        pointer.target.pushRepository?.toLowerCase() !==
          remotes.push.pushRepository.toLowerCase()
      ) {
        throw new Error(
          `Runner remote configuration changed while issue ${item.number} was resumable`,
        );
      }
      for (const remote of [remotes.base, remotes.push]) {
        const savedWorktreeRemote = await this.#run(deadline, "git", [
          "-C",
          pointer.target.worktreePath,
          "remote",
          "get-url",
          remote.name,
        ]);
        if (savedWorktreeRemote !== remote.url) {
          throw new Error(
            `Saved task worktree has an unexpected ${remote.name} URL`,
          );
        }
        const savedWorktreePushRemote = await this.#run(deadline, "git", [
          "-C",
          pointer.target.worktreePath,
          "remote",
          "get-url",
          "--push",
          remote.name,
        ]);
        if (savedWorktreePushRemote !== remote.pushUrl) {
          throw new Error(
            `Saved task worktree has an unexpected ${remote.name} push URL`,
          );
        }
      }
    } else if (pointer.target.workingDirectory !== workingDirectory) {
      throw new Error(
        `Playbook working directory changed while issue ${item.number} was resumable`,
      );
    }
    await this.#stopPreviousLaunch(statePath, pointer.launchPaths);

    const workstreamPath = await resolveConfinedWorkstreamReadme(
      this.profile.store.path,
      item.fields.workstream,
    );
    const launchId = this.launchIdFactory();
    const paths = taskStatePaths(statePath, launchId);
    const context = {
      ...previous,
      runner,
      issue: {
        number: item.number,
        title: item.title,
        body: item.body,
        url: item.url,
        repository: item.repository,
        comments: item.comments ?? [],
      },
      target: agentManaged
        ? { ...pointer.target }
        : {
            ...pointer.target,
            baseRemote: remotes.base.name,
            baseRemoteUrl: remotes.base.url,
            baseRemotePushUrl: remotes.base.pushUrl,
            pushRemote: remotes.push.name,
            pushRemoteUrl: remotes.push.url,
            pushRemotePushUrl: remotes.push.pushUrl,
            pushRepository: remotes.push.pushRepository,
          },
      playbook: {
        id: playbook.id,
        instructions: playbook.instructions,
      },
      workstream: {
        path: item.fields.workstream,
        sourcePath: workstreamPath,
        content: await readFile(workstreamPath, "utf8"),
      },
      needsHumanSince: item.fields.needsHumanSince ?? "",
      paths,
      copilot: {
        executable: this.profile.copilot.executable,
        model: this.profile.copilot.model,
        approvalMode: this.profile.copilot.approvalMode,
        ...this.profile.taskBudget,
        deadline,
        sessionId: pointer.sessionId,
        resume: true,
        resumeWithSessionId: true,
      },
    };
    const contextPath = taskContextPath(statePath, launchId);
    await writeTaskContext(statePath, contextPath, context);
    await writeResumePointer(resumePath, {
      statePath,
      contextPath,
      sessionId: pointer.sessionId,
      itemId: item.id,
      issueNumber: item.number,
      runner,
      target: context.target,
      launchPaths: {
        worker: paths.worker,
        cancel: paths.cancel,
      },
      resumeAffinity,
      requeue: false,
      savedAt: this.now().toISOString(),
    });

    const title = terminalTitle(item);
    await onResume?.({
      event: "started",
      runner,
      machine: this.profile.machine,
      playbook: playbook.id,
      repository,
      branch: pointer.target.branch,
      worktreePath: agentManaged
        ? pointer.target.workingDirectory
        : pointer.target.worktreePath,
      terminalTitle: title,
      resumed: true,
    });
    await launchTerminal({
      executable: this.profile.terminal.executable,
      window: this.profile.terminal.window,
      profile: this.profile.terminal.profile,
      title,
      workerPath: WORKER_PATH,
      contextPath,
      spawnProcess: this.spawnProcess,
    });

    return this.#createHandle({
      item,
      repository,
      repositoryConfig,
      runner,
      agentManaged,
      expectedRemotes: remotes,
      baseCommit: pointer.target.baseCommit,
      title,
      branch: pointer.target.branch,
      worktreePath: agentManaged
        ? pointer.target.workingDirectory
        : pointer.target.worktreePath,
      statePath,
      paths,
      deadline,
      resumePath,
      sessionId: pointer.sessionId,
      contextPath,
      resumeAffinity,
    });
  }

  async #stopPreviousLaunch(statePath, launchPaths) {
    const cancelPath = confinedChildPath(statePath, launchPaths.cancel);
    const workerPath = confinedChildPath(statePath, launchPaths.worker);
    await writeJsonAtomic(cancelPath, {
      status: "interrupted",
      summary: "A new runner launch superseded this task process.",
    });
    const worker = await readJsonIfReady(workerPath);
    if (
      !Number.isInteger(worker?.pid) ||
      worker.pid <= 0 ||
      !this.workerIsAlive(worker.pid)
    ) {
      await rm(workerPath, { force: true });
      return;
    }
    for (let attempt = 0; attempt < 50; attempt += 1) {
      await this.sleep(100);
      if (!this.workerIsAlive(worker.pid)) {
        await rm(workerPath, { force: true });
        return;
      }
    }
    throw new Error(
      `Previous task worker ${worker.pid} is still active; refusing to start a duplicate.`,
    );
  }

  async listInterruptedTasks() {
    let entries;
    try {
      entries = await readdir(this.profile.stateDirectory);
    } catch (error) {
      if (error.code === "ENOENT") {
        return [];
      }
      throw error;
    }
    const tasks = [];
    for (const entry of entries) {
      if (!/^resume-[a-f0-9]+\.json$/.test(entry)) {
        continue;
      }
      const resumePath = path.join(this.profile.stateDirectory, entry);
      const pointer = await readJsonIfReady(resumePath);
      if (
        pointer?.requeue === true &&
        pointer.itemId &&
        typeof pointer.runner === "string"
      ) {
        tasks.push({
          resumePath,
          itemId: pointer.itemId,
          runner: pointer.runner,
          resumeAffinity: pointer.resumeAffinity,
          issueNumber: pointer.issueNumber,
        });
      }
    }
    return tasks;
  }

  async markInterruptedRequeued(task) {
    await markResumePointerRequeued(task.resumePath, this.now().toISOString());
  }

  #createHandle({
    item,
    repository,
    repositoryConfig,
    runner,
    agentManaged,
    expectedRemotes,
    baseCommit,
    title,
    branch,
    worktreePath,
    statePath,
    paths,
    deadline,
    resumePath,
    sessionId,
    contextPath,
    resumeAffinity,
  }) {
    return new LocalTaskHandle({
      item,
      repository,
      repositoryConfig,
      runner,
      agentManaged,
      expectedRemotes,
      baseCommit,
      profile: this.profile,
      commands: this.commands,
      sleep: this.sleep,
      title,
      branch,
      worktreePath,
      statePath,
      resultPath: paths.result,
      needsHumanPath: paths.needsHuman,
      workerPath: paths.worker,
      cancelPath: paths.cancel,
      workerStartDeadline:
        this.now().getTime() + WORKER_START_GRACE_MS,
      workerIsAlive: this.workerIsAlive,
      terminateWorker: this.terminateWorker,
      logger: this.logger,
      now: () => this.now().getTime(),
      deadline,
      resumePath,
      sessionId,
      contextPath,
      resumeAffinity,
    });
  }

  async #run(deadline, executable, args) {
    return this.commands.run(executable, args, {
      timeout: remainingMilliseconds(
        deadline,
        () => this.now().getTime(),
      ),
    });
  }

  async #readRepositoryRemotes(deadline, repository, repositoryConfig) {
    const baseName = repositoryConfig.baseRemote ?? "origin";
    const pushName = repositoryConfig.pushRemote ?? "origin";
    const readRemote = async (name) => {
      const readSingleUrl = async (kind, args) => {
        const output = await this.#run(deadline, "git", [
          "-C",
          repositoryConfig.path,
          "remote",
          "get-url",
          ...args,
          "--all",
          name,
        ]);
        const urls = output.split(/\r?\n/).filter(Boolean);
        if (urls.length !== 1) {
          throw new Error(
            `Configured path remote ${name} must have exactly one ${kind} URL`,
          );
        }
        return urls[0];
      };
      const url = await readSingleUrl("fetch", []);
      const pushUrl = await readSingleUrl("push", ["--push"]);
      const fetchRepository = normalizeGitHubRepositoryUrl(url);
      const pushRepository = normalizeGitHubRepositoryUrl(pushUrl);
      if (!fetchRepository || !pushRepository) {
        throw new Error(
          `Configured path remote ${name} is not a GitHub repository`,
        );
      }
      return { name, url, pushUrl, fetchRepository, pushRepository };
    };
    const base = await readRemote(baseName);
    if (base.fetchRepository.toLowerCase() !== repository.toLowerCase()) {
      throw new Error(
        `Configured path base remote ${baseName} is ${base.fetchRepository}, expected ${repository}`,
      );
    }
    const push = pushName === baseName ? base : await readRemote(pushName);
    return { base, push };
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
    this.attentionSince = undefined;
    this.cancellation = new Promise((resolve) => {
      this.resolveCancellation = resolve;
    });
  }

  async wait({ onNeedsHuman, onAttentionCleared } = {}) {
    while (
      this.deadline === undefined ||
      this.attentionSince !== undefined ||
      this.now() < this.deadline + 60_000
    ) {
      if (this.cancelledResult) {
        return this.cancelledResult;
      }
      const needsHuman = await readJsonIfReady(this.needsHumanPath);
      const serialized = needsHuman ? JSON.stringify(needsHuman) : undefined;
      if (needsHuman && serialized !== this.lastNeedsHuman) {
        this.lastNeedsHuman = serialized;
        this.attentionSince ??= this.now();
        await onNeedsHuman?.(normalizeNeedsHuman(needsHuman, this));
      } else if (!needsHuman && this.lastNeedsHuman !== undefined) {
        this.lastNeedsHuman = undefined;
        if (this.attentionSince !== undefined) {
          if (this.deadline !== undefined) {
            this.deadline += this.now() - this.attentionSince;
          }
          this.attentionSince = undefined;
        }
        await onAttentionCleared?.();
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
    return this.#stop({
      status: "failed",
      summary,
      ...details,
    });
  }

  async interrupt(summary = "The runner was stopped.") {
    await this.markPendingRequeue();
    return this.#stop({
      status: "interrupted",
      summary,
    });
  }

  async clearResumeState() {
    await rm(this.resumePath, { force: true });
  }

  async markRequeued() {
    await markResumePointerRequeued(
      this.resumePath,
      new Date(this.now()).toISOString(),
    );
  }

  async markPendingRequeue() {
    await writeResumePointer(this.resumePath, {
      statePath: this.statePath,
      contextPath: this.contextPath,
      sessionId: this.sessionId,
      itemId: this.item.id,
      issueNumber: this.item.number,
      runner: this.runner,
      target: {
        repository: this.repository,
        defaultBranch: this.repositoryConfig.defaultBranch,
        baseRemote: this.expectedRemotes.base.name,
        baseRemoteUrl: this.expectedRemotes.base.url,
        baseRemotePushUrl: this.expectedRemotes.base.pushUrl,
        pushRemote: this.expectedRemotes.push.name,
        pushRemoteUrl: this.expectedRemotes.push.url,
        pushRemotePushUrl: this.expectedRemotes.push.pushUrl,
        pushRepository: this.expectedRemotes.push.pushRepository,
        baseCommit: this.baseCommit,
        branch: this.branch,
        worktreePath: this.worktreePath,
      },
      launchPaths: {
        worker: this.workerPath,
        cancel: this.cancelPath,
      },
      resumeAffinity: this.resumeAffinity,
      requeue: true,
      savedAt: new Date(this.now()).toISOString(),
    });
  }

  async setResumeAffinity(resumeAffinity) {
    this.resumeAffinity = resumeAffinity;
    const pointer = await readJsonIfReady(this.resumePath);
    if (!pointer) {
      return;
    }
    await writeResumePointer(this.resumePath, {
      ...pointer,
      resumeAffinity,
    });
  }

  async #stop(result) {
    if (this.cancelPromise) {
      return this.cancelPromise;
    }
    this.cancelledResult = result;
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
        await rm(this.workerPath, { force: true });
      } finally {
        this.resolveCancellation(this.cancelledResult);
      }
    })();
    return this.cancelPromise;
  }

  async complete(result, { assertLease } = {}) {
    try {
      await assertLease?.();
      const outcome = normalizeOutcome(result);
      if (this.agentManaged) {
        await this.clearResumeState();
        return outcome;
      }
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
        throw new Error("Task reported completion with uncommitted changes");
      }

      await this.#run("git", [
        "-C",
        this.worktreePath,
        "merge-base",
        "--is-ancestor",
        this.baseCommit,
        "HEAD",
      ]);
      await assertLease?.();
      for (const remote of [
        this.expectedRemotes.base,
        this.expectedRemotes.push,
      ]) {
        const currentRemote = await this.#run("git", [
          "-C",
          this.repositoryConfig.path,
          "remote",
          "get-url",
          "--all",
          remote.name,
        ]);
        if (currentRemote !== remote.url) {
          throw new Error(
            `The task changed the repository ${remote.name} URL`,
          );
        }
        const currentPushRemote = await this.#run("git", [
          "-C",
          this.repositoryConfig.path,
          "remote",
          "get-url",
          "--push",
          "--all",
          remote.name,
        ]);
        if (currentPushRemote !== remote.pushUrl) {
          throw new Error(
            `The task changed the repository ${remote.name} push URL`,
          );
        }
      }

      await this.clearResumeState();
      await this.#cleanupDeliveredWorktree();
      return outcome;
    } catch (error) {
      if (error.code !== "PAN_LEASE_LOST") {
        error.code = "PAN_DELIVERY_INCOMPLETE";
      }
      throw error;
    }
  }

  locator(localUrl) {
    return {
      machine: this.profile.machine,
      runner: this.runner,
      branch: this.branch,
      worktree: this.worktreePath,
      terminalTitle: this.title,
      ...(localUrl ? { localUrl } : {}),
    };
  }

  async #run(executable, args) {
    return this.commands.run(executable, args, {
      timeout: remainingMilliseconds(this.deadline),
    });
  }

  async #cleanupDeliveredWorktree() {
    try {
      await this.#run("git", [
        "-C",
        this.repositoryConfig.path,
        "worktree",
        "remove",
        this.worktreePath,
      ]);
    } catch (error) {
      this.logger.warn?.(
        `Delivery completed, but local cleanup failed for ${this.worktreePath}.`,
        error,
      );
    }
  }
}

async function launchTerminal({
  executable,
  window,
  profile,
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
      ...(profile ? ["-p", profile] : []),
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

async function writeJsonAtomic(filePath, value) {
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await rename(temporary, filePath);
        return;
      } catch (error) {
        if (!["EEXIST", "EPERM"].includes(error.code) || attempt === 2) {
          throw error;
        }
        await rm(filePath, { force: true });
      }
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

async function writeTaskContext(statePath, contextPath, context) {
  await Promise.all([
    writeJsonAtomic(path.join(statePath, "context.json"), context),
    writeJsonAtomic(contextPath, context),
  ]);
}

async function writeResumePointer(resumePath, value) {
  await writeJsonAtomic(resumePath, {
    version: 1,
    ...value,
  });
}

async function markResumePointerRequeued(resumePath, requeuedAt) {
  const pointer = await readJsonIfReady(resumePath);
  if (!pointer) {
    return;
  }
  await writeResumePointer(resumePath, {
    ...pointer,
    requeue: false,
    requeuedAt,
  });
}

function taskStatePaths(statePath, launchId) {
  return {
    statePath,
    agentResult: path.join(statePath, `agent-result-${launchId}.json`),
    result: path.join(statePath, `result-${launchId}.json`),
    needsHuman: path.join(statePath, `needs-human-${launchId}.json`),
    log: path.join(statePath, "copilot.log"),
    worker: path.join(statePath, `worker-${launchId}.json`),
    cancel: path.join(statePath, `cancel-${launchId}.json`),
  };
}

function taskContextPath(statePath, launchId) {
  return path.join(statePath, `context-${launchId}.json`);
}

function taskResumePath(stateDirectory, itemId) {
  const key = createHash("sha256").update(String(itemId)).digest("hex").slice(0, 24);
  return path.join(stateDirectory, `resume-${key}.json`);
}

function confinedStatePath(stateDirectory, savedPath) {
  const root = path.resolve(stateDirectory);
  const resolved = path.resolve(savedPath);
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Saved task state path is outside the runner state directory");
  }
  return resolved;
}

function confinedChildPath(parentPath, savedPath) {
  const parent = path.resolve(parentPath);
  const resolved = path.resolve(savedPath);
  const relative = path.relative(parent, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Saved task context is outside its state directory");
  }
  return resolved;
}

function validSavedTarget(target, { agentManaged = false } = {}) {
  if (!target || typeof target !== "object") {
    return false;
  }
  if (agentManaged) {
    return (
      typeof target.repository === "string" &&
      typeof target.workingDirectory === "string"
    );
  }
  return (
    typeof target.repository === "string" &&
    typeof target.defaultBranch === "string" &&
    typeof target.baseCommit === "string" &&
    typeof target.branch === "string" &&
    typeof target.worktreePath === "string"
  );
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

function normalizeOutcome(result) {
  const outcome = result.outcome ?? "needs-review";
  if (!["done", "needs-review"].includes(outcome)) {
    throw new TypeError(
      'completed task result outcome must be "done" or "needs-review"',
    );
  }
  if (result.details !== undefined && typeof result.details !== "string") {
    throw new TypeError("completed task result details must be a string");
  }
  if (result.url !== undefined && !isAbsoluteUrl(result.url)) {
    throw new TypeError("completed task result URL must be an absolute URL");
  }
  return {
    outcome,
    ...(result.details?.trim() ? { details: result.details.trim() } : {}),
    ...(result.url ? { url: result.url } : {}),
  };
}

function terminalTitle(item) {
  return truncate(`Pan #${item.number} - ${item.title}`, 80);
}

function isAbsoluteUrl(value) {
  if (typeof value !== "string") {
    return false;
  }
  try {
    return Boolean(new URL(value).protocol);
  } catch {
    return false;
  }
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
