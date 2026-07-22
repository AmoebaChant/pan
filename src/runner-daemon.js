import {
  formatNeedsHuman,
  formatNeedsHumanResolved,
  latestNeedsHuman,
} from "./needs-human.js";
import {
  matchingPlaybook,
  normalizePlaybooks,
  taskRepository,
} from "./playbook.js";
import {
  isRateLimitError,
  nextPollDelaySeconds,
  rateLimitBackoffSeconds,
  waitForNextPoll,
} from "./polling.js";

export class RunnerDaemon {
  constructor({
    store,
    profile,
    executor,
    now = () => new Date(),
    sleep = (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
    logger = console,
  }) {
    this.store = store;
    this.profile = profile.playbooks
      ? profile
      : { ...profile, playbooks: normalizePlaybooks(profile) };
    this.executor = executor;
    this.now = now;
    this.sleep = sleep;
    this.logger = logger;
    this.active = new Map();
  }

  async runOnce({ signal } = {}) {
    this.logger.info?.("Running one polling cycle.");
    await this.tick({ signal });
    await Promise.all(
      [...this.active.values()].map((entry) => entry.promise),
    );
  }

  async run({ signal } = {}) {
    this.logger.info?.("Polling for ready tasks; press Ctrl+C to stop.");
    let idlePolls = 0;
    while (!signal?.aborted) {
      let started = 0;
      let rateLimited = false;
      try {
        started = await this.tick({ signal });
      } catch (error) {
        this.logger.error("PAN runner poll failed", error);
        rateLimited = isRateLimitError(error);
      }
      idlePolls = started > 0 || this.active.size > 0 ? 0 : idlePolls + 1;
      const delaySeconds = rateLimited
        ? rateLimitBackoffSeconds()
        : nextPollDelaySeconds(this.profile.pollIntervalSeconds, idlePolls);
      await waitForNextPoll({
        sleep: this.sleep,
        milliseconds: delaySeconds * 1_000,
        signal,
      });
    }
    await Promise.all(
      [...this.active.values()].map((entry) => entry.promise),
    );
    this.logger.info?.("All active tasks have stopped.");
  }

  async tick({ signal } = {}) {
    if (!this.profile.online) {
      this.logger.info?.("Runner is offline; skipping poll.");
      return 0;
    }
    await this.#recoverLegacyRunnerStops();
    await this.#recoverInterruptedTasks();
    const freeSlots =
      this.profile.maxConcurrentDaemons - this.active.size;
    if (freeSlots <= 0) {
      this.logger.info?.(
        `Capacity full (${this.active.size}/${this.profile.maxConcurrentDaemons}); skipping poll.`,
      );
      return 0;
    }

    const items = await this.store.listByFilter({
      owner: "agent",
      status: "ready",
      claimable: true,
    });
    const candidates = items.filter((item) => isRunnable(item));
    this.logger.info?.(
      `Poll found ${items.length} ready item(s), ${candidates.length} runnable; active=${this.active.size}, free=${freeSlots}.`,
    );
    const activeCounts = this.#activePlaybookCounts();

    let started = 0;
    for (const item of candidates) {
      if (started >= freeSlots) {
        break;
      }
      const affinity = resumableAffinity(item.fields.claimedBy);
      const eligibleProfile = affinity
        ? {
            ...this.profile,
            playbooks: this.profile.playbooks.filter(
              (candidate) =>
                runnerResumeAffinity(this.profile.id, candidate.id) === affinity,
            ),
          }
        : this.profile;
      const playbook = matchingPlaybook(item, eligibleProfile, activeCounts);
      if (!playbook) {
        this.logger.info?.(
          `Skipping task #${item.number}: no compatible playbook with free capacity.`,
        );
        continue;
      }
      const slot = this.#nextPlaybookSlot(playbook);
      const runner = playbook.legacy
        ? `${this.profile.id}/slot-${slot}`
        : `${this.profile.id}/${playbook.id}/slot-${slot}`;
      let claim;
      try {
        this.logger.info?.(
          `Claiming task #${item.number} with playbook ${playbook.id} slot ${slot}/${playbook.capacity}.`,
        );
        claim = await this.store.claimWithLease({
          itemId: item.id,
          runner,
          assignee: this.profile.githubAssignee,
          leaseUntil: this.#leaseUntil(),
        });
      } catch (error) {
        if (isRateLimitError(error)) {
          throw error;
        }
        this.logger.error(`Unable to claim PAN task #${item.number}`, error);
        continue;
      }
      if (!claim.claimed) {
        this.logger.info?.(
          `Task #${item.number} was claimed by another runner.`,
        );
        continue;
      }
      this.logger.info?.(
        `Claimed task #${item.number} as ${runner}.`,
      );

      const promise = this.#runClaim(claim.item, runner, playbook, signal)
        .catch((error) => {
          this.logger.error(`PAN task #${item.number} failed`, error);
        })
        .finally(() => {
          this.active.delete(runner);
          this.logger.info?.(
            `Released local capacity for task #${item.number}; active=${this.active.size}.`,
          );
        });
      this.active.set(runner, { playbookId: playbook.id, slot, promise });
      activeCounts.set(
        playbook.id,
        (activeCounts.get(playbook.id) ?? 0) + 1,
      );
      started += 1;
    }
    return started;
  }

  async #runClaim(item, runner, playbook, signal) {
    const repository = repositoryFor(item);
    const deadline = this.profile.taskBudget?.wallClockMinutes
      ? this.now().getTime() +
        this.profile.taskBudget.wallClockMinutes * 60_000
      : undefined;
    let handle;
    const heartbeat = startHeartbeat({
      store: this.store,
      item,
      runner,
      leaseUntil: () => this.#leaseUntil(),
      intervalMilliseconds: this.profile.heartbeatSeconds * 1_000,
      logger: this.logger,
    });
    let delivery;
    let result;
    try {
      const comments = await this.store.listComments(item);
      this.logger.info?.(
        `Launching task #${item.number} for ${repository}; model=${this.profile.copilot?.model ?? "auto"}, wall-clock=${deadline ? `${this.profile.taskBudget.wallClockMinutes}m` : "unlimited"}, AI credits=${this.profile.taskBudget?.maxAiCredits ?? "unlimited"}.`,
      );
      handle = await this.executor.start({
        item: { ...item, comments },
        repository,
        runner,
        playbook,
        deadline,
        resumeAffinity: runnerResumeAffinity(this.profile.id, playbook.id),
        onResume: async (record) => {
          try {
            await retry(() =>
              this.store.addComment(item, agentStartedComment(record)),
            );
          } catch (error) {
            this.logger.error(
              `Unable to record agent start for PAN task #${item.number}`,
              error,
            );
          }
        },
      });
      result = await waitForTask({
        handle,
        heartbeat,
        signal,
        onNeedsHuman: async (record) => {
          try {
            await retry(() =>
              this.store.addComment(item, formatNeedsHuman(record)),
            );
          } catch (error) {
            this.logger.error(
              `Unable to record agent question for PAN task #${item.number}`,
              error,
            );
          }
        },
      });
      this.logger.info?.(
        `Task #${item.number} worker reported ${result.status}: ${result.summary}`,
      );

      if (result.status === "completed") {
        await heartbeat.renewNow();
        delivery = await handle.complete(result, {
          assertLease: heartbeat.renewNow,
        });
        this.logger.info?.(
          `Task #${item.number} delivered via ${delivery.mode}: ${delivery.url}.`,
        );
        if (delivery.mode === "direct") {
          await retry(() =>
            this.store.addComment(item, completedComment(delivery, result)),
          );
        }
        await heartbeat.renewNow();
        const completedStatus =
          delivery.mode === "direct" ? "done" : "in-review";
        const release = await retry(() =>
          this.store.release({
            itemId: item.id,
            runner,
            assignee: this.profile.githubAssignee,
            status: completedStatus,
          }),
        );
        if (!release.released) {
          throw new Error(`Unable to release completed task: ${release.reason}`);
        }
        this.logger.info?.(
          `Task #${item.number} moved to ${completedStatus} and its lease was released.`,
        );
        if (delivery.mode === "pull-request") {
          try {
            await retry(() =>
              this.store.addComment(item, completedComment(delivery, result)),
            );
          } catch (commentError) {
            this.logger.error(
              `Unable to comment on completed PAN task #${item.number}`,
              commentError,
            );
          }
        }
        return;
      }

      if (result.status === "interrupted") {
        await this.#requeueOperationalStop({
          item,
          runner,
          playbook,
          handle,
          heartbeat,
          summary: result.summary,
        });
        return;
      }

      if (result.status === "failed" && !result.budgetExceeded) {
        await this.#requeueOperationalStop({
          item,
          runner,
          playbook,
          handle,
          heartbeat,
          summary: result.summary,
        });
        return;
      }

      await handle.clearResumeState?.();
      const record = {
        kind: result.budgetExceeded ? "approval" : "question",
        prompt: result.summary,
        locator: handle.locator(result.localUrl),
      };
      await heartbeat.renewNow();
      await this.store.addComment(item, formatNeedsHuman(record));
      await heartbeat.renewNow();
      const release = await this.store.release({
        itemId: item.id,
        runner,
        assignee: this.profile.githubAssignee,
        status: "blocked",
      });
      if (!release.released) {
        throw new Error(`Unable to release blocked task: ${release.reason}`);
      }
      this.logger.info?.(
        `Task #${item.number} moved to blocked and its lease was released.`,
      );
    } catch (error) {
      if (error.code === "PAN_LEASE_LOST") {
        await handle?.clearResumeState?.();
        this.logger.warn?.(
          `Stopped task #${item.number} after losing its lease.`,
        );
        return;
      }
      if (error.code === "PAN_INTERRUPTED_REQUEUE_FAILED") {
        this.logger.warn?.(
          `Task #${item.number} remains resumable and will be requeued on the next runner poll.`,
          error,
        );
        return;
      }
      if (error.code === "PAN_DELIVERY_INCOMPLETE") {
        await this.#requeueOperationalStop({
          item,
          runner,
          playbook,
          handle,
          heartbeat,
          summary: `Delivery incomplete: ${error.message}`,
        });
        return;
      }
      if (result?.status === "blocked") {
        await handle?.clearResumeState?.();
      }
      try {
        await heartbeat.renewNow();
      } catch (leaseError) {
        if (leaseError.code === "PAN_LEASE_LOST") {
          this.logger.warn?.(
            `Suppressed failure updates for task #${item.number} after losing its lease.`,
          );
          return;
        }
        throw new AggregateError(
          [error, leaseError],
          `Task #${item.number} failed and its lease could not be confirmed`,
        );
      }
      const locator = handle
        ? handle.locator()
        : { machine: this.profile.machine };
      if (delivery) {
        try {
          await retry(() =>
            this.store.addComment(
              item,
              formatNeedsHuman({
                kind: "question",
                prompt: `Delivery ${delivery.url} completed, but final Project updates failed: ${error.message}`,
                locator,
              }),
            ),
          );
        } catch (reportError) {
          this.logger.error(
            `Unable to report finalization failure for PAN task #${item.number}`,
            reportError,
          );
        }
        if (delivery.mode === "direct") {
          await heartbeat.renewNow();
          const release = await retry(() =>
            this.store.release({
              itemId: item.id,
              runner,
              assignee: this.profile.githubAssignee,
              status: "blocked",
            }),
          );
          if (!release.released) {
            throw new Error(
              `Unable to block directly delivered task: ${release.reason}`,
            );
          }
          this.logger.warn?.(
            `Task #${item.number} was delivered directly but blocked because final Project updates failed.`,
          );
          return;
        }
        throw error;
      }
      if (result?.status !== "blocked") {
        await handle?.interrupt?.(`Runner failure: ${error.message}`);
        await this.#requeueOperationalStop({
          item,
          runner,
          playbook,
          handle,
          heartbeat,
          summary: `Runner failure: ${error.message}`,
        });
        return;
      }
      let reportError;
      try {
        await this.store.addComment(
          item,
          formatNeedsHuman({
            kind: "question",
            prompt: `Runner failure: ${error.message}`,
            locator,
          }),
        );
      } catch (error) {
        reportError = error;
        this.logger.error(
          `Unable to comment on failed PAN task #${item.number}`,
          error,
        );
      }
      try {
        await heartbeat.renewNow();
        const release = await retry(() =>
          this.store.release({
            itemId: item.id,
            runner,
            assignee: this.profile.githubAssignee,
            status: "blocked",
          }),
        );
        if (!release.released) {
          throw new Error(`Unable to release failed task: ${release.reason}`);
        }
      } catch (releaseError) {
        this.logger.error(
          `Unable to release failed PAN task #${item.number}`,
          releaseError,
        );
        if (!reportError) {
          reportError = releaseError;
        }
      }
      if (reportError) {
        this.logger.error(
          `PAN task #${item.number} failure reporting was incomplete`,
          reportError,
        );
      }
      throw error;
    } finally {
      heartbeat.stop();
    }
  }

  async #requeueOperationalStop({
    item,
    runner,
    playbook,
    handle,
    heartbeat,
    summary,
  }) {
    const resumeAffinity = handle
      ? runnerResumeAffinity(this.profile.id, playbook.id)
      : undefined;
    await handle?.setResumeAffinity?.(resumeAffinity);
    await handle?.markPendingRequeue?.();
    await heartbeat.renewNow();
    try {
      await retry(() =>
        this.store.addComment(
          item,
          agentStoppedComment({
            summary,
            playbook: playbook.id,
            locator: handle?.locator() ?? {
              machine: this.profile.machine,
              runner,
            },
            resumable: Boolean(handle),
          }),
        ),
      );
    } catch (error) {
      this.logger.error(
        `Unable to record agent stop for PAN task #${item.number}`,
        error,
      );
    }
    await heartbeat.renewNow();
    let release;
    try {
      release = await retry(() =>
        this.store.release({
          itemId: item.id,
          runner,
          assignee: this.profile.githubAssignee,
          status: "ready",
          ...(resumeAffinity ? { resumeAffinity } : {}),
        }),
      );
    } catch (error) {
      error.code = "PAN_INTERRUPTED_REQUEUE_FAILED";
      throw error;
    }
    if (!release.released) {
      const error = new Error(
        `Unable to requeue stopped task: ${release.reason}`,
      );
      error.code = "PAN_INTERRUPTED_REQUEUE_FAILED";
      throw error;
    }
    await handle?.markRequeued?.();
    this.logger.info?.(
      handle
        ? `Task #${item.number} returned to ready with resumable local state.`
        : `Task #${item.number} returned to ready after an operational failure.`,
    );
  }

  #leaseUntil() {
    return new Date(
      this.now().getTime() + this.profile.leaseSeconds * 1_000,
    ).toISOString();
  }

  async #recoverInterruptedTasks() {
    const interrupted = await this.executor.listInterruptedTasks?.();
    for (const task of interrupted ?? []) {
      try {
        if (!resumableAffinity(task.resumeAffinity)) {
          this.logger.error(
            `Interrupted task #${task.issueNumber ?? "unknown"} has no valid resume affinity; preserving it for manual recovery.`,
          );
          continue;
        }
        const release = await retry(() =>
          this.store.release({
            itemId: task.itemId,
            runner: task.runner,
            assignee: this.profile.githubAssignee,
            status: "ready",
            allowExpired: true,
            resumeAffinity: task.resumeAffinity,
          }),
        );
        if (!release.released) {
          const alreadyRequeued =
            release.reason === "not-owner" &&
            release.item?.fields?.status === "ready" &&
            release.item?.fields?.claimedBy === task.resumeAffinity;
          if (!alreadyRequeued) {
            this.logger.warn?.(
              `Skipped interrupted-task recovery for #${task.issueNumber ?? "unknown"}: ${release.reason}.`,
            );
            continue;
          }
        }
        await this.executor.markInterruptedRequeued?.(task);
        this.logger.info?.(
          `Recovered interrupted task #${task.issueNumber ?? "unknown"} to ready.`,
        );
      } catch (error) {
        this.logger.error(
          `Unable to recover interrupted task #${task.issueNumber ?? "unknown"}; continuing with normal polling.`,
          error,
        );
      }
    }
  }

  async #recoverLegacyRunnerStops() {
    const blocked = await this.store.listByFilter({
      owner: "agent",
      status: "blocked",
      unclaimed: true,
    });
    for (const item of blocked) {
      const comments = await this.store.listComments(item);
      const pending = latestNeedsHuman(comments);
      if (!/^Runner failure: Runner stopped(?:$|:)/i.test(pending?.prompt ?? "")) {
        continue;
      }
      const recoveryRunner = `${this.profile.id}/legacy-recovery/slot-1`;
      const claim = await this.store.claimWithLease({
        itemId: item.id,
        runner: recoveryRunner,
        leaseUntil: this.#leaseUntil(),
        status: "in-progress",
      });
      if (!claim.claimed) {
        continue;
      }
      const release = await retry(() =>
        this.store.release({
          itemId: item.id,
          runner: recoveryRunner,
          status: "ready",
        }),
      );
      if (!release.released) {
        throw new Error(
          `Unable to recover legacy runner-stopped task #${item.number}: ${release.reason}`,
        );
      }
      try {
        await this.store.addComment(
          item,
          formatNeedsHumanResolved(
            "Runner shutdown is not a human blocker; the task returned to ready.",
          ),
        );
      } catch (error) {
        this.logger.error(
          `Unable to mark stale runner attention resolved for task #${item.number}`,
          error,
        );
      }
      this.logger.info?.(
        `Recovered legacy runner-stopped task #${item.number} to ready.`,
      );
    }
  }

  #activePlaybookCounts() {
    const counts = new Map();
    for (const entry of this.active.values()) {
      counts.set(
        entry.playbookId,
        (counts.get(entry.playbookId) ?? 0) + 1,
      );
    }
    return counts;
  }

  #nextPlaybookSlot(playbook) {
    for (let slot = 1; slot <= playbook.capacity; slot += 1) {
      if (
        ![...this.active.values()].some(
          (entry) =>
            entry.playbookId === playbook.id && entry.slot === slot,
        )
      ) {
        return slot;
      }
    }
    throw new Error(`No free slot for playbook ${playbook.id}`);
  }
}

function isRunnable(item) {
  if (!["full-auto", "agent-reviewer"].includes(item.fields.autonomy)) {
    return false;
  }
  if (!item.fields.workstream?.trim()) {
    return false;
  }
  return Boolean(taskRepository(item));
}

function repositoryFor(item) {
  const repository = taskRepository(item);
  if (!repository) {
    throw new Error(
      `PAN task #${item.number} must have exactly one repo: requirement`,
    );
  }
  return repository;
}

function runnerResumeAffinity(runnerId, playbookId) {
  return playbookId === "legacy"
    ? `resume:${runnerId}`
    : `resume:${runnerId}/${playbookId}`;
}

function resumableAffinity(claimedBy) {
  return claimedBy?.startsWith("resume:") ? claimedBy : undefined;
}

function startHeartbeat({
  store,
  item,
  runner,
  leaseUntil,
  intervalMilliseconds,
  logger,
}) {
  let inFlight;
  let failure;
  let reportFailure;
  const failed = new Promise((resolve) => {
    reportFailure = resolve;
  });
  const renewNow = () => {
    if (failure) {
      return Promise.reject(failure);
    }
    if (inFlight) {
      return inFlight;
    }
    inFlight = (async () => {
      try {
        const result = await store.heartbeat({
          itemId: item.id,
          runner,
          leaseUntil: leaseUntil(),
        });
        if (!result.renewed) {
          failure = new Error(
            `Lease lost for PAN task #${item.number}: ${result.reason}`,
          );
          failure.code = "PAN_LEASE_LOST";
          throw failure;
        }
        logger.info?.(`Heartbeat renewed for PAN task #${item.number}.`);
      } catch (error) {
        failure = error;
        reportFailure(error);
        throw error;
      } finally {
        inFlight = undefined;
      }
    })();
    return inFlight;
  };
  const timer = setInterval(async () => {
    try {
      await renewNow();
    } catch (error) {
      logger.error(`Heartbeat failed for PAN task #${item.number}`, error);
    }
  }, intervalMilliseconds);
  return {
    failed,
    renewNow,
    stop: () => clearInterval(timer),
  };
}

async function waitForTask({
  handle,
  heartbeat,
  signal,
  onNeedsHuman,
}) {
  const abort = createAbortWaiter(signal);
  try {
    const outcome = await Promise.race([
      handle.wait({ onNeedsHuman }).then((result) => ({ result })),
      heartbeat.failed.then((error) => ({ error })),
      abort.promise.then((reason) => ({
        error: runnerStoppedError(reason),
      })),
    ]);
    if (outcome.error) {
      if (outcome.error.code === "PAN_RUNNER_STOPPED") {
        await handle.interrupt(outcome.error.message);
        return {
          status: "interrupted",
          summary: outcome.error.message,
        };
      }
      await handle.cancel(outcome.error.message);
      throw outcome.error;
    }
    return outcome.result;
  } finally {
    abort.stop();
  }
}

function createAbortWaiter(signal) {
  if (!signal) {
    return {
      promise: new Promise(() => {}),
      stop() {},
    };
  }
  if (signal.aborted) {
    return {
      promise: Promise.resolve(signal.reason),
      stop() {},
    };
  }
  let resolveAbort;
  const listener = () => resolveAbort(signal.reason);
  const promise = new Promise((resolve) => {
    resolveAbort = resolve;
    signal.addEventListener("abort", listener, { once: true });
  });
  return {
    promise,
    stop: () => signal.removeEventListener("abort", listener),
  };
}

function runnerStoppedError(reason) {
  const detail =
    reason instanceof Error && reason.message
      ? `: ${reason.message}`
      : "";
  const error = new Error(`Runner stopped${detail}`);
  error.code = "PAN_RUNNER_STOPPED";
  return error;
}

function completedComment(delivery, result) {
  const label =
    delivery.mode === "direct" ? "Commit" : "Pull request";
  return [
    "<!-- pan:runner-result -->",
    "### Agent completed",
    "",
    result.summary,
    "",
    `${label}: ${delivery.url}`,
  ].join("\n");
}

function agentStartedComment(record) {
  const heading = record.resumed ? "Agent resumed" : "Agent started";
  return [
    "<!-- pan:runner-event -->",
    `### ${heading}`,
    "",
    "```json",
    JSON.stringify(
      {
        event: record.resumed ? "resumed" : "started",
        machine: record.machine,
        runner: record.runner,
        playbook: record.playbook,
        repository: record.repository,
        branch: record.branch,
        worktree: record.worktreePath,
        terminalTitle: record.terminalTitle,
      },
      null,
      2,
    ),
    "```",
  ].join("\n");
}

function agentStoppedComment({ summary, playbook, locator, resumable }) {
  return [
    "<!-- pan:runner-event -->",
    "### Agent stopped",
    "",
    summary,
    "",
    "```json",
    JSON.stringify(
      {
        event: "stopped",
        resumable,
        playbook,
        ...locator,
      },
      null,
      2,
    ),
    "```",
  ].join("\n");
}

async function retry(action, attempts = 3) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await action();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}
