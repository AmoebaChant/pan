import { createServer } from "node:http";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const MAX_REQUEST_BYTES = 1024 * 1024;

export class PanHost {
  constructor({
    reviewService,
    toolRegistry,
    leaderLease,
    stateFile,
    token,
    pollIntervalSeconds = 300,
    heartbeatSeconds = 30,
    autonomousApply = false,
    repairService,
    model,
    logger = console,
    host = "127.0.0.1",
    port = 0,
  }) {
    if (
      !reviewService?.run ||
      !reviewService?.applyActions ||
      !toolRegistry?.dispatch ||
      !leaderLease?.acquire ||
      !stateFile ||
      !token
    ) {
      throw new TypeError(
        "reviewService, toolRegistry, leaderLease, stateFile, and token are required",
      );
    }
    if (repairService && !repairService.reportFailure) {
      throw new TypeError("repairService must provide reportFailure()");
    }
    this.reviewService = reviewService;
    this.toolRegistry = toolRegistry;
    this.leaderLease = leaderLease;
    this.stateFile = stateFile;
    this.token = token;
    this.pollIntervalSeconds = pollIntervalSeconds;
    this.heartbeatSeconds = heartbeatSeconds;
    this.autonomousApply = autonomousApply;
    this.repairService = repairService;
    this.model = model;
    this.logger = logger;
    this.host = host;
    this.port = port;
    this.queue = Promise.resolve();
    this.snapshots = new Map();
  }

  async run({ signal } = {}) {
    this.logger.info?.("Acquiring domain leadership.");
    const acquisition = await this.leaderLease.acquire();
    if (!acquisition.acquired) {
      throw new Error(
        `PAN leader lease is held by ${acquisition.lease?.holder ?? "another instance"}`,
      );
    }
    this.logger.info?.("Domain leadership acquired.");
    const guard = startLeaseGuard(
      this.leaderLease,
      this.heartbeatSeconds,
      this.logger,
    );
    const controller = new AbortController();
    const stop = () => controller.abort(signal?.reason);
    if (signal?.aborted) {
      stop();
    } else {
      signal?.addEventListener("abort", stop, { once: true });
    }
    if (guard.signal.aborted) {
      controller.abort(guard.signal.reason);
    } else {
      guard.signal.addEventListener(
        "abort",
        () => controller.abort(guard.signal.reason),
        { once: true },
      );
    }

    const server = createServer((request, response) => {
      void this.#handle(request, response, controller);
    });
    let reviewTimer;
    const scheduleReview = () => {
      reviewTimer = setTimeout(() => {
        void this.#enqueue(async () => {
          if (controller.signal.aborted) {
            return;
          }
          try {
            this.logger.info?.("Starting scheduled portfolio review.");
            const result = await this.reviewService.run({
              apply: this.autonomousApply,
              signal: controller.signal,
            });
            if (result.response.effects?.incomplete?.length > 0) {
              const error = new Error(
                "PAN scheduled review produced an incomplete mutation",
              );
              error.result = result;
              throw error;
            }
            this.logger.info?.(
              `Scheduled review completed: ${result.response.recommendation}`,
            );
          } catch (error) {
            await this.#handleScheduledReviewFailure(
              error,
              controller.signal,
            );
          }
        })
          .finally(() => {
            if (!controller.signal.aborted) {
              scheduleReview();
            }
          });
      }, this.pollIntervalSeconds * 1_000);
    };
    try {
      if (controller.signal.aborted) {
        return;
      }
      scheduleReview();
      await listen(server, this.host, this.port);
      const address = server.address();
      const endpoint = `http://${this.host}:${address.port}`;
      await writeState(this.stateFile, {
        version: 1,
        pid: process.pid,
        endpoint,
        token: this.token,
        autonomousApply: this.autonomousApply,
        startedAt: new Date().toISOString(),
      });
      this.logger.info?.(
        `Listening at ${endpoint}; model=${this.model ?? "auto"}; scheduled reviews=${this.autonomousApply ? "apply" : "dry-run"}.`,
      );
      await waitForAbort(controller.signal);
    } finally {
      this.logger.info?.("Stopping host and releasing domain leadership.");
      clearTimeout(reviewTimer);
      signal?.removeEventListener("abort", stop);
      await close(server);
      await this.queue;
      try {
        try {
          await guard.stop();
        } finally {
          await this.leaderLease.release();
        }
      } finally {
        await rm(this.stateFile, { force: true });
      }
    }
  }

  async #handle(request, response, controller) {
    try {
      if (!authorized(request, this.token)) {
        return sendJson(response, 401, { error: "Unauthorized" });
      }
      if (request.method === "GET" && request.url === "/health") {
        return sendJson(response, 200, {
          status: "ready",
          autonomousApply: this.autonomousApply,
        });
      }
      if (request.method === "POST" && request.url === "/shutdown") {
        this.logger.info?.("Shutdown requested.");
        sendJson(response, 202, { status: "stopping" });
        controller.abort(new Error("PAN host stopped"));
        return;
      }
      if (request.method === "POST" && request.url === "/tools/call") {
        const body = await readJsonBody(request);
        this.logger.info?.(`Tool call: ${body.name}`);
        const result = await this.#enqueue(() =>
          this.#dispatch(body.name, body.arguments ?? {}, controller.signal),
        );
        return sendJson(response, 200, result);
      }
      return sendJson(response, 404, { error: "Not found" });
    } catch (error) {
      return sendJson(response, 500, {
        error: error.message,
        code: error.code,
        ...(error.result ? { result: error.result } : {}),
      });
    }
  }

  async #dispatch(operation, args, signal) {
    signal.throwIfAborted();
    const proposal = await this.toolRegistry.dispatch(operation, args);
    if (operation === "read_portfolio") {
      this.#rememberSnapshot(proposal.data);
    }
    if (operation !== "propose_actions") {
      return proposal;
    }
    const actions = proposal.proposals.map((entry) => entry.action);
    if (actions.length === 0) {
      return { ...proposal, application: undefined };
    }
    if (actions.every((action) => action.kind === "no-op")) {
      return {
        ...proposal,
        application: {
          appliedActions: actions.map((action) => ({
            actionId: action.actionId,
            summary: action.recommendation,
          })),
          rejectedActions: [],
          effects: { confirmed: [], incomplete: [] },
        },
      };
    }
    const snapshotId = actionSnapshotId(actions);
    const snapshot = this.snapshots.get(snapshotId);
    if (!snapshot) {
      throw new Error(
        "The proposed actions do not reference a portfolio snapshot read by this PAN session; refresh the portfolio and retry",
      );
    }
    return {
      ...proposal,
      application: await this.reviewService.applyActions(actions, {
        signal,
        snapshot,
      }),
    };
  }

  #enqueue(operation) {
    const pending = this.queue.then(operation, operation);
    this.queue = pending.catch(() => {});
    return pending;
  }

  async #handleScheduledReviewFailure(error, signal) {
    if (signal.aborted) {
      return;
    }
    this.logger.error("PAN scheduled review failed", error);
    if (!this.repairService) {
      return;
    }
    try {
      const repair = await this.repairService.reportFailure(error, {
        source: "scheduled-review",
        model: this.model,
        signal,
      });
      this.logger.info?.(
        repair.created
          ? `Queued self-repair task #${repair.issueNumber}: ${repair.issueUrl}`
          : `Self-repair task #${repair.issueNumber} is already open: ${repair.issueUrl}`,
      );
    } catch (repairError) {
      if (!signal.aborted) {
        this.logger.error("PAN could not queue a self-repair task", repairError);
      }
    }
  }

  #rememberSnapshot(snapshot) {
    this.snapshots.set(snapshot.id, snapshot);
    while (this.snapshots.size > 10) {
      this.snapshots.delete(this.snapshots.keys().next().value);
    }
  }
}

function startLeaseGuard(leaderLease, heartbeatSeconds, logger) {
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
          return;
        }
        logger.info?.("Domain leadership heartbeat renewed.");
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

async function listen(server, host, port) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
}

async function close(server) {
  if (!server.listening) {
    return;
  }
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function waitForAbort(signal) {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    signal.addEventListener("abort", resolve, { once: true });
  });
}

function authorized(request, token) {
  return request.headers.authorization === `Bearer ${token}`;
}

async function readJsonBody(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (Buffer.byteLength(body) > MAX_REQUEST_BYTES) {
      throw new Error("PAN host request exceeds the size limit");
    }
  }
  const parsed = JSON.parse(body || "{}");
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError("PAN host request body must be an object");
  }
  return parsed;
}

function sendJson(response, status, value) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

function actionSnapshotId(actions) {
  const ids = new Set(
    actions
      .filter((action) => action.kind !== "no-op")
      .map((action) => action.expectedState?.snapshotId),
  );
  if (ids.size !== 1 || ids.has(undefined)) {
    throw new Error(
      "Interactive mutation proposals must reference one exact portfolio snapshot",
    );
  }
  return [...ids][0];
}

async function writeState(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  await rename(temporary, filePath);
}
