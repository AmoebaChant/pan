import { createHash } from "node:crypto";

const TRIAGE_DECISION_PREFIX = "<!-- pan:triage-decision:";
const TRIAGE_APPLIED_PREFIX = "<!-- pan:triage-applied:";
const AUDIT_FIELDS = new Set([
  "status",
  "owner",
  "priority",
  "autonomy",
  "workstream",
  "requirements",
]);
const EVIDENCE_KINDS = new Set([
  "issue",
  "issue-comment",
  "project-field",
  "runner",
  "workstream",
]);
const REQUIREMENT_PATTERN =
  /^[A-Za-z][A-Za-z0-9-]*:[A-Za-z0-9_.\/-]+$/;

export function triageDecisionMarker(record) {
  const digest = createHash("sha256")
    .update(stableStringify(record))
    .digest("hex");
  return `${TRIAGE_DECISION_PREFIX}${digest} -->`;
}

export function formatTriageDecision(record) {
  validateDecision(record);
  return [
    triageDecisionMarker(record),
    "### PAN triage decision",
    "",
    "```json",
    JSON.stringify({ version: 1, ...record }, null, 2),
    "```",
  ].join("\n");
}

export function triageAppliedMarker(record) {
  return triageDecisionMarker(record).replace(
    TRIAGE_DECISION_PREFIX,
    TRIAGE_APPLIED_PREFIX,
  );
}

export function formatTriageApplied(record) {
  validateDecision(record);
  return [
    triageAppliedMarker(record),
    "### PAN triage applied",
    "",
    "```json",
    JSON.stringify({ version: 1, ...record }, null, 2),
    "```",
  ].join("\n");
}

export function hasTriageDecision(comments, marker) {
  return comments.some((comment) => (comment.body ?? "").includes(marker));
}

export function hasTriageApplied(comments, marker) {
  return comments.some((comment) => (comment.body ?? "").includes(marker));
}

export function latestAppliedTriageDecision(comments, field) {
  let latest;
  for (const comment of comments) {
    const body = comment.body ?? "";
    if (!body.includes(TRIAGE_APPLIED_PREFIX)) {
      continue;
    }
    const record = parseRecord(body, "applied");
    if (record.field === field) {
      latest = record;
    }
  }
  return latest;
}

export function unappliedTriageDecisions(comments) {
  const applied = new Set();
  const decisions = [];
  for (const comment of comments) {
    const body = comment.body ?? "";
    if (body.includes(TRIAGE_APPLIED_PREFIX)) {
      applied.add(triageDecisionMarker(parseRecord(body, "applied")));
    } else if (body.includes(TRIAGE_DECISION_PREFIX)) {
      const record = parseRecord(body, "decision");
      decisions.push(record);
    }
  }
  return decisions.filter(
    (record) => !applied.has(triageDecisionMarker(record)),
  );
}

function parseRecord(body, kind) {
  const prefix =
    kind === "applied" ? TRIAGE_APPLIED_PREFIX : TRIAGE_DECISION_PREFIX;
  const marker = body.match(
    new RegExp(`${escapePattern(prefix)}([a-f0-9]{64}) -->`, "i"),
  );
  if (!marker) {
    throw new Error(`PAN triage ${kind} comment has an invalid marker`);
  }
  const fence = body.match(/```json\s*([\s\S]*?)\s*```/i);
  if (!fence) {
    throw new Error(`PAN triage ${kind} comment has no JSON record`);
  }
  let parsed;
  try {
    parsed = JSON.parse(fence[1]);
  } catch (error) {
    throw new Error(`PAN triage ${kind} comment contains invalid JSON`, {
      cause: error,
    });
  }
  const { version, ...record } = parsed;
  if (version !== 1) {
    throw new Error(`PAN triage ${kind} comment has an unsupported version`);
  }
  validateDecision(record);
  const expected =
    kind === "applied"
      ? triageAppliedMarker(record)
      : triageDecisionMarker(record);
  if (!expected.includes(marker[1].toLowerCase())) {
    throw new Error(`PAN triage ${kind} comment marker does not match its record`);
  }
  return record;
}

function validateDecision(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new TypeError("triage decision must be an object");
  }
  const unknown = Object.keys(record).filter(
    (key) =>
      !["item", "field", "value", "reason", "rationale", "evidence"].includes(
        key,
      ),
  );
  if (unknown.length > 0) {
    throw new TypeError(
      `triage decision contains unknown fields: ${unknown.join(", ")}`,
    );
  }
  if (
    !/^https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/\d+$/.test(
      record.item ?? "",
    )
  ) {
    throw new TypeError("triage decision item must be a GitHub Issue URL");
  }
  if (
    !AUDIT_FIELDS.has(record.field) ||
    record.value === undefined ||
    record.value === null ||
    !record.rationale?.trim()
  ) {
    throw new TypeError(
      "triage decision requires a field, value, and rationale",
    );
  }
  validateFieldValue(record.field, record.value);
  if (
    record.reason !== undefined &&
    (record.field !== "status" ||
      record.value !== "blocked" ||
      record.reason !== "runner-unavailable")
  ) {
    throw new TypeError("triage decision reason is invalid");
  }
  if (
    record.field === "status" &&
    record.value === "blocked" &&
    record.reason !== "runner-unavailable"
  ) {
    throw new TypeError("blocked triage decisions require a runner reason");
  }
  if (
    !Array.isArray(record.evidence) ||
    record.evidence.length === 0 ||
    record.evidence.some(
      (entry) =>
        !entry ||
        typeof entry !== "object" ||
        Array.isArray(entry) ||
        !EVIDENCE_KINDS.has(entry.kind) ||
        typeof entry.locator !== "string" ||
        !entry.locator.trim() ||
        (entry.label !== undefined &&
          (typeof entry.label !== "string" || !entry.label.trim())) ||
        Object.keys(entry).some(
          (key) => !["kind", "locator", "label"].includes(key),
        ),
    )
  ) {
    throw new TypeError("triage decision requires durable evidence");
  }
}

function validateFieldValue(field, value) {
  const allowed = {
    status: [
      "untriaged",
      "needs-detail",
      "ready",
      "in-progress",
      "in-review",
      "done",
      "blocked",
    ],
    owner: ["unassigned", "human", "agent"],
    priority: ["urgent", "high", "normal", "low"],
    autonomy: ["manual", "full-auto", "agent-reviewer"],
  }[field];
  if (allowed && !allowed.includes(value)) {
    throw new TypeError(`triage decision ${field} value is invalid`);
  }
  if (
    field === "workstream" &&
    (typeof value !== "string" ||
      !/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(value))
  ) {
    throw new TypeError("triage decision workstream value is invalid");
  }
  if (
    field === "requirements" &&
    (!Array.isArray(value) ||
      value.some(
        (requirement) =>
          typeof requirement !== "string" ||
          !REQUIREMENT_PATTERN.test(requirement),
      ))
  ) {
    throw new TypeError("triage decision requirements value is invalid");
  }
}

function escapePattern(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${stableStringify(value[key])}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
