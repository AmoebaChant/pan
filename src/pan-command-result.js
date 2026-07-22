import { randomUUID } from "node:crypto";

const COMMAND_RESULT_VERSION = 1;
const STATUSES = new Set(["confirmed", "rejected", "incomplete", "failed"]);

export class PanCommandError extends Error {
  constructor(message, result, { cause } = {}) {
    super(message, { cause });
    this.name = "PanCommandError";
    this.result = validatePanCommandResult(result);
  }
}

export function createPanCommandResult({
  status,
  operation,
  operationId = randomUUID(),
  domain,
  confirmedEffects = [],
  remainingSteps = [],
  diagnostics = [],
  recovery = { safe: true, steps: [] },
  snapshot,
  expectedState,
  leadership,
  receipts,
  data,
} = {}) {
  return validatePanCommandResult({
    version: COMMAND_RESULT_VERSION,
    status,
    operation,
    operationId,
    domain,
    confirmedEffects,
    remainingSteps,
    diagnostics,
    recovery,
    ...(snapshot === undefined ? {} : { snapshot }),
    ...(expectedState === undefined ? {} : { expectedState }),
    ...(leadership === undefined ? {} : { leadership }),
    ...(receipts === undefined ? {} : { receipts }),
    ...(data === undefined ? {} : { data }),
  });
}

export function validatePanCommandResult(result) {
  requireRecord(result, "command result");
  rejectUnexpectedKeys(
    result,
    new Set([
      "version",
      "status",
      "operation",
      "operationId",
      "domain",
      "confirmedEffects",
      "remainingSteps",
      "diagnostics",
      "recovery",
      "snapshot",
      "expectedState",
      "leadership",
      "receipts",
      "data",
    ]),
    "command result",
  );
  if (result.version !== COMMAND_RESULT_VERSION) {
    fail("command result.version", `must be ${COMMAND_RESULT_VERSION}`);
  }
  if (!STATUSES.has(result.status)) {
    fail("command result.status", `must be one of ${[...STATUSES].join(", ")}`);
  }
  requireString(result.operation, "command result.operation");
  requireString(result.operationId, "command result.operationId");
  validateDomain(result.domain);
  requireStringArray(result.confirmedEffects, "command result.confirmedEffects");
  requireStringArray(result.remainingSteps, "command result.remainingSteps");
  requireStringArray(result.diagnostics, "command result.diagnostics");
  validateRecovery(result.recovery);
  if (result.snapshot !== undefined) {
    validateIdentity(result.snapshot, "command result.snapshot");
  }
  if (result.expectedState !== undefined) {
    validateIdentity(result.expectedState, "command result.expectedState");
  }
  if (result.leadership !== undefined) {
    validateIdentity(result.leadership, "command result.leadership");
  }
  if (result.receipts !== undefined) {
    if (!Array.isArray(result.receipts)) {
      fail("command result.receipts", "must be an array");
    }
    for (const [index, receipt] of result.receipts.entries()) {
      validateIdentity(receipt, `command result.receipts[${index}]`);
    }
  }
  if (result.data !== undefined) {
    validateData(result.data, "command result.data");
  }
  if (
    result.status === "confirmed" &&
    result.remainingSteps.length > 0
  ) {
    fail(
      "command result.remainingSteps",
      "must be empty when status is confirmed",
    );
  }
  if (
    result.status === "incomplete" &&
    result.remainingSteps.length === 0
  ) {
    fail(
      "command result.remainingSteps",
      "must name remaining required steps when status is incomplete",
    );
  }
  return structuredClone(result);
}

export function commandResultFromError(error, details) {
  if (error instanceof PanCommandError) {
    return error.result;
  }
  return createPanCommandResult({
    ...details,
    status: "failed",
    diagnostics: [error instanceof Error ? error.message : String(error)],
    recovery: {
      safe: true,
      steps: ["Resolve the reported dependency failure and retry the operation."],
    },
  });
}

export function commandResultExitCode(result, { mutating = true } = {}) {
  const normalized = validatePanCommandResult(result);
  return !mutating || normalized.status === "confirmed" ? 0 : 1;
}

function validateDomain(domain) {
  requireRecord(domain, "command result.domain");
  rejectUnexpectedKeys(
    domain,
    new Set(["repository", "projectOwner", "projectNumber"]),
    "command result.domain",
  );
  requireString(domain.repository, "command result.domain.repository");
  requireString(domain.projectOwner, "command result.domain.projectOwner");
  if (!Number.isInteger(domain.projectNumber) || domain.projectNumber < 1) {
    fail("command result.domain.projectNumber", "must be a positive integer");
  }
}

function validateIdentity(identity, field) {
  requireRecord(identity, field);
  if (Object.keys(identity).length === 0) {
    fail(field, "must not be empty");
  }
  for (const [key, value] of Object.entries(identity)) {
    requireString(key, `${field} key`);
    if (
      typeof value !== "string" &&
      typeof value !== "number" &&
      typeof value !== "boolean"
    ) {
      fail(`${field}.${key}`, "must be a string, number, or boolean");
    }
  }
}

function validateRecovery(recovery) {
  requireRecord(recovery, "command result.recovery");
  rejectUnexpectedKeys(
    recovery,
    new Set(["safe", "steps"]),
    "command result.recovery",
  );
  if (typeof recovery.safe !== "boolean") {
    fail("command result.recovery.safe", "must be a boolean");
  }
  requireStringArray(recovery.steps, "command result.recovery.steps");
}

function validateData(data, field) {
  requireRecord(data, field);
  try {
    JSON.stringify(data);
  } catch {
    fail(field, "must contain JSON-compatible values");
  }
}

function requireRecord(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(field, "must be an object");
  }
}

function requireString(value, field) {
  if (typeof value !== "string" || !value.trim()) {
    fail(field, "must be a non-empty string");
  }
}

function requireStringArray(value, field) {
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string" || !entry.trim())
  ) {
    fail(field, "must be an array of non-empty strings");
  }
}

function rejectUnexpectedKeys(record, allowed, field) {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      fail(`${field}.${key}`, "is not supported");
    }
  }
}

function fail(field, correction) {
  throw new TypeError(`${field} ${correction}`);
}

export const PAN_COMMAND_RESULT_VERSION = COMMAND_RESULT_VERSION;
export const PAN_COMMAND_RESULT_STATUSES = Object.freeze([...STATUSES]);
