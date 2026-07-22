const PROTOCOL_VERSION = 1;
const TURN_MODES = new Set(["autonomous-review", "interactive-chat"]);
const ACTION_KINDS = new Set([
  "field-update",
  "canonical-reorder",
  "relative-precedence",
  "issue-create",
  "issue-comment",
  "needs-human",
  "no-op",
]);
const CITATION_KINDS = new Set([
  "issue",
  "issue-comment",
  "project-field",
  "workstream",
  "runner",
  "domain-record",
]);
const TOOL_STATUSES = new Set([
  "confirmed",
  "rejected",
  "incomplete",
  "failed",
]);

export function validatePanTurnRequest(record) {
  requireRecord(record, "turn");
  requireVersion(record.version, "turn.version");
  requireEqual(record.type, "request", "turn.type");
  validateTurnIdentity(record);
  validateSnapshot(record.snapshot, "turn.snapshot");
  validateToolChannel(record.toolChannel, "turn.toolChannel");

  if (record.mode === "interactive-chat") {
    requireString(record.userInput, "turn.userInput");
  } else if (record.userInput !== undefined) {
    requireString(record.userInput, "turn.userInput");
  }

  return {
    ...record,
    snapshot: { ...record.snapshot },
    toolChannel: {
      ...record.toolChannel,
      allowedOperations: [...record.toolChannel.allowedOperations],
    },
  };
}

export function validatePanAction(record, path = "action") {
  requireRecord(record, path);
  requireVersion(record.version, `${path}.version`);
  requireString(record.actionId, `${path}.actionId`);
  if (!ACTION_KINDS.has(record.kind)) {
    fail(
      `${path}.kind`,
      `must be one of ${[...ACTION_KINDS].join(", ")}`,
    );
  }
  requireString(record.rationale, `${path}.rationale`);
  requireConfidence(record.confidence, `${path}.confidence`);
  validateCitations(record.evidence, `${path}.evidence`, { nonEmpty: true });

  if (record.kind === "no-op") {
    requireString(record.recommendation, `${path}.recommendation`);
    if (
      record.expectedState !== undefined ||
      record.idempotencyKey !== undefined
    ) {
      fail(
        path,
        "no-op actions must not include mutation concurrency fields",
      );
    }
    return clone(record);
  }

  requireString(record.idempotencyKey, `${path}.idempotencyKey`);
  requireNonEmptyRecord(record.expectedState, `${path}.expectedState`);
  requireString(
    record.expectedState.snapshotId,
    `${path}.expectedState.snapshotId`,
  );
  validateActionTarget(record, path);
  return clone(record);
}

export function validatePanFinalResponse(record) {
  requireRecord(record, "response");
  requireVersion(record.version, "response.version");
  requireEqual(record.type, "final-response", "response.type");
  validateTurnIdentity(record, "response");
  requireString(record.snapshotId, "response.snapshotId");
  requireString(record.recommendation, "response.recommendation");

  validateEvidenceStatements(record.facts, "response.facts");
  requireStringArray(record.interpretations, "response.interpretations");
  requireStringArray(record.assumptions, "response.assumptions");
  requireStringArray(record.uncertainties, "response.uncertainties");
  validateCitations(record.citations, "response.citations");

  const proposedActions = requireArray(
    record.proposedActions,
    "response.proposedActions",
  ).map((action, index) =>
    validatePanAction(action, `response.proposedActions[${index}]`),
  );
  validateActionOutcomes(record.appliedActions, "response.appliedActions", {
    rejected: false,
  });
  validateActionOutcomes(record.rejectedActions, "response.rejectedActions", {
    rejected: true,
  });
  requireRecord(record.effects, "response.effects");
  validateEffects(record.effects.confirmed, "response.effects.confirmed", {
    incomplete: false,
  });
  validateEffects(record.effects.incomplete, "response.effects.incomplete", {
    incomplete: true,
  });

  return {
    ...record,
    facts: cloneArray(record.facts),
    interpretations: [...record.interpretations],
    assumptions: [...record.assumptions],
    uncertainties: [...record.uncertainties],
    citations: cloneArray(record.citations),
    proposedActions,
    appliedActions: cloneArray(record.appliedActions),
    rejectedActions: cloneArray(record.rejectedActions),
    effects: {
      confirmed: cloneArray(record.effects.confirmed),
      incomplete: cloneArray(record.effects.incomplete),
    },
  };
}

export function normalizePanFinalResponse(record) {
  return validatePanFinalResponse({
    facts: [],
    interpretations: [],
    assumptions: [],
    uncertainties: [],
    citations: [],
    proposedActions: [],
    appliedActions: [],
    rejectedActions: [],
    effects: { confirmed: [], incomplete: [] },
    ...record,
    effects: {
      confirmed: [],
      incomplete: [],
      ...record?.effects,
    },
  });
}

export function validatePanToolMessage(record) {
  requireRecord(record, "toolMessage");
  requireVersion(record.version, "toolMessage.version");
  requireString(record.requestId, "toolMessage.requestId");
  requireString(record.turnId, "toolMessage.turnId");
  requireString(record.operation, "toolMessage.operation");

  if (record.type === "tool-request") {
    requireRecord(record.arguments, "toolMessage.arguments");
    return clone(record);
  }

  if (record.type !== "tool-result") {
    fail("toolMessage.type", 'must be "tool-request" or "tool-result"');
  }
  if (!TOOL_STATUSES.has(record.status)) {
    fail(
      "toolMessage.status",
      `must be one of ${[...TOOL_STATUSES].join(", ")}`,
    );
  }
  validateEffects(
    record.confirmedEffects ?? [],
    "toolMessage.confirmedEffects",
    { incomplete: false },
  );
  validateEffects(
    record.incompleteEffects ?? [],
    "toolMessage.incompleteEffects",
    { incomplete: true },
  );
  if (record.status === "failed" || record.status === "rejected") {
    requireString(record.error, "toolMessage.error");
  }
  if (
    record.status === "incomplete" &&
    (record.incompleteEffects?.length ?? 0) === 0
  ) {
    fail(
      "toolMessage.incompleteEffects",
      "must describe remaining work for an incomplete result",
    );
  }

  return {
    ...record,
    confirmedEffects: cloneArray(record.confirmedEffects ?? []),
    incompleteEffects: cloneArray(record.incompleteEffects ?? []),
  };
}

function validateTurnIdentity(record, path = "turn") {
  requireString(record.turnId, `${path}.turnId`);
  if (!TURN_MODES.has(record.mode)) {
    fail(
      `${path}.mode`,
      `must be one of ${[...TURN_MODES].join(", ")}`,
    );
  }
  requireTimestamp(record.timestamp, `${path}.timestamp`);
}

function validateSnapshot(snapshot, path) {
  requireRecord(snapshot, path);
  requireString(snapshot.id, `${path}.id`);
  requireTimestamp(snapshot.capturedAt, `${path}.capturedAt`);
  requireEqual(snapshot.complete, true, `${path}.complete`);
}

function validateToolChannel(channel, path) {
  requireRecord(channel, path);
  requireEqual(channel.transport, "mcp-stdio", `${path}.transport`);
  requireString(channel.server, `${path}.server`);
  requireStringArray(channel.allowedOperations, `${path}.allowedOperations`, {
    nonEmpty: true,
  });
  if (
    new Set(channel.allowedOperations).size !==
    channel.allowedOperations.length
  ) {
    fail(`${path}.allowedOperations`, "must not contain duplicates");
  }
}

function validateActionTarget(action, path) {
  const targetPath = `${path}.target`;
  requireRecord(action.target, targetPath);

  switch (action.kind) {
    case "field-update":
      requireString(action.target.itemId, `${targetPath}.itemId`);
      requireString(action.target.field, `${targetPath}.field`);
      requireOwn(action.target, "value", `${targetPath}.value`);
      if (action.target.value === undefined) {
        fail(`${targetPath}.value`, "must be JSON-serializable");
      }
      break;
    case "canonical-reorder":
      requireStringArray(
        action.target.orderedItemIds,
        `${targetPath}.orderedItemIds`,
        { nonEmpty: true },
      );
      if (
        new Set(action.target.orderedItemIds).size !==
        action.target.orderedItemIds.length
      ) {
        fail(`${targetPath}.orderedItemIds`, "must not contain duplicates");
      }
      break;
    case "relative-precedence":
      requireString(action.target.beforeItemId, `${targetPath}.beforeItemId`);
      requireString(action.target.afterItemId, `${targetPath}.afterItemId`);
      if (action.target.beforeItemId === action.target.afterItemId) {
        fail(targetPath, "must reference two different items");
      }
      break;
    case "issue-create":
      requireString(action.target.repository, `${targetPath}.repository`);
      requireString(action.target.title, `${targetPath}.title`);
      if (action.target.body !== undefined) {
        requireString(action.target.body, `${targetPath}.body`);
      }
      requireString(action.target.workstream, `${targetPath}.workstream`);
      if (!["human", "agent"].includes(action.target.owner)) {
        fail(`${targetPath}.owner`, "must be human or agent");
      }
      if (!["urgent", "high", "normal", "low"].includes(action.target.priority)) {
        fail(
          `${targetPath}.priority`,
          "must be urgent, high, normal, or low",
        );
      }
      if (
        !["manual", "full-auto", "agent-reviewer"].includes(
          action.target.autonomy,
        )
      ) {
        fail(
          `${targetPath}.autonomy`,
          "must be manual, full-auto, or agent-reviewer",
        );
      }
      requireStringArray(
        action.target.requirements,
        `${targetPath}.requirements`,
      );
      if (
        new Set(action.target.requirements).size !==
        action.target.requirements.length
      ) {
        fail(`${targetPath}.requirements`, "must not contain duplicates");
      }
      for (const [index, requirement] of action.target.requirements.entries()) {
        if (
          !/^[A-Za-z][A-Za-z0-9-]*:[A-Za-z0-9_.\/-]+$/.test(requirement)
        ) {
          fail(
            `${targetPath}.requirements[${index}]`,
            "must use kind:value capability syntax",
          );
        }
      }
      break;
    case "issue-comment":
      requireString(action.target.issueUrl, `${targetPath}.issueUrl`);
      requireString(action.target.body, `${targetPath}.body`);
      break;
    case "needs-human":
      requireString(action.target.issueUrl, `${targetPath}.issueUrl`);
      requireString(action.target.prompt, `${targetPath}.prompt`);
      if (!["question", "approval", "local-ui"].includes(action.target.kind)) {
        fail(
          `${targetPath}.kind`,
          "must be question, approval, or local-ui",
        );
      }
      break;
  }
}

function validateEvidenceStatements(values, path) {
  for (const [index, value] of requireArray(values, path).entries()) {
    requireRecord(value, `${path}[${index}]`);
    requireString(value.statement, `${path}[${index}].statement`);
    validateCitations(value.citations, `${path}[${index}].citations`, {
      nonEmpty: true,
    });
  }
}

function validateCitations(values, path, { nonEmpty = false } = {}) {
  const citations = requireArray(values, path, { nonEmpty });
  for (const [index, citation] of citations.entries()) {
    const citationPath = `${path}[${index}]`;
    requireRecord(citation, citationPath);
    if (!CITATION_KINDS.has(citation.kind)) {
      fail(
        `${citationPath}.kind`,
        `must be one of ${[...CITATION_KINDS].join(", ")}`,
      );
    }
    requireString(citation.locator, `${citationPath}.locator`);
    if (citation.revision !== undefined) {
      requireString(citation.revision, `${citationPath}.revision`);
    }
    if (citation.label !== undefined) {
      requireString(citation.label, `${citationPath}.label`);
    }
  }
}

function validateActionOutcomes(values, path, { rejected }) {
  for (const [index, value] of requireArray(values, path).entries()) {
    const outcomePath = `${path}[${index}]`;
    requireRecord(value, outcomePath);
    requireString(value.actionId, `${outcomePath}.actionId`);
    requireString(
      rejected ? value.reason : value.summary,
      `${outcomePath}.${rejected ? "reason" : "summary"}`,
    );
  }
}

function validateEffects(values, path, { incomplete }) {
  for (const [index, value] of requireArray(values, path).entries()) {
    const effectPath = `${path}[${index}]`;
    requireRecord(value, effectPath);
    requireString(value.actionId, `${effectPath}.actionId`);
    requireString(value.summary, `${effectPath}.summary`);
    validateCitations(value.citations ?? [], `${effectPath}.citations`);
    if (incomplete) {
      requireStringArray(
        value.remainingSteps,
        `${effectPath}.remainingSteps`,
        { nonEmpty: true },
      );
    }
  }
}

function requireVersion(value, path) {
  if (value !== PROTOCOL_VERSION) {
    fail(path, `must be supported version ${PROTOCOL_VERSION}`);
  }
}

function requireRecord(value, path) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(path, "must be an object");
  }
}

function requireNonEmptyRecord(value, path) {
  requireRecord(value, path);
  if (Object.keys(value).length === 0) {
    fail(path, "must describe the mutable state expected before application");
  }
}

function requireArray(value, path, { nonEmpty = false } = {}) {
  if (!Array.isArray(value) || (nonEmpty && value.length === 0)) {
    fail(path, `must be ${nonEmpty ? "a non-empty" : "an"} array`);
  }
  return value;
}

function requireString(value, path) {
  if (typeof value !== "string" || !value.trim()) {
    fail(path, "must be a non-empty string");
  }
}

function requireStringArray(value, path, options) {
  const values = requireArray(value, path, options);
  for (const [index, entry] of values.entries()) {
    requireString(entry, `${path}[${index}]`);
  }
}

function requireTimestamp(value, path) {
  requireString(value, path);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
      value,
    ) ||
    !Number.isFinite(Date.parse(value))
  ) {
    fail(path, "must be an RFC 3339 timestamp");
  }
}

function requireConfidence(value, path) {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1
  ) {
    fail(path, "must be a number from 0 through 1");
  }
}

function requireEqual(value, expected, path) {
  if (value !== expected) {
    fail(path, `must be ${JSON.stringify(expected)}`);
  }
}

function requireOwn(record, key, path) {
  if (!Object.hasOwn(record, key)) {
    fail(path, "must be present");
  }
}

function clone(value) {
  return structuredClone(value);
}

function cloneArray(values) {
  return values.map(clone);
}

function fail(path, correction) {
  throw new TypeError(
    `${path} ${correction}; correct the protocol record before retrying`,
  );
}

export const PAN_PROTOCOL_VERSION = PROTOCOL_VERSION;
