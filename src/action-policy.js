import { validatePanAction } from "./pan-protocol.js";
import { matchingRunner } from "./triage-policy.js";

const PROTECTED_STATUSES = new Set(["in-progress", "in-review", "done"]);
const EXPLANATION_ACTIONS = new Set([
  "field-update",
  "canonical-reorder",
  "relative-precedence",
  "issue-create",
  "issue-comment",
  "needs-human",
]);
const ACTION_KINDS = new Set([
  ...EXPLANATION_ACTIONS,
  "no-op",
]);

export class ActionPolicy {
  constructor({ approvalRequired = [] } = {}) {
    if (
      !Array.isArray(approvalRequired) ||
      approvalRequired.some(
        (kind) =>
          typeof kind !== "string" ||
          !kind.trim() ||
          !ACTION_KINDS.has(kind),
      )
    ) {
      throw new TypeError("approvalRequired must contain action kind names");
    }
    this.approvalRequired = new Set(approvalRequired);
    this.authority = Object.freeze({
      reads: "automatic",
      proposals: "automatic",
      live: Object.freeze({
        "field-update": this.#liveAuthority("field-update"),
        "canonical-reorder": this.#liveAuthority("canonical-reorder"),
        "relative-precedence": this.#liveAuthority("relative-precedence"),
        "issue-create": this.#liveAuthority("issue-create"),
        "issue-comment": this.#liveAuthority("issue-comment"),
        "needs-human": this.#liveAuthority("needs-human"),
        "no-op": "automatic",
      }),
    });
  }

  assess(action, { snapshot, mode = "proposal" } = {}) {
    const normalized = validatePanAction(action);
    if (!["proposal", "live"].includes(mode)) {
      throw new TypeError("mode must be proposal or live");
    }
    const reasons = lifecycleViolations(normalized, snapshot);
    const authority =
      mode === "proposal"
        ? this.authority.proposals
        : this.authority.live[normalized.kind];

    if (
      mode === "live" &&
      authority !== "automatic" &&
      !hasMaterialExplanation(normalized)
    ) {
      reasons.push(
        "Live material actions require a specific rationale and durable evidence",
      );
    }

    return Object.freeze({
      allowed: reasons.length === 0,
      authority,
      requiresApproval: authority === "approval",
      reasons: Object.freeze(reasons),
    });
  }

  #liveAuthority(kind) {
    if (this.approvalRequired.has(kind)) {
      return "approval";
    }
    return EXPLANATION_ACTIONS.has(kind) ? "explanation" : "automatic";
  }
}

export function lifecycleViolations(action, snapshot) {
  if (!snapshot) {
    return [];
  }
  const dossiers = snapshot.dossiers ?? [];
  const byId = new Map(
    dossiers.map((dossier) => [dossier.item?.id, dossier]),
  );
  const reasons = [];
  reasons.push(...referenceViolations(action, snapshot, byId));
  reasons.push(...issueCreationViolations(action, snapshot));
  const affected = affectedDossiers(action, snapshot, byId);

  for (const dossier of affected) {
    const item = dossier.item;
    if (dossier.lease?.active) {
      reasons.push(`Item ${item.id} has an active lease`);
    }

    if (PROTECTED_STATUSES.has(item.fields?.status)) {
      reasons.push(
        `Item ${item.id} is protected while ${item.fields.status}`,
      );
    }
    if (
      item.fields?.status === "blocked" &&
      clearsBlockedStatus(action, item.id) &&
      item.fields?.blockedBy !== "pan"
    ) {
      reasons.push(
        `Item ${item.id} has a block that PAN is not authorized to clear`,
      );
    }
  }
  return [...new Set(reasons)];
}

function issueCreationViolations(action, snapshot) {
  if (action.kind !== "issue-create") {
    return [];
  }
  const target = action.target;
  const reasons = [];
  if (
    snapshot.workstreams?.paths &&
    !snapshot.workstreams.paths.includes(target.workstream)
  ) {
    reasons.push(
      `Workstream ${target.workstream} is absent from the current snapshot`,
    );
  }
  if (target.owner === "human" && target.autonomy !== "manual") {
    reasons.push("Human-owned tasks must use manual autonomy");
  }
  if (
    target.owner === "agent" &&
    !["full-auto", "agent-reviewer"].includes(target.autonomy)
  ) {
    reasons.push(
      "Agent-owned tasks must use full-auto or agent-reviewer autonomy",
    );
  }
  const repositories = target.requirements.filter((requirement) =>
    requirement.startsWith("repo:"),
  );
  if (target.owner === "agent" && repositories.length !== 1) {
    reasons.push(
      "Agent-owned tasks require exactly one repo:owner/name requirement",
    );
  } else if (
    target.owner === "agent" &&
    snapshot.runnerAvailability &&
    !matchingRunner(
      target.requirements,
      snapshot.runnerAvailability.runners ?? [],
    )
  ) {
    reasons.push(
      "No online runner can satisfy the proposed task requirements",
    );
  }
  return reasons;
}

function referenceViolations(action, snapshot, byId) {
  const referenced = {
    "field-update": [action.target?.itemId],
    "relative-precedence": [
      action.target?.beforeItemId,
      action.target?.afterItemId,
    ],
  }[action.kind];
  if (referenced) {
    return referenced
      .filter((itemId) => !byId.has(itemId))
      .map(
        (itemId) =>
          `Item ${itemId} is absent from the current snapshot`,
      );
  }
  if (action.kind !== "canonical-reorder") {
    return [];
  }
  const current = snapshot.project?.items ?? [];
  const proposed = action.target.orderedItemIds;
  if (
    current.length !== proposed.length ||
    current.some((itemId) => !proposed.includes(itemId))
  ) {
    return [
      "Canonical reorder must contain every current Project item exactly once",
    ];
  }
  return [];
}

function affectedDossiers(action, snapshot, byId) {
  switch (action.kind) {
    case "field-update":
      return action.target.field === "status" ||
        ["priority", "owner", "workstream", "autonomy"].includes(
          action.target.field,
        )
        ? existingDossiers([action.target.itemId], byId)
        : [];
    case "relative-precedence":
      return existingDossiers(
        [action.target.beforeItemId, action.target.afterItemId],
        byId,
      );
    case "canonical-reorder": {
      const current = snapshot.project?.items ?? [];
      return existingDossiers(
        action.target.orderedItemIds.filter((itemId) =>
          crossesItemBoundary(
            itemId,
            current,
            action.target.orderedItemIds,
          ),
        ),
        byId,
      );
    }
    default:
      return [];
  }
}

function crossesItemBoundary(itemId, current, proposed) {
  const currentBefore = new Set(
    current.slice(0, current.indexOf(itemId)),
  );
  const proposedBefore = proposed.slice(0, proposed.indexOf(itemId));
  return (
    currentBefore.size !== proposedBefore.length ||
    proposedBefore.some((candidate) => !currentBefore.has(candidate))
  );
}

function existingDossiers(ids, byId) {
  return ids.map((id) => byId.get(id)).filter(Boolean);
}

function clearsBlockedStatus(action, itemId) {
  return (
    action.kind === "field-update" &&
    action.target.itemId === itemId &&
    action.target.field === "status" &&
    action.target.value !== "blocked"
  );
}

function hasMaterialExplanation(action) {
  return (
    action.rationale.trim().length >= 20 &&
    action.evidence.length > 0
  );
}

export const PAN_PROTECTED_STATUSES = Object.freeze([
  ...PROTECTED_STATUSES,
]);
