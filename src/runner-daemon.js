import { formatNeedsHuman } from "./needs-human.js";
import {
  isRateLimitError,
  nextPollDelaySeconds,
  rateLimitBackoffSeconds,
  waitForNextPoll,
} from "./polling.js";

const PRIORITY = new Map([
  ["urgent", 0],
  ["high", 1],
  ["normal", 2],
  ["low", 3],
]);

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
    this.profile = profile;
    this.executor = executor;
    this.now = now;
    this.sleep = sleep;
    this.logger = logger;
    this.active = new Map();
  }

  async runOnce() {
    await this.tick();
    await Promise.all([...this.active.values()]);
  }

  async run({ signal } = {}) {
    let idlePolls = 0;
    while (!signal?.aborted) {
      let started = 0;
      let rateLimited = false;
      try {
        started = await this.tick();
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
    await Promise.all([...this.active.values()]);
  }

  async tick() {
    if (!this.profile.online) {
      return 0;
    }
    const freeSlots =
      this.profile.maxConcurrentDaemons - this.active.size;
    if (freeSlots <= 0) {
      return 0;
    }

    const items = await this.store.listByFilter({
      owner: "agent",
      status: "ready",
      claimable: true,
    });
    const candidates = items
      .filter((item) => isRunnable(item, this.profile))
      .sort(compareItems);

    let started = 0;
    for (const item of candidates) {
      if (started >= freeSlots) {
        break;
      }
      const slot = this.#nextSlot();
      const runner = `${this.profile.id}/slot-${slot}`;
      let claim;
      try {
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
        continue;
      }

      const promise = this.#runClaim(claim.item, runner)
        .catch((error) => {
          this.logger.error(`PAN task #${item.number} failed`, error);
        })
        .finally(() => {
          this.active.delete(slot);
        });
      this.active.set(slot, promise);
      started += 1;
    }
    return started;
  }

  async #runClaim(item, runner) {
    const repository = repositoryFor(item);
    const deadline =
      this.now().getTime() +
      this.profile.taskBudget.wallClockMinutes * 60_000;
    let handle;
    const heartbeat = startHeartbeat({
      store: this.store,
      item,
      runner,
      leaseUntil: () => this.#leaseUntil(),
      intervalMilliseconds: this.profile.heartbeatSeconds * 1_000,
      logger: this.logger,
    });
    let prUrl;
    try {
      const comments = await this.store.listComments(item);
      handle = await this.executor.start({
        item: { ...item, comments },
        repository,
        runner,
        deadline,
      });
      const result = await handle.wait({
        onNeedsHuman: (record) =>
          this.store.addComment(item, formatNeedsHuman(record)),
      });

      if (result.status === "completed") {
        await heartbeat.renewNow();
        ({ prUrl } = await handle.complete(result, {
          assertLease: heartbeat.renewNow,
        }));
        const release = await retry(() =>
          this.store.release({
            itemId: item.id,
            runner,
            assignee: this.profile.githubAssignee,
            status: "in-review",
          }),
        );
        if (!release.released) {
          throw new Error(`Unable to release completed task: ${release.reason}`);
        }
        try {
          await retry(() =>
            this.store.addComment(item, completedComment(prUrl, result)),
          );
        } catch (commentError) {
          this.logger.error(
            `Unable to comment on completed PAN task #${item.number}`,
            commentError,
          );
        }
        return;
      }

      const record = {
        kind: result.budgetExceeded ? "approval" : "question",
        prompt: result.summary,
        locator: handle.locator(result.localUrl),
      };
      await this.store.addComment(item, formatNeedsHuman(record));
      const release = await this.store.release({
        itemId: item.id,
        runner,
        assignee: this.profile.githubAssignee,
        status: "blocked",
      });
      if (!release.released) {
        throw new Error(`Unable to release blocked task: ${release.reason}`);
      }
    } catch (error) {
      const locator = handle
        ? handle.locator()
        : { machine: this.profile.machine };
      if (prUrl) {
        try {
          await retry(() =>
            this.store.addComment(
              item,
              formatNeedsHuman({
                kind: "question",
                prompt: `Pull request ${prUrl} was created, but final Project updates failed: ${error.message}`,
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
        throw error;
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

  #leaseUntil() {
    return new Date(
      this.now().getTime() + this.profile.leaseSeconds * 1_000,
    ).toISOString();
  }

  #nextSlot() {
    for (
      let slot = 1;
      slot <= this.profile.maxConcurrentDaemons;
      slot += 1
    ) {
      if (!this.active.has(slot)) {
        return slot;
      }
    }
    throw new Error("No free daemon slot");
  }
}

function isRunnable(item, profile) {
  if (!["full-auto", "agent-reviewer"].includes(item.fields.autonomy)) {
    return false;
  }
  if (!item.fields.workstream?.trim()) {
    return false;
  }
  const repositories = item.requirements.filter((requirement) =>
    requirement.startsWith("repo:"),
  );
  if (
    repositories.length !== 1 ||
    !profile.repositories[repositories[0].slice("repo:".length)]
  ) {
    return false;
  }
  return item.requirements.every((requirement) =>
    profile.capabilities.includes(requirement),
  );
}

function repositoryFor(item) {
  const repositories = item.requirements
    .filter((requirement) => requirement.startsWith("repo:"))
    .map((requirement) => requirement.slice("repo:".length));
  if (repositories.length !== 1) {
    throw new Error(
      `PAN task #${item.number} must have exactly one repo: requirement`,
    );
  }
  return repositories[0];
}

function compareItems(left, right) {
  const priority =
    (PRIORITY.get(left.fields.priority) ?? PRIORITY.size) -
    (PRIORITY.get(right.fields.priority) ?? PRIORITY.size);
  return priority || left.number - right.number;
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
          throw failure;
        }
      } catch (error) {
        failure = error;
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
  timer.unref?.();
  return {
    renewNow,
    stop: () => clearInterval(timer),
  };
}

function completedComment(prUrl, result) {
  return [
    "<!-- pan:runner-result -->",
    "### Runner completed",
    "",
    result.summary,
    "",
    `Pull request: ${prUrl}`,
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
