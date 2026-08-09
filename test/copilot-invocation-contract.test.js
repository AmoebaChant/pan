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
  assert.match(prompt, /read the configured Project and current Issue state directly/i);
  assert.match(prompt, /Never import unrelated Issues, resurrect closed Issues/i);
});

test("verifies the Copilot options Pan actually passes", async () => {
  await assert.rejects(
    verifyCopilotInvocationContract({
      commands: {
        run: async () => "--agent --add-dir --model --interactive",
      },
    }),
    /does not support the required Pan session options: --no-auto-update/,
  );

  await verifyCopilotInvocationContract({
    commands: {
      run: async () =>
        "--agent --add-dir --model --no-auto-update --interactive",
    },
  });
});

test("grants a standing triage policy only when configured", () => {
  const reporting = buildScheduleBootstrapPrompt({
    scheduling: {
      enabled: true,
      startup: "immediate",
      reviewIntervalSeconds: 3_600,
      triageAuthority: "report",
    },
    dueStatePath: "C:\\runtime\\session-a.due.json",
  });
  const triaging = buildScheduleBootstrapPrompt({
    scheduling: {
      enabled: true,
      startup: "immediate",
      reviewIntervalSeconds: 3_600,
      triageAuthority: "triage-fields",
    },
    dueStatePath: "C:\\runtime\\session-a.due.json",
  });

  assert.match(reporting, /Discuss recommendations before mutation/i);
  assert.doesNotMatch(reporting, /standing policy/i);
  assert.match(triaging, /standing policy to triage untriaged open Issues without asking/i);
  assert.match(
    triaging,
    /This authority covers only open Issues; a scheduled review still registers every missing Issue, open or closed, but closed Issues stay historical records it never reclassifies or mutates without an explicit request/i,
  );
  assert.match(
    triaging,
    /Status is missing, empty, or explicitly set to untriaged/i,
  );
  assert.match(
    triaging,
    /owner, Status, priority, an optional workstream, and the requirements that select a playbook/i,
  );
  assert.match(
    triaging,
    /Never leave an item owner agent and Status ready with empty requirements/i,
  );
  assert.doesNotMatch(triaging, /including requirements, to an explicit approval/i);
  assert.match(triaging, /within the next 60 seconds/i);
  assert.doesNotMatch(triaging, /Discuss recommendations before mutation/i);
});

test("uses launch-local due state without replaying another session", () => {
  const state = createInitialSessionDueState({
    sessionId: "session-a",
    reviewIntervalSeconds: 86_400,
    now: "2026-07-22T00:00:00.000Z",
  });

  assert.equal(
    isSessionReviewDue(state, {
      now: "2026-07-22T23:59:59.000Z",
      toleranceSeconds: 0,
    }),
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

test("treats a near-miss tick as due so drift cannot halve the review rate", () => {
  const state = createInitialSessionDueState({
    sessionId: "session-drift",
    reviewIntervalSeconds: 3_600,
    now: "2026-07-22T00:00:00.000Z",
  });

  assert.equal(state.nextReviewAt, "2026-07-22T01:00:00.000Z");
  assert.equal(
    isSessionReviewDue(state, { now: "2026-07-22T00:59:59.600Z" }),
    true,
    "a sub-second near-miss must not defer the review by a full interval",
  );
  assert.equal(
    isSessionReviewDue(state, { now: "2026-07-22T00:59:00.000Z" }),
    true,
    "the tolerance window reaches exactly 60 seconds early",
  );
  assert.equal(
    isSessionReviewDue(state, { now: "2026-07-22T00:58:59.000Z" }),
    false,
    "anything earlier than the window is still not due",
  );
});

test("rejects a negative due tolerance", () => {
  const state = createInitialSessionDueState({
    sessionId: "session-bad-tolerance",
    reviewIntervalSeconds: 3_600,
    now: "2026-07-22T00:00:00.000Z",
  });

  assert.throws(
    () => isSessionReviewDue(state, { toleranceSeconds: -1 }),
    /toleranceSeconds must be a non-negative number/,
  );
});

test(
  "opt-in live contract retains the ordinary Copilot requirements",
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
    });
  },
);
