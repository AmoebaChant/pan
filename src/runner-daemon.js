import {
  formatNeedsHumanResolved,
  latestNeedsHuman,
} from "./needs-human.js";
import { AttentionService } from "./attention-service.js";
import {
  dispatchBlocker,
  matchingPlaybook,
  normalizePlaybooks,
  playbookBlocker,
  taskRepository,
  unsatisfiableRequirements,
} from "./playbook.js";
import {
  isRateLimitError,
  nextPollDelaySeconds,
  rateLimitBackoffSeconds,
  waitForNextPoll,
} from "./polling.js";
import { formatRunnerWindowTitle } from "./terminal-title.js";

const OPERATIONAL_FAILURE_LIMIT = 3;
const RUNNER_EVENT_MARKER = "<!-- pan:runner-event -->";
const RUNNER_RESULT_MARKER = "<!-- pan:runner-result -->";
const ATTENTION_RESOLVED_MARKER = "<!-- pan:needs-human-resolved -->";

export class RunnerDaemon {
  constructor({
    store,
    profile,
    executor,
    attention,
    now = () => new Date(),
    sleep = (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
    logger = console,
    setWindowTitle = () => {},
  }) {
    this.store = store;
    this.profile = profile.playbooks
      ? profile
      : { ...profile, playbooks: normalizePlaybooks(profile) };
    this.executor = executor;
    this.attention =
      attention ??
      new AttentionService({
        store,
      });
    this.now = now;
    this.sleep = sleep;
    this.logger = logger;
    this.setWindowTitle = setWindowTitle;
    this.active = new Map();
    this.escalatedRequirements = new Set();
    this.loggedClosedSkips = new Set();
    this.#refreshWindowTitle();
  }

  #refreshWindowTitle() {
    const taskNumbers = [...this.active.values()]
      .map((entry) => entry.issueNumber)
      .filter((value) => value !== undefined);
    try {
      this.setWindowTitle(formatRunnerWindowTitle(taskNumbers));
    } catch (error) {
      this.logger.warn?.("Unable to update terminal window title", error);
    }
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
        this.logger.error("Pan runner poll failed", error);
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
    await this.#recoverResumeTasks(signal);
    await this.#recoverLegacyRunnerStops();
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
      open: true,
    });
    const candidates = [];
    for (const item of items) {
      const blocker = dispatchBlocker(item);
      if (blocker) {
        if (blocker.code === "issue-closed") {
          this.#logClosedSkip(item);
        } else {
          this.logger.info?.(
            `Skipping task #${item.number}: ${blocker.message}.`,
          );
        }
        continue;
      }
      candidates.push(item);
    }
    candidates.sort(compareRunnerPriority);
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
        await this.#reportUndispatchable(item, eligibleProfile, activeCounts);
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
        this.logger.error(`Unable to claim Pan task #${item.number}`, error);
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
          this.logger.error(`Pan task #${item.number} failed`, error);
        })
        .finally(() => {
          this.active.delete(runner);
          this.#refreshWindowTitle();
          this.logger.info?.(
            `Released local capacity for task #${item.number}; active=${this.active.size}.`,
          );
        });
      this.active.set(runner, {
        playbookId: playbook.id,
        slot,
        promise,
        issueNumber: item.number,
      });
      this.#refreshWindowTitle();
      activeCounts.set(
        playbook.id,
        (activeCounts.get(playbook.id) ?? 0) + 1,
      );
      started += 1;
    }
    return started;
  }

  async #runClaim(item, runner, playbook, signal, adoptedHandle) {
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
    let outcome;
    let result;
    try {
      if (adoptedHandle) {
        handle = adoptedHandle;
        this.logger.info?.(
          `Watching adopted task #${item.number} for ${repository}.`,
        );
      } else {
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
                `Unable to record agent start for Pan task #${item.number}`,
                error,
              );
            }
            if (record.resumed || !item.fields.needsHumanSince) {
              return;
            }
            try {
              await this.attention.resolve(item, {
                runner,
                reason:
                  "The previous worker did not survive to be answered; this task restarted from the beginning.",
              });
            } catch (error) {
              this.logger.error(
                `Unable to clear stale human attention for Pan task #${item.number}`,
                error,
              );
            }
          },
        });
      }
      result = await waitForTask({
        handle,
        heartbeat,
        signal,
        onNeedsHuman: async (record) => {
          try {
            await this.attention.request(item, record, {
              runner,
              resumeAffinity: runnerResumeAffinity(
                this.profile.id,
                playbook.id,
              ),
            });
            this.logger.info?.(
              `Task #${item.number} is waiting for a human at its terminal; it keeps its lease and slot.`,
            );
          } catch (error) {
            this.logger.error(
              `Unable to flag human attention for Pan task #${item.number}`,
              error,
            );
          }
        },
        onAttentionCleared: async () => {
          try {
            await this.attention.resolve(item, { runner });
            this.logger.info?.(
              `Task #${item.number} was answered at its terminal and resumed work.`,
            );
          } catch (error) {
            this.logger.error(
              `Unable to clear human attention for Pan task #${item.number}`,
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
        outcome = await handle.complete(result, {
          assertLease: heartbeat.renewNow,
        });
        this.logger.info?.(
          `Task #${item.number} reported ${outcome.outcome}${outcome.url ? `: ${outcome.url}` : ""}.`,
        );
        try {
          await retry(() =>
            this.store.addComment(item, completedComment(outcome, result)),
          );
        } catch (commentError) {
          this.logger.error(
            `Unable to comment on completed Pan task #${item.number}`,
            commentError,
          );
        }
        await heartbeat.renewNow();
        const completedStatus =
          outcome.outcome === "done" ? "done" : "in-review";
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
          countFailure: !result.summary.startsWith("Runner stopped"),
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

      if (result.budgetExceeded) {
        await handle.interrupt?.("The task budget was exhausted.");
        await heartbeat.renewNow();
        await this.attention.request(
          item,
          {
            kind: "approval",
            prompt:
              "Approve another runner attempt after increasing or removing the task budget.",
            locator: handle.locator(result.localUrl),
            source: "runner",
            reason: "budget-exhausted",
          },
          {
            runner,
            resumeAffinity: runnerResumeAffinity(
              this.profile.id,
              playbook.id,
            ),
          },
        );
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
          throw new Error(`Unable to release exhausted task: ${release.reason}`);
        }
        this.logger.info?.(
          `Task #${item.number} exhausted its budget and needs a human decision; its lease was released.`,
        );
        return;
      }

      if (result.status === "blocked") {
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
          throw new Error(`Unable to release blocked task: ${release.reason}`);
        }
        this.logger.info?.(
          `Task #${item.number} is blocked on an external dependency and its lease was released.`,
        );
        return;
      }
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
      if (outcome) {
        await this.#requeueOperationalStop({
          item,
          runner,
          playbook,
          handle: undefined,
          heartbeat,
          summary: `Delivery${outcome.url ? ` ${outcome.url}` : ""} completed, but final Project updates failed: ${error.message}`,
        });
        return;
      }
      try {
        await handle?.interrupt?.(`Runner failure: ${error.message}`);
      } catch (interruptError) {
        this.logger.warn?.(
          `Task #${item.number} could not be marked resumable; releasing it anyway.`,
          interruptError,
        );
      }
      await this.#requeueOperationalStop({
        item,
        runner,
        playbook,
        handle,
        heartbeat,
        summary: `Runner failure: ${error.message}`,
      });
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
    countFailure = true,
  }) {
    const resumeAffinity = handle
      ? runnerResumeAffinity(this.profile.id, playbook.id)
      : undefined;
    await handle?.setResumeAffinity?.(resumeAffinity);
    await heartbeat.renewNow();
    const failureCount = countFailure
      ? consecutiveOperationalFailures(await this.store.listComments(item)) + 1
      : undefined;
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
            countsTowardFailureLimit: countFailure,
            consecutiveFailures: failureCount,
          }),
        ),
      );
    } catch (error) {
      this.logger.error(
        `Unable to record agent stop for Pan task #${item.number}`,
        error,
      );
    }
    await heartbeat.renewNow();
    if (failureCount >= OPERATIONAL_FAILURE_LIMIT) {
      await this.attention.request(
        item,
        {
          kind: "approval",
          prompt: `This task stopped ${failureCount} consecutive times. Correct the latest failure before approving another runner attempt.`,
          locator: handle?.locator() ?? {
            machine: this.profile.machine,
            runner,
          },
          source: "runner",
          reason: "repeated-operational-failure",
          failure: {
            count: failureCount,
            limit: OPERATIONAL_FAILURE_LIMIT,
            summary,
          },
        },
        {
          runner,
          runnerAssignee: this.profile.githubAssignee,
          resumeAffinity,
        },
      );
      this.logger.warn?.(
        `Task #${item.number} moved to human attention after ${failureCount} consecutive operational failures.`,
      );
      return;
    }
    await handle?.markPendingRequeue?.();
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

  #logClosedSkip(item) {
    if (this.loggedClosedSkips.has(item.number)) {
      return;
    }
    this.loggedClosedSkips.add(item.number);
    const message = `Skipping task #${item.number}: its Issue is closed.`;
    if (this.logger.debug) {
      this.logger.debug(message);
    } else {
      this.logger.info?.(message);
    }
  }

  async #recoverResumeTasks(signal) {
    const tasks = this.executor.listResumeTasks
      ? await this.executor.listResumeTasks()
      : await this.executor.listInterruptedTasks?.();
    for (const task of tasks ?? []) {
      try {
        const item = await this.store.getItem(task.itemId, { signal });
        if (!item) {
          this.logger.warn?.(
            `Resume pointer for task #${task.issueNumber ?? "unknown"} has no Project item; preserving it for manual recovery.`,
          );
          continue;
        }
        if (
          item.state?.toLowerCase() === "closed" ||
          item.fields.status === "done"
        ) {
          await this.executor.discardResumeTask?.(
            task,
            "The Issue was closed while its runner was offline.",
          );
          this.logger.info?.(
            `Discarded resume state for closed task #${item.number}.`,
          );
          continue;
        }
        if (task.workerState === "live" && !task.requeue) {
          await this.#adoptResumeTask(task, item, signal);
          continue;
        }
        if (task.workerState === "unknown") {
          this.logger.warn?.(
            `Task #${task.issueNumber ?? "unknown"} has an active worker whose identity could not be verified; preserving it without dispatching a duplicate.`,
          );
          continue;
        }
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
          `Recovered stopped task #${task.issueNumber ?? "unknown"} to ready${task.workerState === "identity-mismatch" ? " after rejecting a mismatched worker PID" : ""}.`,
        );
      } catch (error) {
        this.logger.error(
          `Unable to recover interrupted task #${task.issueNumber ?? "unknown"}; continuing with normal polling.`,
          error,
        );
      }
    }
  }

  async #adoptResumeTask(task, item, signal) {
    const playbook = this.profile.playbooks.find(
      (candidate) => candidate.id === task.playbookId,
    );
    const slot = runnerPlaybookSlot(
      task.runner,
      this.profile.id,
      playbook,
    );
    if (!playbook || !slot || slot > playbook.capacity) {
      throw new Error(
        `Resume pointer for task #${item.number} has an invalid runner slot`,
      );
    }
    if (this.active.has(task.runner)) {
      return;
    }

    const reserved = {
      playbookId: playbook.id,
      slot,
      promise: Promise.resolve(),
      issueNumber: item.number,
    };
    this.active.set(task.runner, reserved);
    this.#refreshWindowTitle();
    try {
      const claim = await this.store.claimWithLease({
        itemId: item.id,
        runner: task.runner,
        assignee: this.profile.githubAssignee,
        leaseUntil: this.#leaseUntil(),
        status: "in-progress",
      });
      if (!claim.claimed) {
        throw new Error(`Unable to refresh adopted claim: ${claim.reason}`);
      }
      const handle = await this.executor.adoptTask(task, claim.item);
      const promise = this.#runClaim(
        claim.item,
        task.runner,
        playbook,
        signal,
        handle,
      )
        .catch((error) => {
          this.logger.error(`Adopted Pan task #${item.number} failed`, error);
        })
        .finally(() => {
          this.active.delete(task.runner);
          this.#refreshWindowTitle();
          this.logger.info?.(
            `Released local capacity for adopted task #${item.number}; active=${this.active.size}.`,
          );
        });
      reserved.promise = promise;
      this.logger.info?.(
        `Adopted still-running task #${item.number} as ${task.runner}; slot ${slot}/${playbook.capacity} is reserved.`,
      );
    } catch (error) {
      this.active.delete(task.runner);
      this.#refreshWindowTitle();
      throw error;
    }
  }

  async #recoverLegacyRunnerStops() {
    const blocked = await this.store.listByFilter({
      owner: "agent",
      status: "blocked",
      unclaimed: true,
      open: true,
    });
    for (const item of blocked) {
      if (item.state?.toLowerCase() === "closed") {
        continue;
      }
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
        await this.store.resolveHumanAttention({ itemId: item.id });
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

  async #reportUndispatchable(item, eligibleProfile, activeCounts) {
    const blocker = playbookBlocker(item, eligibleProfile, activeCounts);
    const unsatisfiable = unsatisfiableRequirements(item, this.profile);
    if (unsatisfiable.length === 0) {
      this.logger.info?.(`Skipping task #${item.number}: ${blocker.message}.`);
      return;
    }
    const key = `${item.number}:${unsatisfiable.join(",")}`;
    if (this.escalatedRequirements.has(key)) {
      return;
    }
    this.escalatedRequirements.add(key);
    this.logger.warn?.(
      `Task #${item.number} can never be claimed here: ${blocker.message}. ` +
        `requirements only selects a playbook, so it must contain one repo: entry and capabilities a runner advertises.`,
    );
    try {
      await this.store.requestHumanAttention({ itemId: item.id });
    } catch (error) {
      this.logger.warn?.(
        `Unable to flag task #${item.number} for a human: ${error.message}`,
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

function repositoryFor(item) {
  const repository = taskRepository(item);
  if (!repository) {
    throw new Error(
      `Pan task #${item.number} must have exactly one repo: requirement`,
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

function runnerPlaybookSlot(runner, profileId, playbook) {
  if (!playbook) {
    return undefined;
  }
  const prefix = playbook.legacy
    ? `${profileId}/slot-`
    : `${profileId}/${playbook.id}/slot-`;
  if (!runner.startsWith(prefix)) {
    return undefined;
  }
  const slot = Number(runner.slice(prefix.length));
  return Number.isInteger(slot) && slot > 0 ? slot : undefined;
}

const PRIORITY_ORDER = new Map([
  ["urgent", 0],
  ["high", 1],
  ["normal", 2],
  ["low", 3],
]);

function compareRunnerPriority(left, right) {
  return (
    (PRIORITY_ORDER.get(left.fields.priority) ?? Number.MAX_SAFE_INTEGER) -
    (PRIORITY_ORDER.get(right.fields.priority) ?? Number.MAX_SAFE_INTEGER)
  );
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
            `Lease lost for Pan task #${item.number}: ${result.reason}`,
          );
          failure.code = "PAN_LEASE_LOST";
          throw failure;
        }
        logger.info?.(`Heartbeat renewed for Pan task #${item.number}.`);
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
      logger.error(`Heartbeat failed for Pan task #${item.number}`, error);
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
  onAttentionCleared,
}) {
  const abort = createAbortWaiter(signal);
  try {
    const outcome = await Promise.race([
      handle
        .wait({ onNeedsHuman, onAttentionCleared })
        .then((result) => ({ result })),
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

function completedComment(outcome, result) {
  return [
    "<!-- pan:runner-result -->",
    outcome.outcome === "done"
      ? "### Agent completed"
      : "### Agent completed, ready for review",
    "",
    result.summary,
    ...(outcome.details ? ["", outcome.details] : []),
    ...(outcome.url ? ["", `Delivery: ${outcome.url}`] : []),
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
        sessionId: record.sessionId,
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

function agentStoppedComment({
  summary,
  playbook,
  locator,
  resumable,
  countsTowardFailureLimit,
  consecutiveFailures,
}) {
  return [
    RUNNER_EVENT_MARKER,
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
        countsTowardFailureLimit,
        ...(consecutiveFailures === undefined
          ? {}
          : { consecutiveFailures }),
        ...locator,
      },
      null,
      2,
    ),
    "```",
  ].join("\n");
}

function consecutiveOperationalFailures(comments) {
  let count = 0;
  for (const comment of [...comments].reverse()) {
    const body = comment.body ?? "";
    if (
      body.includes(RUNNER_RESULT_MARKER) ||
      body.includes(ATTENTION_RESOLVED_MARKER)
    ) {
      break;
    }
    if (
      !body.includes(RUNNER_EVENT_MARKER) ||
      !body.includes("### Agent stopped")
    ) {
      continue;
    }
    const event = parseRunnerEvent(body);
    if (
      event.event === "stopped" &&
      (event.countsTowardFailureLimit ??
        !body.includes("Runner stopped"))
    ) {
      count += 1;
    }
  }
  return count;
}

function parseRunnerEvent(body) {
  const fence = body.match(/```json\s*([\s\S]*?)\s*```/i);
  if (!fence) {
    throw new Error("Pan runner-event comment has no JSON record");
  }
  try {
    return JSON.parse(fence[1]);
  } catch (error) {
    throw new Error("Pan runner-event comment contains invalid JSON", {
      cause: error,
    });
  }
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
