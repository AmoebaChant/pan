import { randomUUID } from "node:crypto";
import path from "node:path";

import { ActionPolicy } from "./action-policy.js";
import {
  validatePanAction,
  validatePanFinalResponse,
} from "./pan-protocol.js";

const DEFAULT_OPERATIONS = Object.freeze([
  "read_portfolio",
  "read_workstream",
  "read_issue",
  "read_runner_availability",
  "propose_actions",
]);
const SUPPORTED_FIELDS = new Set([
  "status",
  "owner",
  "priority",
  "autonomy",
  "requirements",
  "workstream",
  "rationale",
  "reviewAt",
]);

export class ReasoningService {
  constructor({
    snapshotSource,
    agentClient,
    actionPolicy = new ActionPolicy(),
    manualConstraintSource,
    now = () => new Date(),
    idFactory = randomUUID,
    toolServer = "pan-tools",
    allowedOperations = DEFAULT_OPERATIONS,
  }) {
    requireMethod(snapshotSource, "build", "snapshotSource");
    requireMethod(agentClient, "review", "agentClient");
    if (!actionPolicy?.assess || !actionPolicy?.authority) {
      throw new TypeError(
        "actionPolicy must provide assess() and an authority summary",
      );
    }
    if (manualConstraintSource !== undefined) {
      requireMethod(manualConstraintSource, "read", "manualConstraintSource");
    }
    if (
      !Array.isArray(allowedOperations) ||
      allowedOperations.length === 0 ||
      allowedOperations.some(
        (operation) =>
          typeof operation !== "string" || !operation.trim(),
      )
    ) {
      throw new TypeError(
        "allowedOperations must contain operation names",
      );
    }
    if (
      new Set(allowedOperations).size !== allowedOperations.length
    ) {
      throw new TypeError("allowedOperations must not contain duplicates");
    }

    this.snapshotSource = snapshotSource;
    this.agentClient = agentClient;
    this.actionPolicy = actionPolicy;
    this.manualConstraintSource = manualConstraintSource;
    this.now = now;
    this.idFactory = idFactory;
    this.toolServer = toolServer;
    this.allowedOperations = Object.freeze([...allowedOperations]);
  }

  async review({ dryRun = true, signal } = {}) {
    if (dryRun !== true) {
      throw new TypeError(
        "ReasoningService currently supports dry-run reviews only",
      );
    }
    let snapshot;
    try {
      snapshot = await this.snapshotSource.build();
    } catch (error) {
      throw new ReasoningTurnError(
        "snapshot-failed",
        "Unable to build complete portfolio evidence",
        { cause: error },
      );
    }
    requireCompleteSnapshot(snapshot);
    let manualConstraints;
    try {
      manualConstraints = this.manualConstraintSource
        ? await this.manualConstraintSource.read(snapshot)
        : [];
    } catch (error) {
      throw new ReasoningTurnError(
        "manual-constraints-failed",
        "Unable to read current manual ordering constraints",
        { cause: error },
      );
    }
    if (!Array.isArray(manualConstraints)) {
      throw new ReasoningTurnError(
        "invalid-manual-constraints",
        "Manual constraints source must return an array",
      );
    }

    const turn = this.#buildTurn(snapshot, manualConstraints);
    let agentResult;
    try {
      agentResult = await this.agentClient.review(turn, {
        signal,
        inlinePortfolio: true,
      });
    } catch (error) {
      throw new ReasoningTurnError(
        "agent-failed",
        `PAN reasoning turn ${turn.turnId} failed`,
        {
          cause: error,
          turnId: turn.turnId,
          detail: error.state,
          confirmedSideEffects: error.confirmedSideEffects,
        },
      );
    }

    let response;
    try {
      response = validatePanFinalResponse(agentResult.response);
    } catch (error) {
      throw new ReasoningTurnError(
        "invalid-response",
        `PAN reasoning turn ${turn.turnId} returned an invalid final response`,
        { cause: error, turnId: turn.turnId },
      );
    }
    validateResponseIdentity(response, turn);
    validateDryRunEffects(response, agentResult.toolMessages ?? []);

    const evidence = buildEvidenceIndex(snapshot, manualConstraints);
    validateResponseCitations(response, evidence);
    const classifications = validateClassifications(
      response.classifications,
      snapshot,
      evidence,
    );
    const recommendations = validateRecommendations(
      response,
      snapshot,
      evidence,
    );
    const proposals = validateProposals(
      response.proposedActions,
      snapshot,
      evidence,
      this.actionPolicy,
    );

    return Object.freeze({
      status: "dry-run",
      dryRun: true,
      turnId: turn.turnId,
      sessionId: agentResult.sessionId,
      snapshotId: snapshot.id,
      capturedAt: snapshot.capturedAt,
      recommendation: response.recommendation,
      classifications,
      humanNextAction: recommendations.humanNextAction,
      agentQueueRecommendation:
        recommendations.agentQueueRecommendation,
      facts: response.facts,
      interpretations: response.interpretations,
      assumptions: response.assumptions,
      uncertainties: response.uncertainties,
      citations: response.citations,
      acceptedProposals: proposals.accepted,
      rejectedProposals: proposals.rejected,
      agentRejectedActions: response.rejectedActions,
      toolMessages: agentResult.toolMessages ?? [],
    });
  }

  #buildTurn(snapshot, manualConstraints) {
    const timestamp = this.now().toISOString();
    return {
      version: 1,
      type: "request",
      turnId: this.idFactory(),
      mode: "autonomous-review",
      timestamp,
      snapshot: {
        id: snapshot.id,
        capturedAt: snapshot.capturedAt,
        complete: true,
      },
      toolChannel: {
        transport: "mcp-stdio",
        server: this.toolServer,
        allowedOperations: [...this.allowedOperations],
      },
      portfolio: {
        capturedAt: timestamp,
        canonicalOrder: [...snapshot.project.items],
        dossiers: snapshot.dossiers,
        manualConstraints,
        authority: this.actionPolicy.authority,
      },
      responseRequirements: {
        classifications:
          "Classify every canonical item ID exactly once with durable citations.",
        humanNextAction:
          "When human-actionable work exists, provide one clear recommendation with citations.",
        agentQueueRecommendation:
          "When compatible agent-actionable work exists, provide one ordered queue recommendation with citations.",
      },
    };
  }
}

export class ReasoningTurnError extends Error {
  constructor(state, message, options = {}) {
    super(message, { cause: options.cause });
    this.name = "ReasoningTurnError";
    this.state = state;
    this.turnId = options.turnId;
    this.detail = options.detail;
    this.confirmedSideEffects =
      options.confirmedSideEffects === true;
  }
}

function requireCompleteSnapshot(snapshot) {
  if (
    !snapshot ||
    snapshot.complete !== true ||
    snapshot.usableForMutation !== true ||
    !snapshot.id ||
    !snapshot.capturedAt ||
    !Array.isArray(snapshot.dossiers) ||
    !Array.isArray(snapshot.project?.items)
  ) {
    throw new ReasoningTurnError(
      "incomplete-snapshot",
      "Complete portfolio evidence is required for a reasoning review",
    );
  }
}

function validateResponseIdentity(response, turn) {
  if (
    response.turnId !== turn.turnId ||
    response.mode !== turn.mode ||
    response.snapshotId !== turn.snapshot.id
  ) {
    throw new ReasoningTurnError(
      "unstable-response",
      "PAN final response does not match the requested turn and snapshot",
      { turnId: turn.turnId },
    );
  }
}

function validateDryRunEffects(response, toolMessages) {
  const toolEffects = toolMessages.flatMap(
    (message) => [
      ...(message.confirmedEffects ?? []),
      ...(message.incompleteEffects ?? []),
    ],
  );
  if (
    response.appliedActions.length > 0 ||
    response.effects.confirmed.length > 0 ||
    response.effects.incomplete.length > 0 ||
    toolEffects.length > 0
  ) {
    throw new ReasoningTurnError(
      "dry-run-side-effect",
      "A dry-run response must not report applied or incomplete effects",
      { turnId: response.turnId },
    );
  }
}

function validateClassifications(values, snapshot, evidence) {
  if (!Array.isArray(values)) {
    throw responseError(
      "incomplete-classification",
      "Final response must include classifications",
    );
  }
  const expected = snapshot.project.items;
  const seen = new Set();
  for (const [index, value] of values.entries()) {
    requireRecord(value, `classifications[${index}]`);
    exactKeys(
      value,
      ["itemId", "classification", "rationale", "citations"],
      `classifications[${index}]`,
    );
    requireString(value.itemId, `classifications[${index}].itemId`);
    requireString(
      value.classification,
      `classifications[${index}].classification`,
    );
    requireString(
      value.rationale,
      `classifications[${index}].rationale`,
    );
    if (seen.has(value.itemId)) {
      throw responseError(
        "incomplete-classification",
        `Project item ${value.itemId} is classified more than once`,
      );
    }
    if (!expected.includes(value.itemId)) {
      throw responseError(
        "incomplete-classification",
        `Classification references unknown Project item ${value.itemId}`,
      );
    }
    validateCitations(
      value.citations,
      evidence,
      `classifications[${index}].citations`,
      { nonEmpty: true },
    );
    seen.add(value.itemId);
  }
  const missing = expected.filter((itemId) => !seen.has(itemId));
  if (missing.length > 0 || values.length !== expected.length) {
    throw responseError(
      "incomplete-classification",
      `Final response omitted Project items: ${missing.join(", ")}`,
    );
  }
  return values.map((value) => structuredClone(value));
}

function validateRecommendations(response, snapshot, evidence) {
  const humanCandidates = snapshot.dossiers.filter(isHumanCandidate);
  const agentCandidates = snapshot.dossiers.filter(isAgentCandidate);
  const humanNextAction = validateRecommendation(
    response.humanNextAction,
    "humanNextAction",
    humanCandidates,
    evidence,
  );
  const agentQueueRecommendation = validateAgentQueue(
    response.agentQueueRecommendation,
    agentCandidates,
    snapshot,
    evidence,
  );
  return { humanNextAction, agentQueueRecommendation };
}

function validateRecommendation(
  recommendation,
  name,
  candidates,
  evidence,
) {
  if (candidates.length === 0 && recommendation === undefined) {
    return undefined;
  }
  requireRecord(recommendation, name);
  exactKeys(
    recommendation,
    ["itemId", "recommendation", "citations"],
    name,
  );
  requireString(recommendation.itemId, `${name}.itemId`);
  requireString(recommendation.recommendation, `${name}.recommendation`);
  if (
    !candidates.some(
      (dossier) => dossier.item.id === recommendation.itemId,
    )
  ) {
    throw responseError(
      "invalid-recommendation",
      `${name}.itemId is not an eligible human next action`,
    );
  }
  validateCitations(
    recommendation.citations,
    evidence,
    `${name}.citations`,
    { nonEmpty: true },
  );
  return structuredClone(recommendation);
}

function validateAgentQueue(
  recommendation,
  candidates,
  snapshot,
  evidence,
) {
  if (candidates.length === 0 && recommendation === undefined) {
    return undefined;
  }
  requireRecord(recommendation, "agentQueueRecommendation");
  exactKeys(
    recommendation,
    ["orderedItemIds", "recommendation", "citations"],
    "agentQueueRecommendation",
  );
  requireString(
    recommendation.recommendation,
    "agentQueueRecommendation.recommendation",
  );
  if (
    !Array.isArray(recommendation.orderedItemIds) ||
    recommendation.orderedItemIds.length === 0 ||
    new Set(recommendation.orderedItemIds).size !==
      recommendation.orderedItemIds.length
  ) {
    throw responseError(
      "invalid-recommendation",
      "agentQueueRecommendation.orderedItemIds must be a non-empty unique array",
    );
  }
  const eligible = new Set(
    candidates.map((dossier) => dossier.item.id),
  );
  if (
    recommendation.orderedItemIds.length !== eligible.size ||
    recommendation.orderedItemIds.some(
      (itemId) => !eligible.has(itemId),
    )
  ) {
    throw responseError(
      "invalid-recommendation",
      "Agent queue contains an ineligible Project item",
    );
  }
  const canonical = snapshot.project.items;
  if (
    recommendation.orderedItemIds.some(
      (itemId, index, values) =>
        index > 0 &&
        canonical.indexOf(values[index - 1]) >
          canonical.indexOf(itemId),
    )
  ) {
    throw responseError(
      "invalid-recommendation",
      "Agent queue must remain a view of canonical Project ordering",
    );
  }
  validateCitations(
    recommendation.citations,
    evidence,
    "agentQueueRecommendation.citations",
    { nonEmpty: true },
  );
  return structuredClone(recommendation);
}

function validateProposals(actions, snapshot, evidence, actionPolicy) {
  const accepted = [];
  const rejected = [];
  const repositories = new Set(
    snapshot.dossiers.map((dossier) => dossier.item.repository),
  );
  for (const [index, value] of actions.entries()) {
    const action = validatePanAction(
      value,
      `proposedActions[${index}]`,
    );
    validateCitations(
      action.evidence,
      evidence,
      `proposedActions[${index}].evidence`,
      { nonEmpty: true },
    );
    const reasons = [
      ...actionReferenceViolations(action, snapshot, repositories),
    ];
    if (
      action.kind !== "no-op" &&
      action.expectedState.snapshotId !== snapshot.id
    ) {
      reasons.push(
        "Action expectedState.snapshotId does not match the reviewed snapshot",
      );
    }
    const policy = actionPolicy.assess(action, {
      snapshot,
      mode: "proposal",
    });
    reasons.push(...policy.reasons);
    if (reasons.length === 0) {
      accepted.push({ action, policy });
    } else {
      rejected.push({
        actionId: action.actionId,
        reasons: [...new Set(reasons)],
      });
    }
  }
  return { accepted, rejected };
}

function actionReferenceViolations(action, snapshot, repositories) {
  const reasons = [];
  const repository = [...repositories][0];
  if (repositories.size !== 1) {
    reasons.push("Snapshot contains inconsistent repository evidence");
  }
  if (
    action.kind === "issue-create" &&
    action.target.repository !== repository
  ) {
    reasons.push("Issue creation targets another domain repository");
  }
  if (
    ["issue-comment", "needs-human"].includes(action.kind) &&
    !isRepositoryIssueUrl(action.target.issueUrl, repository)
  ) {
    reasons.push("Issue action targets another domain repository");
  }
  if (
    action.kind === "issue-create" &&
    action.target.workstream !== undefined &&
    !isConfinedWorkstream(action.target.workstream)
  ) {
    reasons.push("Issue action contains an invalid workstream path");
  }
  if (
    action.kind === "field-update" &&
    !SUPPORTED_FIELDS.has(action.target.field)
  ) {
    reasons.push("Field update targets an unsupported Project field");
  }
  if (
    action.kind === "field-update" &&
    action.target.field === "workstream" &&
    !isConfinedWorkstream(action.target.value)
  ) {
    reasons.push("Field update contains an invalid workstream path");
  }
  return reasons;
}

function validateResponseCitations(response, evidence) {
  validateCitations(response.citations, evidence, "citations");
  response.facts.forEach((fact, index) =>
    validateCitations(
      fact.citations,
      evidence,
      `facts[${index}].citations`,
      { nonEmpty: true },
    ),
  );
}

function buildEvidenceIndex(snapshot, manualConstraints) {
  const byKind = new Map(
    [
      "issue",
      "issue-comment",
      "project-field",
      "workstream",
      "runner",
      "domain-record",
    ].map((kind) => [kind, new Set()]),
  );
  const revisions = new Set([snapshot.id, snapshot.project?.id]);
  byKind.get("domain-record").add(snapshot.id);
  if (snapshot.project?.id) {
    byKind.get("domain-record").add(snapshot.project.id);
  }
  for (const dossier of snapshot.dossiers) {
    const item = dossier.item;
    byKind.get("issue").add(item.id);
    byKind.get("issue").add(item.url);
    for (const revision of [item.createdAt, item.updatedAt]) {
      if (revision) {
        revisions.add(revision);
      }
    }
    for (const comment of item.comments ?? []) {
      byKind.get("issue-comment").add(comment.id);
      if (comment.url) {
        byKind.get("issue-comment").add(comment.url);
      }
      for (const revision of [
        comment.createdAt,
        comment.updatedAt,
      ]) {
        if (revision) {
          revisions.add(revision);
        }
      }
    }
    for (const field of Object.keys(item.fields ?? {})) {
      byKind.get("project-field").add(`${item.id}:${field}`);
      byKind.get("project-field").add(item.id);
    }
    const workstream = dossier.workstream;
    for (const locator of [
      workstream?.path,
      workstream?.sourcePath,
      workstream?.contentHash,
    ]) {
      if (locator) {
        byKind.get("workstream").add(locator);
      }
    }
    for (const revision of [
      workstream?.revision,
      workstream?.contentHash,
      workstream?.modifiedAt,
      ...(workstream?.history ?? []).map((entry) => entry.sha),
    ]) {
      if (revision) {
        revisions.add(revision);
      }
    }
    for (const runner of dossier.compatibility?.runners ?? []) {
      byKind.get("runner").add(runner.id);
    }
  }
  for (const runner of snapshot.runnerAvailability?.runners ?? []) {
    byKind.get("runner").add(runner.id);
  }
  for (const constraint of manualConstraints) {
    const locator =
      constraint.id ??
      (constraint.beforeItemId && constraint.afterItemId
        ? `manual:${constraint.beforeItemId}>${constraint.afterItemId}`
        : undefined);
    if (locator) {
      byKind.get("domain-record").add(locator);
    }
    if (constraint.revision) {
      revisions.add(constraint.revision);
    }
  }
  return { byKind, revisions };
}

function validateCitations(
  citations,
  evidence,
  name,
  { nonEmpty = false } = {},
) {
  if (
    !Array.isArray(citations) ||
    (nonEmpty && citations.length === 0)
  ) {
    throw responseError(
      "invalid-citation",
      `${name} must be ${nonEmpty ? "a non-empty" : "an"} array`,
    );
  }
  for (const [index, citation] of citations.entries()) {
    const known = evidence.byKind.get(citation.kind);
    if (!known?.has(citation.locator)) {
      throw responseError(
        "invalid-citation",
        `${name}[${index}] does not resolve to snapshot evidence`,
      );
    }
    if (
      citation.revision !== undefined &&
      !evidence.revisions.has(citation.revision)
    ) {
      throw responseError(
        "invalid-citation",
        `${name}[${index}].revision does not resolve to snapshot evidence`,
      );
    }
  }
}

function isHumanCandidate(dossier) {
  return (
    ["blocked", "needs-detail"].includes(
      dossier.preclassification,
    ) ||
    (dossier.preclassification === "actionable" &&
      dossier.item.fields?.owner !== "agent")
  );
}

function isAgentCandidate(dossier) {
  return (
    dossier.preclassification === "actionable" &&
    dossier.item.fields?.owner === "agent" &&
    (dossier.compatibility?.runners ?? []).some(
      (runner) => runner.freeCapacity > 0,
    )
  );
}

function isRepositoryIssueUrl(value, repository) {
  if (!repository) {
    return false;
  }
  try {
    const url = new URL(value);
    const escaped = repository.replace(
      /[.*+?^${}()|[\]\\]/g,
      "\\$&",
    );
    return (
      url.protocol === "https:" &&
      url.hostname === "github.com" &&
      new RegExp(`^/${escaped}/issues/\\d+(?:/|$)`).test(url.pathname)
    );
  } catch {
    return false;
  }
}

function isConfinedWorkstream(value) {
  return (
    typeof value === "string" &&
    value.trim() &&
    !value.includes("\\") &&
    !path.isAbsolute(value) &&
    !value.startsWith("/") &&
    value
      .split("/")
      .every(
        (segment) =>
          segment && segment !== "." && segment !== "..",
      )
  );
}

function requireMethod(value, method, name) {
  if (typeof value?.[method] !== "function") {
    throw new TypeError(`${name} must provide ${method}()`);
  }
}

function requireRecord(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw responseError(
      "invalid-response",
      `${name} must be an object`,
    );
  }
}

function requireString(value, name) {
  if (typeof value !== "string" || !value.trim()) {
    throw responseError(
      "invalid-response",
      `${name} must be a non-empty string`,
    );
  }
}

function exactKeys(value, allowed, name) {
  const unexpected = Object.keys(value).filter(
    (key) => !allowed.includes(key),
  );
  const missing = allowed.filter((key) => !Object.hasOwn(value, key));
  if (unexpected.length > 0 || missing.length > 0) {
    throw responseError(
      "invalid-response",
      `${name} has an invalid shape`,
    );
  }
}

function responseError(state, message) {
  return new ReasoningTurnError(state, message);
}

export const REASONING_TOOL_OPERATIONS = DEFAULT_OPERATIONS;
