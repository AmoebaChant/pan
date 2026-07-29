import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const SESSION_DUE_STATE_VERSION = 1;

/**
 * Absorbs the offset between a fixed-cadence tick and a due time anchored to the
 * previous review, which would otherwise halve the effective review rate.
 */
export const SESSION_REVIEW_DUE_TOLERANCE_SECONDS = 60;

/**
 * Creates metadata used only by one active Copilot session to gate long cadences.
 */
export async function createSessionDueState({
  sessionId,
  reviewIntervalSeconds,
  directory = path.join(os.homedir(), "AppData", "Local", "PAN", "sessions"),
  now = () => new Date(),
} = {}) {
  const state = createInitialSessionDueState({
    sessionId,
    reviewIntervalSeconds,
    now: now(),
  });
  await mkdir(directory, { recursive: true });
  const filePath = path.join(directory, `${sessionId}.due.json`);
  await writeFile(filePath, `${JSON.stringify(state)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  return {
    path: filePath,
    state,
    async dispose() {
      await rm(filePath, { force: true });
    },
  };
}

export function createInitialSessionDueState({
  sessionId,
  reviewIntervalSeconds,
  now = new Date(),
} = {}) {
  if (!sessionId?.trim()) {
    throw new TypeError("sessionId is required");
  }
  if (!Number.isInteger(reviewIntervalSeconds) || reviewIntervalSeconds <= 0) {
    throw new TypeError("reviewIntervalSeconds must be a positive integer");
  }
  const startedAt = toTimestamp(now, "now");
  return {
    version: SESSION_DUE_STATE_VERSION,
    sessionId,
    reviewIntervalSeconds,
    startedAt,
    nextReviewAt: new Date(
      Date.parse(startedAt) + reviewIntervalSeconds * 1_000,
    ).toISOString(),
  };
}

export function isSessionReviewDue(
  state,
  {
    now = new Date(),
    toleranceSeconds = SESSION_REVIEW_DUE_TOLERANCE_SECONDS,
  } = {},
) {
  validateSessionDueState(state);
  if (!Number.isFinite(toleranceSeconds) || toleranceSeconds < 0) {
    throw new TypeError("toleranceSeconds must be a non-negative number");
  }
  return (
    Date.parse(toTimestamp(now, "now")) + toleranceSeconds * 1_000 >=
    Date.parse(state.nextReviewAt)
  );
}

export function recordSessionReview(state, { now = new Date() } = {}) {
  validateSessionDueState(state);
  const reviewedAt = toTimestamp(now, "now");
  return {
    ...state,
    lastReviewAt: reviewedAt,
    nextReviewAt: new Date(
      Date.parse(reviewedAt) + state.reviewIntervalSeconds * 1_000,
    ).toISOString(),
  };
}

function validateSessionDueState(state) {
  if (
    state?.version !== SESSION_DUE_STATE_VERSION ||
    !state.sessionId?.trim() ||
    !Number.isInteger(state.reviewIntervalSeconds) ||
    state.reviewIntervalSeconds <= 0 ||
    Number.isNaN(Date.parse(state.startedAt)) ||
    Number.isNaN(Date.parse(state.nextReviewAt))
  ) {
    throw new TypeError("invalid Pan session due state");
  }
}

function toTimestamp(value, name) {
  const timestamp = value instanceof Date ? value.toISOString() : value;
  if (typeof timestamp !== "string" || Number.isNaN(Date.parse(timestamp))) {
    throw new TypeError(`${name} must be a valid timestamp`);
  }
  return new Date(timestamp).toISOString();
}
