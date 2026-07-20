export class PanRuntime {
  constructor({
    reviewService,
    leaderLease,
    pollIntervalSeconds = 30,
    heartbeatSeconds = 30,
    logger = console,
    sleep = (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
  }) {
    if (!reviewService?.run || !leaderLease?.acquire) {
      throw new TypeError("reviewService and leaderLease are required");
    }
    this.reviewService = reviewService;
    this.leaderLease = leaderLease;
    this.pollIntervalSeconds = pollIntervalSeconds;
    this.heartbeatSeconds = heartbeatSeconds;
    this.logger = logger;
    this.sleep = sleep;
  }

  async runOnce({ userInput } = {}) {
    const acquisition = await this.leaderLease.acquire();
    if (!acquisition.acquired) {
      return { leader: false, reason: acquisition.reason ?? "leased" };
    }
    const guard = startLeaseGuard(this.leaderLease, this.heartbeatSeconds);
    try {
      const result = await this.reviewService.run({
        apply: true,
        signal: guard.signal,
        ...(userInput ? { userInput } : {}),
      });
      assertComplete(result);
      return {
        leader: true,
        ...result,
      };
    } finally {
      try {
        await guard.stop();
      } finally {
        await this.leaderLease.release();
      }
    }
  }

  async run({ signal } = {}) {
    const acquisition = await this.leaderLease.acquire();
    if (!acquisition.acquired) {
      throw new Error(
        `PAN leader lease is held by ${acquisition.lease?.holder ?? "another instance"}`,
      );
    }
    const guard = startLeaseGuard(this.leaderLease, this.heartbeatSeconds);
    try {
      while (!signal?.aborted && !guard.signal.aborted) {
        try {
          const result = await this.reviewService.run({
            apply: true,
            signal: anySignal(signal, guard.signal),
          });
          assertComplete(result);
        } catch (error) {
          if (!signal?.aborted && !guard.signal.aborted) {
            this.logger.error("PAN reasoning cycle failed", error);
          }
        }
        await this.sleep(this.pollIntervalSeconds * 1_000);
      }
    } finally {
      try {
        await guard.stop();
      } finally {
        await this.leaderLease.release();
      }
    }
  }
}

function startLeaseGuard(leaderLease, heartbeatSeconds) {
  const controller = new AbortController();
  let inFlight;
  let failure;
  const renew = () => {
    if (inFlight || failure) {
      return;
    }
    inFlight = leaderLease
      .heartbeat()
      .then((result) => {
        if (!result.renewed) {
          failure = new Error(`PAN leader lease lost: ${result.reason}`);
          controller.abort(failure);
        }
      })
      .catch((error) => {
        failure = error;
        controller.abort(error);
      })
      .finally(() => {
        inFlight = undefined;
      });
  };
  const timer = setInterval(renew, heartbeatSeconds * 1_000);
  return {
    signal: controller.signal,
    stop: async () => {
      clearInterval(timer);
      await inFlight;
      if (failure) {
        throw failure;
      }
    },
  };
}

function anySignal(...signals) {
  const active = signals.filter(Boolean);
  if (active.length === 0) {
    return undefined;
  }
  if (active.length === 1) {
    return active[0];
  }
  return AbortSignal.any(active);
}

function assertComplete(result) {
  if (result.response?.effects?.incomplete?.length > 0) {
    const error = new Error(
      "PAN reasoning cycle produced an incomplete mutation",
    );
    error.result = result;
    throw error;
  }
}
