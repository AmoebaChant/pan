import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildScheduleBootstrapPrompt,
  createInitialSessionDueState,
  isSessionReviewDue,
  MAX_NATIVE_SCHEDULE_INTERVAL_SECONDS,
  recordSessionReview,
  verifyCopilotInvocationContract,
} from "../src/index.js";

test("package tests exclude executable fixture files", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));

  assert.equal(packageJson.scripts.test, "node --test test/*.test.js");
});

test("defines a bounded native scheduling bootstrap contract", () => {
  const prompt = buildScheduleBootstrapPrompt({
    scheduling: {
      enabled: true,
      startup: "immediate",
      reviewIntervalSeconds: 86_400,
    },
    dueStatePath: "C:\\runtime\\session-a.due.json",
  });

  assert.equal(MAX_NATIVE_SCHEDULE_INTERVAL_SECONDS, 3_600);
  assert.match(prompt, /exactly one native session-scoped recurring schedule/i);
  assert.match(prompt, /\/every 3600s/);
  assert.match(prompt, /C:\\runtime\\session-a\.due\.json/);
  assert.match(prompt, /Run one fresh startup review now/i);
  assert.match(prompt, /fresh complete portfolio evidence/i);
});

test("requires the documented Copilot schedule commands or gives manual guidance", async () => {
  await assert.rejects(
    verifyCopilotInvocationContract({
      commands: {
        run: async () =>
          "--agent --add-dir --model --no-auto-update --interactive",
      },
      requireScheduling: true,
    }),
    /Upgrade Copilot CLI.*\/every 3600s/i,
  );

  await verifyCopilotInvocationContract({
    commands: {
      run: async () =>
        "--agent --add-dir --model --no-auto-update --interactive /every /after",
    },
    requireScheduling: true,
  });
});

test("uses launch-local due state without replaying another session", () => {
  const state = createInitialSessionDueState({
    sessionId: "session-a",
    reviewIntervalSeconds: 86_400,
    now: "2026-07-22T00:00:00.000Z",
  });

  assert.equal(
    isSessionReviewDue(state, { now: "2026-07-22T23:59:59.000Z" }),
    false,
  );
  assert.equal(
    isSessionReviewDue(state, { now: "2026-07-23T00:00:00.000Z" }),
    true,
  );
  assert.deepEqual(
    recordSessionReview(state, { now: "2026-07-23T00:00:00.000Z" }),
    {
      ...state,
      lastReviewAt: "2026-07-23T00:00:00.000Z",
      nextReviewAt: "2026-07-24T00:00:00.000Z",
    },
  );
});

test(
  "opt-in live contract retains the hostless ordinary-Copilot requirements",
  { skip: process.env.PAN_LIVE_COPILOT_SESSION !== "1", timeout: 120_000 },
  async () => {
    await verifyCopilotInvocationContract({
      executable: process.env.COPILOT_EXECUTABLE ?? "copilot",
      commands: {
        async run(executable, args) {
          const { execFile } = await import("node:child_process");
          return await new Promise((resolve, reject) => {
            execFile(executable, args, { windowsHide: true }, (error, stdout, stderr) => {
              if (error) {
                error.stderr = stderr;
                reject(error);
                return;
              }
              resolve(stdout);
            });
          });
        },
      },
      requireScheduling: true,
      scheduling: { reviewIntervalSeconds: 3_600 },
    });
  },
);
