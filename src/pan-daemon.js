import {
  formatNeedsHuman,
  formatNeedsHumanResolved,
  latestNeedsHuman,
} from "./needs-human.js";
import {
  compareBacklogItems,
  deriveTriage,
  matchingRunner,
} from "./triage-policy.js";

export class PanDaemon {
  constructor({
    store,
    profileSource,
    leaderLease,
    pollIntervalSeconds = 30,
    leaderHeartbeatSeconds = 30,
    transitionLeaseSeconds = 60,
    transitionRunner = "pan/triage",
    now = () => new Date(),
    logger = console,
    sleep = (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
  }) {
    if (!store || !profileSource || !leaderLease) {
      throw new TypeError("store, profileSource, and leaderLease are required");
    }
    this.store = store;
    this.profileSource = profileSource;
    this.leaderLease = leaderLease;
    this.pollIntervalSeconds = pollIntervalSeconds;
    this.leaderHeartbeatSeconds = leaderHeartbeatSeconds;
    this.transitionLeaseSeconds = transitionLeaseSeconds;
    this.transitionRunner = transitionRunner;
    this.now = now;
    this.logger = logger;
    this.sleep = sleep;
  }

  async runOnce() {
    const acquisition = await this.leaderLease.acquire();
    if (!acquisition.acquired) {
      return { leader: false, reason: acquisition.reason ?? "leased" };
    }
    const guard = startLeaderGuard(
      this.leaderLease,
      this.leaderHeartbeatSeconds * 1_000,
    );
    try {
      return {
        leader: true,
        ...(await this.tick({ assertLeader: guard.assert })),
      };
    } finally {
      await guard.stop();
      await this.leaderLease.release();
    }
  }

  async run({ signal } = {}) {
    const acquisition = await this.leaderLease.acquire();
    if (!acquisition.acquired) {
      throw new Error(
        `PAN leader lease is held by ${acquisition.lease?.holder ?? "another instance"}`,
      );
    }
    const guard = startLeaderGuard(
      this.leaderLease,
      this.leaderHeartbeatSeconds * 1_000,
    );
    try {
      while (!signal?.aborted) {
        await guard.assert();
        try {
          await this.tick({ assertLeader: guard.assert });
        } catch (error) {
          this.logger.error("PAN triage poll failed", error);
        }
        await this.sleep(this.pollIntervalSeconds * 1_000);
      }
    } finally {
      await guard.stop();
      await this.leaderLease.release();
    }
  }

  async tick({ assertLeader = async () => {} } = {}) {
    await assertLeader();
    const [items, profiles] = await Promise.all([
      this.store.syncOpenIssues({ beforeMutation: assertLeader }),
      this.profileSource.load(),
    ]);
    const summary = {
      inspected: items.length,
      triaged: 0,
      needsDetail: 0,
      blocked: 0,
      unblocked: 0,
      reordered: false,
    };

    for (const item of items) {
      if (
        !item.number ||
        item.state === "closed" ||
        ["in-progress", "in-review", "done"].includes(item.fields.status)
      ) {
        continue;
      }
      const comments = await this.store.listComments(item);
      const triage = deriveTriage(item, comments);
      const { status: desiredStatus, ...desiredFields } = triage.fields;
      const changed = changedFields(item.fields, desiredFields);
      if (
        Object.keys(changed).length > 0 &&
        (await this.#setFieldsIfMutable(item, changed, assertLeader))
      ) {
        item.requirements = triage.fields.requirements;
        summary.triaged += 1;
      }

      const pending = latestNeedsHuman(comments);
      if (desiredStatus === "needs-detail") {
        summary.needsDetail += 1;
        if (
          !pending ||
          pending.source !== "pan" ||
          pending.reason !== "missing-detail" ||
          pending.prompt !== triage.prompt
        ) {
          await assertLeader();
          await this.store.addComment(
            item,
            formatNeedsHuman({
              kind: "question",
              prompt: triage.prompt,
              source: "pan",
              reason: "missing-detail",
              locator: { issue: item.url },
            }),
          );
        }
        if (
          item.fields.status !== "needs-detail" &&
          (await this.#setStatus(
            item,
            ["untriaged", "needs-detail", "blocked"],
            "needs-detail",
            assertLeader,
          ))
        ) {
          summary.triaged += 1;
        }
        continue;
      }
      if (
        desiredStatus !== item.fields.status &&
        (await this.#setStatus(
          item,
          [item.fields.status],
          desiredStatus,
          assertLeader,
        ))
      ) {
        summary.triaged += 1;
      }

      const match =
        item.fields.owner === "agent"
          ? matchingRunner(item.requirements, profiles)
          : undefined;
      if (item.fields.status === "ready" && item.fields.owner === "agent" && !match) {
        const prompt = `No online runner matches: ${item.requirements.join(", ")}.`;
        if (
          !pending ||
          pending.source !== "pan" ||
          pending.reason !== "unmatchable-requirements" ||
          pending.prompt !== prompt
        ) {
          await assertLeader();
          await this.store.addComment(
            item,
            formatNeedsHuman({
              kind: "question",
              prompt,
              source: "pan",
              reason: "unmatchable-requirements",
              locator: { issue: item.url },
            }),
          );
        }
        if (
          await this.#setStatus(
            item,
            ["ready"],
            "blocked",
            assertLeader,
          )
        ) {
          summary.blocked += 1;
        }
      } else if (
        item.fields.status === "blocked" &&
        pending?.source === "pan" &&
        pending.reason === "unmatchable-requirements" &&
        match
      ) {
        if (
          !(await this.#setStatus(
            item,
            ["blocked"],
            "ready",
            assertLeader,
          ))
        ) {
          continue;
        }
        await assertLeader();
        await this.store.addComment(
          item,
          formatNeedsHumanResolved(`Runner ${match.id} can service this item.`),
        );
        summary.unblocked += 1;
      } else if (
        item.fields.status === "ready" &&
        pending?.source === "pan" &&
        pending.reason === "unmatchable-requirements" &&
        match
      ) {
        await assertLeader();
        await this.store.addComment(
          item,
          formatNeedsHumanResolved(`Runner ${match.id} can service this item.`),
        );
      }
    }

    const ordered = [...items].sort(compareBacklogItems);
    if (!sameOrder(items, ordered)) {
      await assertLeader();
      await this.store.reorderItems(ordered.map((item) => item.id));
      summary.reordered = true;
    }
    return summary;
  }

  async #setFieldsIfMutable(item, fields, assertLeader) {
    await assertLeader();
    const current = await this.store.getItem(item.id);
    if (
      !current ||
      ["in-progress", "in-review", "done"].includes(current.fields.status)
    ) {
      return false;
    }
    await assertLeader();
    await this.store.setFields(item.id, fields);
    Object.assign(item.fields, normalizedFields(fields));
    return true;
  }

  async #setStatus(item, expectedStatuses, status, assertLeader) {
    await assertLeader();
    const current = await this.store.getItem(item.id);
    if (!current || !expectedStatuses.includes(current.fields.status)) {
      return false;
    }
    const transitionRunner = `${this.transitionRunner}/${item.id}`;
    const claim = await this.store.claimWithLease({
      itemId: item.id,
      runner: transitionRunner,
      leaseUntil: new Date(
        this.now().getTime() + this.transitionLeaseSeconds * 1_000,
      ).toISOString(),
      status: current.fields.status,
    });
    if (!claim.claimed || !expectedStatuses.includes(claim.item.fields.status)) {
      return false;
    }
    let transitionError;
    let transitioned = false;
    try {
      await assertLeader();
      await this.store.setFields(item.id, { status });
      const confirmed = await this.store.getItem(item.id);
      transitioned =
        confirmed?.fields.status === status &&
        confirmed.fields.claimedBy === transitionRunner;
      if (!transitioned) {
        transitionError = new Error(
          `PAN status transition was not confirmed for item ${item.id}`,
        );
      }
    } catch (error) {
      transitionError = error;
    }
    const release = await this.store.release({
      itemId: item.id,
      runner: transitionRunner,
      status: null,
    });
    if (!release.released) {
      throw new Error(
        `PAN status transition lease could not be released: ${release.reason}`,
        { cause: transitionError },
      );
    }
    if (transitionError) {
      throw transitionError;
    }
    if (!transitioned) {
      return false;
    }
    item.fields.status = status;
    return true;
  }
}

function changedFields(current, desired) {
  return Object.fromEntries(
    Object.entries(desired).filter(([key, value]) => {
      const normalized = Array.isArray(value) ? value.join("\n") : value ?? "";
      return (current[key] ?? "") !== normalized;
    }),
  );
}

function normalizedFields(fields) {
  return Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [
      key,
      Array.isArray(value) ? value.join("\n") : value ?? "",
    ]),
  );
}

function sameOrder(left, right) {
  return left.every((item, index) => item.id === right[index]?.id);
}

function startLeaderGuard(leaderLease, intervalMilliseconds) {
  let failure;
  let inFlight;
  const renew = () => {
    if (inFlight || failure) {
      return inFlight;
    }
    inFlight = leaderLease
      .heartbeat()
      .then((result) => {
        if (!result.renewed) {
          failure = new Error(`PAN leader lease lost: ${result.reason}`);
        }
      })
      .catch((error) => {
        failure = error;
      })
      .finally(() => {
        inFlight = undefined;
      });
    return inFlight;
  };
  const timer = setInterval(renew, intervalMilliseconds);
  return {
    assert: async () => {
      await inFlight;
      if (failure) {
        throw failure;
      }
    },
    stop: async () => {
      clearInterval(timer);
      await inFlight;
    },
  };
}
