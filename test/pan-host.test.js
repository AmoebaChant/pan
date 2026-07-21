import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { PanHost } from "../src/index.js";

test("releases leadership when shutdown is requested during acquisition", async () => {
  let finishAcquisition;
  const acquisition = new Promise((resolve) => {
    finishAcquisition = resolve;
  });
  let released = false;
  const controller = new AbortController();
  const host = new PanHost({
    stateFile: path.join(os.tmpdir(), `pan-host-${randomUUID()}.json`),
    token: "secret",
    pollIntervalSeconds: 60,
    heartbeatSeconds: 60,
    autonomousApply: false,
    port: 0,
    reviewService: {
      run: async () => ({}),
      applyActions: async () => ({}),
    },
    toolRegistry: { dispatch: async () => ({}) },
    leaderLease: {
      acquire: () => acquisition,
      renew: async () => {},
      release: async () => {
        released = true;
      },
    },
  });

  const running = host.run({ signal: controller.signal });
  controller.abort();
  finishAcquisition({ acquired: true });
  await running;

  assert.equal(released, true);
});

test("queues a repair task after a scheduled review failure", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pan-host-"));
  const controller = new AbortController();
  let report;
  const host = new PanHost({
    stateFile: path.join(directory, "host.json"),
    token: "secret",
    pollIntervalSeconds: 0.01,
    heartbeatSeconds: 60,
    autonomousApply: true,
    model: "gpt-5.6-sol",
    reviewService: {
      run: async () => {
        throw new Error("review failed");
      },
      applyActions: async () => assert.fail("not called"),
    },
    repairService: {
      reportFailure: async (error, options) => {
        report = { error, options };
        controller.abort();
        return {
          created: true,
          issueNumber: 12,
          issueUrl: "https://github.com/example/domain/issues/12",
        };
      },
    },
    toolRegistry: { dispatch: async () => assert.fail("not called") },
    leaderLease: {
      acquire: async () => ({ acquired: true }),
      heartbeat: async () => ({ renewed: true }),
      release: async () => ({ released: true }),
    },
    logger: {
      info() {},
      error() {},
    },
  });

  await host.run({ signal: controller.signal });

  assert.equal(report.error.message, "review failed");
  assert.equal(report.options.source, "scheduled-review");
  assert.equal(report.options.model, "gpt-5.6-sol");
});

test("waits for in-flight repair reporting before releasing leadership", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pan-host-"));
  const controller = new AbortController();
  let finishRepair;
  const repairGate = new Promise((resolve) => {
    finishRepair = resolve;
  });
  let reportStarted;
  const started = new Promise((resolve) => {
    reportStarted = resolve;
  });
  let released = false;
  const host = new PanHost({
    stateFile: path.join(directory, "host.json"),
    token: "secret",
    pollIntervalSeconds: 0.01,
    heartbeatSeconds: 60,
    reviewService: {
      run: async () => {
        throw new Error("review failed");
      },
      applyActions: async () => assert.fail("not called"),
    },
    repairService: {
      reportFailure: async () => {
        reportStarted();
        await repairGate;
        return {
          created: true,
          issueNumber: 12,
          issueUrl: "https://github.com/example/domain/issues/12",
        };
      },
    },
    toolRegistry: { dispatch: async () => assert.fail("not called") },
    leaderLease: {
      acquire: async () => ({ acquired: true }),
      heartbeat: async () => ({ renewed: true }),
      release: async () => {
        released = true;
        return { released: true };
      },
    },
    logger: {
      info() {},
      error() {},
    },
  });

  const running = host.run({ signal: controller.signal });
  await started;
  controller.abort();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(released, false);
  finishRepair();
  await running;
  assert.equal(released, true);
});

test("hosts authenticated interactive tools while holding leadership", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pan-host-"));
  const stateFile = path.join(directory, "host.json");
  const calls = [];
  const host = new PanHost({
    stateFile,
    token: "secret",
    pollIntervalSeconds: 60,
    heartbeatSeconds: 60,
    reviewService: {
      run: async () => assert.fail("scheduled review should not run"),
      applyActions: async (actions, options) => {
        calls.push(["apply", actions, options]);
        return {
          appliedActions: [{ actionId: actions[0].actionId, summary: "Applied." }],
          rejectedActions: [],
          effects: { confirmed: [], incomplete: [] },
        };
      },
    },
    toolRegistry: {
      dispatch: async (operation, args) => {
        calls.push(["tool", operation, args]);
        if (operation === "propose_actions") {
          return {
            operation,
            status: "confirmed",
            proposals: [{ action: args.actions[0], policy: {} }],
            rejected: [],
          };
        }
        return { operation, status: "confirmed", data: { id: "snapshot-1" } };
      },
    },
    leaderLease: {
      acquire: async () => ({ acquired: true }),
      heartbeat: async () => ({ renewed: true }),
      release: async () => {
        calls.push(["release"]);
        return { released: true };
      },
    },
  });

  test("reports incomplete scheduled mutations as runtime failures", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "pan-host-"));
    const controller = new AbortController();
    let loggedError;
    const failed = new Promise((resolve) => {
      loggedError = resolve;
    });
    const host = new PanHost({
      stateFile: path.join(directory, "host.json"),
      token: "secret",
      pollIntervalSeconds: 0.01,
      heartbeatSeconds: 60,
      autonomousApply: true,
      reviewService: {
        run: async () => ({
          response: {
            recommendation: "Attempted.",
            effects: {
              incomplete: [{ actionId: "action-1", summary: "Partial." }],
            },
          },
        }),
        applyActions: async () => assert.fail("not called"),
      },
      toolRegistry: { dispatch: async () => assert.fail("not called") },
      leaderLease: {
        acquire: async () => ({ acquired: true }),
        heartbeat: async () => ({ renewed: true }),
        release: async () => ({ released: true }),
      },
      logger: {
        info: () => {},
        error: (_message, error) => {
          controller.abort();
          loggedError(error);
        },
      },
    });

    const running = host.run({ signal: controller.signal });
    const error = await failed;
    await running;
    assert.match(error.message, /incomplete mutation/i);
    assert.equal(error.result.response.effects.incomplete.length, 1);
  });

  const running = host.run();
  const state = await waitForState(stateFile);
  const unauthorized = await fetch(`${state.endpoint}/health`);
  assert.equal(unauthorized.status, 401);
  const health = await fetch(`${state.endpoint}/health`, {
    headers: { authorization: "Bearer secret" },
  });
  assert.equal(health.status, 200);

  const toolResponse = await fetch(`${state.endpoint}/tools/call`, {
    method: "POST",
    headers: {
      authorization: "Bearer secret",
      "content-type": "application/json",
    },
    body: JSON.stringify({ name: "read_portfolio", arguments: {} }),
  });
  assert.equal(toolResponse.status, 200);
  assert.equal((await toolResponse.json()).data.id, "snapshot-1");

  const action = {
    actionId: "action-1",
    kind: "field-update",
    expectedState: { snapshotId: "snapshot-1" },
  };
  const applyResponse = await fetch(`${state.endpoint}/tools/call`, {
    method: "POST",
    headers: {
      authorization: "Bearer secret",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      name: "propose_actions",
      arguments: { actions: [action] },
    }),
  });
  assert.equal(applyResponse.status, 200);
  assert.equal(
    (await applyResponse.json()).application.appliedActions[0].actionId,
    "action-1",
  );
  assert.equal(calls.find(([kind]) => kind === "apply")[2].snapshot.id, "snapshot-1");

  await fetch(`${state.endpoint}/shutdown`, {
    method: "POST",
    headers: { authorization: "Bearer secret" },
  });
  await running;
  assert.deepEqual(calls.at(-1), ["release"]);
});

async function waitForState(stateFile) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      return JSON.parse(await readFile(stateFile, "utf8"));
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error("PAN host state was not written");
}
