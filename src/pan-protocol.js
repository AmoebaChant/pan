const LEGACY_ACTION_VERSION = 1;
const ACTION_VERSION = 2;
const LEGACY_ACTION_KINDS = new Set([
  "field-update",
  "canonical-reorder",
  "relative-precedence",
  "issue-create",
  "issue-comment",
  "needs-human",
  "no-op",
]);
const ACTION_KINDS = new Set([...LEGACY_ACTION_KINDS, "workstream-update"]);
const GROUP_SEMANTICS = new Set(["independent", "all-or-none"]);
const CITATION_KINDS = new Set([
  "issue",
  "issue-comment",
  "project-field",
  "workstream",
  "runner",
  "domain-record",
]);
export function validatePanAction(record, path = "action") {
  requireRecord(record, path);
  if (record.version === LEGACY_ACTION_VERSION) {
    return validateLegacyPanAction(record, path);
  }
  if (record.version !== ACTION_VERSION) {
    fail(
      `${path}.version`,
      `must be supported version ${LEGACY_ACTION_VERSION} or ${ACTION_VERSION}`,
    );
  }
  return validateVersionTwoPanAction(record, path);
}

export function validatePanActionGroup(record, path = "actionGroup") {
  requireRecord(record, path);
  rejectUnexpectedKeys(
    record,
    new Set(["version", "groupId", "semantics", "actions"]),
    path,
  );
  if (record.version !== ACTION_VERSION) {
    fail(`${path}.version`, `must be supported version ${ACTION_VERSION}`);
  }
  requireString(record.groupId, `${path}.groupId`);
  if (!GROUP_SEMANTICS.has(record.semantics)) {
    fail(
      `${path}.semantics`,
      `must be one of ${[...GROUP_SEMANTICS].join(", ")}`,
    );
  }
  const actions = requireArray(record.actions, `${path}.actions`, {
    nonEmpty: true,
  }).map((action, index) =>
    validatePanAction(action, `${path}.actions[${index}]`),
  );
  if (actions.some((action) => action.version !== ACTION_VERSION)) {
    fail(`${path}.actions`, "must contain only version 2 actions");
  }
  requireUnique(
    actions.map((action) => action.actionId),
    `${path}.actions action IDs`,
  );
  requireUnique(
    actions
      .filter((action) => action.kind !== "no-op")
      .map((action) => action.idempotencyKey),
    `${path}.actions idempotency keys`,
  );
  if (record.semantics === "all-or-none") {
    fail(
      `${path}.semantics`,
      "all-or-none groups are not supported because PAN external operations are not transactional",
    );
  }
  return clone({ ...record, actions });
}

export function isHostlessLiveAction(action) {
  return action?.version === ACTION_VERSION;
}

function validateLegacyPanAction(record, path) {
  requireString(record.actionId, `${path}.actionId`);
  if (!LEGACY_ACTION_KINDS.has(record.kind)) {
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

function validateVersionTwoPanAction(record, path) {
  rejectUnexpectedKeys(
    record,
    new Set([
      "version",
      "actionId",
      "kind",
      "domain",
      "evidence",
      "rationale",
      "confidence",
      "idempotencyKey",
      "expectedState",
      "target",
      "recommendation",
    ]),
    path,
  );
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
    for (const field of ["domain", "idempotencyKey", "expectedState", "target"]) {
      if (record[field] !== undefined) {
        fail(path, `no-op actions must not include ${field}`);
      }
    }
    return clone(record);
  }

  validateActionDomain(record.domain, `${path}.domain`);
  requireString(record.idempotencyKey, `${path}.idempotencyKey`);
  validateExpectedState(record.expectedState, record, path);
  validateActionTarget(record, path, { strict: true });
  return clone(record);
}

function validateActionTarget(action, path, { strict = false } = {}) {
  const targetPath = `${path}.target`;
  requireRecord(action.target, targetPath);

  switch (action.kind) {
    case "field-update":
      if (strict) {
        rejectUnexpectedKeys(
          action.target,
          new Set(["itemId", "field", "value"]),
          targetPath,
        );
      }
      requireString(action.target.itemId, `${targetPath}.itemId`);
      requireString(action.target.field, `${targetPath}.field`);
      requireOwn(action.target, "value", `${targetPath}.value`);
      if (action.target.value === undefined) {
        fail(`${targetPath}.value`, "must be JSON-serializable");
      }
      break;
    case "canonical-reorder":
      if (strict) {
        rejectUnexpectedKeys(
          action.target,
          new Set(["orderedItemIds"]),
          targetPath,
        );
      }
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
      if (strict) {
        rejectUnexpectedKeys(
          action.target,
          new Set(["beforeItemId", "afterItemId"]),
          targetPath,
        );
      }
      requireString(action.target.beforeItemId, `${targetPath}.beforeItemId`);
      requireString(action.target.afterItemId, `${targetPath}.afterItemId`);
      if (action.target.beforeItemId === action.target.afterItemId) {
        fail(targetPath, "must reference two different items");
      }
      break;
    case "issue-create":
      if (strict) {
        rejectUnexpectedKeys(
          action.target,
          new Set(["repository", "title", "body", "workstream"]),
          targetPath,
        );
      }
      requireString(action.target.repository, `${targetPath}.repository`);
      requireString(action.target.title, `${targetPath}.title`);
      if (action.target.body !== undefined) {
        requireString(action.target.body, `${targetPath}.body`);
      }
      if (action.target.workstream !== undefined) {
        requireString(action.target.workstream, `${targetPath}.workstream`);
      }
      break;
    case "issue-comment":
      if (strict) {
        rejectUnexpectedKeys(
          action.target,
          new Set(["issueUrl", "body"]),
          targetPath,
        );
      }
      requireString(action.target.issueUrl, `${targetPath}.issueUrl`);
      requireString(action.target.body, `${targetPath}.body`);
      break;
    case "needs-human":
      if (strict) {
        rejectUnexpectedKeys(
          action.target,
          new Set(["issueUrl", "prompt", "kind"]),
          targetPath,
        );
      }
      requireString(action.target.issueUrl, `${targetPath}.issueUrl`);
      requireString(action.target.prompt, `${targetPath}.prompt`);
      if (!["question", "approval", "local-ui"].includes(action.target.kind)) {
        fail(
          `${targetPath}.kind`,
          "must be question, approval, or local-ui",
        );
      }
      break;
    case "workstream-update":
      if (strict) {
        rejectUnexpectedKeys(
          action.target,
          new Set(["preparedOperationId", "workstreamPath"]),
          targetPath,
        );
      }
      requireString(
        action.target.preparedOperationId,
        `${targetPath}.preparedOperationId`,
      );
      requireString(action.target.workstreamPath, `${targetPath}.workstreamPath`);
      break;
  }
}

function validateActionDomain(domain, path) {
  requireRecord(domain, path);
  rejectUnexpectedKeys(
    domain,
    new Set(["repository", "projectOwner", "projectNumber"]),
    path,
  );
  requireString(domain.repository, `${path}.repository`);
  requireString(domain.projectOwner, `${path}.projectOwner`);
  if (!Number.isInteger(domain.projectNumber) || domain.projectNumber < 1) {
    fail(`${path}.projectNumber`, "must be a positive integer");
  }
}

function validateExpectedState(expectedState, action, path) {
  const expectedPath = `${path}.expectedState`;
  requireNonEmptyRecord(expectedState, expectedPath);
  const allowed = new Set([
    "projectField",
    "projectOrder",
    "projectMembership",
    "issueCatalog",
    "issue",
    "workstream",
    "attention",
    "leadership",
  ]);
  rejectUnexpectedKeys(expectedState, allowed, expectedPath);

  if (expectedState.projectField !== undefined) {
    validateProjectFieldState(
      expectedState.projectField,
      `${expectedPath}.projectField`,
    );
  }
  if (expectedState.projectOrder !== undefined) {
    validateProjectOrderState(
      expectedState.projectOrder,
      `${expectedPath}.projectOrder`,
    );
  }
  if (expectedState.projectMembership !== undefined) {
    validateProjectMembershipState(
      expectedState.projectMembership,
      `${expectedPath}.projectMembership`,
    );
  }
  if (expectedState.issueCatalog !== undefined) {
    validateRevisionState(
      expectedState.issueCatalog,
      `${expectedPath}.issueCatalog`,
    );
  }
  if (expectedState.issue !== undefined) {
    validateIssueState(expectedState.issue, `${expectedPath}.issue`);
  }
  if (expectedState.workstream !== undefined) {
    validateWorkstreamState(
      expectedState.workstream,
      `${expectedPath}.workstream`,
    );
  }
  if (expectedState.attention !== undefined) {
    validateAttentionState(expectedState.attention, `${expectedPath}.attention`);
  }
  if (expectedState.leadership !== undefined) {
    validateLeadershipState(
      expectedState.leadership,
      `${expectedPath}.leadership`,
    );
  }

  const required = {
    "field-update": ["projectField", "leadership"],
    "canonical-reorder": ["projectOrder", "leadership"],
    "relative-precedence": ["projectOrder", "leadership"],
    "issue-create": ["issueCatalog", "leadership"],
    "issue-comment": ["issueCatalog", "issue", "leadership"],
    "needs-human": ["issue", "attention", "leadership"],
    "workstream-update": ["workstream", "leadership"],
  }[action.kind];
  const unexpected = Object.keys(expectedState).filter(
    (key) => !required.includes(key),
  );
  if (unexpected.length > 0) {
    fail(
      expectedPath,
      `must only describe resources used by ${action.kind}`,
    );
  }
  for (const key of required) {
    if (expectedState[key] === undefined) {
      fail(expectedPath, `must include ${key} for ${action.kind}`);
    }
  }

  validateExpectedTargetConsistency(expectedState, action, path);
}

function validateProjectFieldState(state, path) {
  requireRecord(state, path);
  rejectUnexpectedKeys(state, new Set(["itemId", "field", "value", "revision"]), path);
  requireString(state.itemId, `${path}.itemId`);
  requireString(state.field, `${path}.field`);
  requireOwn(state, "value", `${path}.value`);
  if (state.value === undefined) {
    fail(`${path}.value`, "must be JSON-serializable");
  }
  requireString(state.revision, `${path}.revision`);
}

function validateProjectOrderState(state, path) {
  requireRecord(state, path);
  rejectUnexpectedKeys(state, new Set(["itemIds", "revision"]), path);
  requireStringArray(state.itemIds, `${path}.itemIds`, { nonEmpty: true });
  requireUnique(state.itemIds, `${path}.itemIds`);
  requireString(state.revision, `${path}.revision`);
}

function validateProjectMembershipState(state, path) {
  requireRecord(state, path);
  rejectUnexpectedKeys(state, new Set(["issueUrl", "present", "revision"]), path);
  requireString(state.issueUrl, `${path}.issueUrl`);
  if (typeof state.present !== "boolean") {
    fail(`${path}.present`, "must be a boolean");
  }
  requireString(state.revision, `${path}.revision`);
}

function validateRevisionState(state, path) {
  requireRecord(state, path);
  rejectUnexpectedKeys(state, new Set(["revision"]), path);
  requireString(state.revision, `${path}.revision`);
}

function validateIssueState(state, path) {
  requireRecord(state, path);
  rejectUnexpectedKeys(state, new Set(["url", "state", "revision"]), path);
  requireString(state.url, `${path}.url`);
  requireString(state.state, `${path}.state`);
  requireString(state.revision, `${path}.revision`);
}

function validateWorkstreamState(state, path) {
  requireRecord(state, path);
  rejectUnexpectedKeys(
    state,
    new Set(["path", "blobRevision", "baseRevision"]),
    path,
  );
  requireString(state.path, `${path}.path`);
  requireString(state.blobRevision, `${path}.blobRevision`);
  requireString(state.baseRevision, `${path}.baseRevision`);
}

function validateAttentionState(state, path) {
  requireRecord(state, path);
  rejectUnexpectedKeys(state, new Set(["recordId", "revision"]), path);
  requireString(state.recordId, `${path}.recordId`);
  requireString(state.revision, `${path}.revision`);
}

function validateLeadershipState(state, path) {
  requireRecord(state, path);
  rejectUnexpectedKeys(state, new Set(["generation"]), path);
  requireString(state.generation, `${path}.generation`);
}

function validateExpectedTargetConsistency(expectedState, action, path) {
  if (action.kind === "field-update") {
    const state = expectedState.projectField;
    if (
      state.itemId !== action.target.itemId ||
      state.field !== action.target.field
    ) {
      fail(
        `${path}.expectedState.projectField`,
        "must identify the same item and field as the target",
      );
    }
  }
  if (action.kind === "canonical-reorder") {
    const expected = expectedState.projectOrder.itemIds;
    const proposed = action.target.orderedItemIds;
    if (
      expected.length !== proposed.length ||
      expected.some((itemId) => !proposed.includes(itemId))
    ) {
      fail(
        `${path}.expectedState.projectOrder.itemIds`,
        "must name exactly the Project members being reordered",
      );
    }
  }
  if (action.kind === "relative-precedence") {
    const members = expectedState.projectOrder.itemIds;
    for (const itemId of [
      action.target.beforeItemId,
      action.target.afterItemId,
    ]) {
      if (!members.includes(itemId)) {
        fail(
          `${path}.expectedState.projectOrder.itemIds`,
          "must include both relative-precedence items",
        );
      }
    }
  }
  if (action.kind === "issue-comment" || action.kind === "needs-human") {
    if (expectedState.issue.url !== action.target.issueUrl) {
      fail(
        `${path}.expectedState.issue.url`,
        "must match the target issue URL",
      );
    }
  }
  if (
    action.kind === "workstream-update" &&
    expectedState.workstream.path !== action.target.workstreamPath
  ) {
    fail(
      `${path}.expectedState.workstream.path`,
      "must match the target workstream path",
    );
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

function requireOwn(record, key, path) {
  if (!Object.hasOwn(record, key)) {
    fail(path, "must be present");
  }
}

function rejectUnexpectedKeys(record, allowed, path) {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      fail(`${path}.${key}`, "is not supported");
    }
  }
}

function requireUnique(values, path) {
  if (new Set(values).size !== values.length) {
    fail(path, "must not contain duplicates");
  }
}

function clone(value) {
  return structuredClone(value);
}

function fail(path, correction) {
  throw new TypeError(
    `${path} ${correction}; correct the protocol record before retrying`,
  );
}

export const PAN_ACTION_VERSION = ACTION_VERSION;
export const PAN_LEGACY_ACTION_VERSION = LEGACY_ACTION_VERSION;
export const PAN_ACTION_GROUP_SEMANTICS = Object.freeze([...GROUP_SEMANTICS]);
