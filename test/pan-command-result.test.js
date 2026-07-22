import assert from "node:assert/strict";
import test from "node:test";

import {
  commandResultExitCode,
  commandResultFromError,
  createPanCommandResult,
  PanCommandError,
  validatePanCommandResult,
} from "../src/index.js";

test("validates every command outcome with domain identity and recovery", () => {
  for (const status of ["confirmed", "rejected", "incomplete", "failed"]) {
    const result = createPanCommandResult({
      ...baseResult(status),
      ...(status === "incomplete"
        ? { remainingSteps: ["Retry confirmation after the dependency recovers."] }
        : {}),
    });
    assert.equal(result.status, status);
  }
});

test("rejects missing and inconsistent envelope fields", () => {
  assert.throws(
    () => validatePanCommandResult({ ...baseResult("confirmed"), version: 2 }),
    /command result\.version must be 1/,
  );
  assert.throws(
    () =>
      validatePanCommandResult({
        ...baseResult("confirmed"),
        remainingSteps: ["Do more work"],
      }),
    /must be empty when status is confirmed/,
  );
  assert.throws(
    () => validatePanCommandResult(baseResult("incomplete")),
    /must name remaining required steps/,
  );
  assert.throws(
    () =>
      validatePanCommandResult({
        ...baseResult("confirmed"),
        recovery: { safe: "yes", steps: [] },
      }),
    /recovery\.safe must be a boolean/,
  );
});

test("preserves partial effects and turns dependency failures into failed results", () => {
  const incomplete = createPanCommandResult({
    ...baseResult("incomplete"),
    confirmedEffects: ["Created the GitHub Issue #42."],
    remainingSteps: ["Add Issue #42 to the configured Project."],
  });

  assert.equal(commandResultExitCode(incomplete), 1);
  assert.deepEqual(incomplete.confirmedEffects, [
    "Created the GitHub Issue #42.",
  ]);

  const failed = commandResultFromError(new Error("GitHub is unavailable"), {
    operation: "project.add",
    domain: baseResult("failed").domain,
  });
  assert.equal(failed.status, "failed");
  assert.match(failed.diagnostics[0], /GitHub is unavailable/);

  const wrapped = new PanCommandError("Operation was rejected", {
    ...baseResult("rejected"),
  });
  assert.equal(
    commandResultFromError(wrapped, {
      operation: "ignored",
      domain: baseResult("failed").domain,
    }),
    wrapped.result,
  );
});

test("preserves JSON-compatible command payloads inside the envelope", () => {
  const result = createPanCommandResult({
    ...baseResult("confirmed"),
    data: {
      id: 42,
      issueUrl: "https://github.com/example/domain/issues/42",
      entries: [{ locator: { machine: "machine-a" } }],
    },
  });

  assert.deepEqual(result.data.entries[0].locator, { machine: "machine-a" });
  assert.throws(
    () =>
      validatePanCommandResult({
        ...baseResult("confirmed"),
        data: [],
      }),
    /command result\.data must be an object/,
  );
});

function baseResult(status) {
  return {
    version: 1,
    status,
    operation: "project.add",
    operationId: "operation-1",
    domain: {
      repository: "example/domain",
      projectOwner: "example",
      projectNumber: 12,
    },
    confirmedEffects: [],
    remainingSteps: [],
    diagnostics: [],
    recovery: { safe: true, steps: [] },
    snapshot: { id: "snapshot-1" },
    expectedState: { projectRevision: "revision-1" },
  };
}
