import { validatePanAction } from "./pan-protocol.js";

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
  "workstream-update",
  "no-op",
]);

export class ActionPolicy {
  constructor({
    automatic,
    approvalRequired = [],
    prohibited = [],
  } = {}) {
    if (
      (automatic !== undefined && !Array.isArray(automatic)) ||
      !Array.isArray(approvalRequired) ||
      !Array.isArray(prohibited) ||
      [...(automatic ?? []), ...approvalRequired, ...prohibited].some(
        (kind) =>
          typeof kind !== "string" ||
          !kind.trim() ||
          !ACTION_KINDS.has(kind),
      )
    ) {
      throw new TypeError("action policy classifications must contain action kind names");
    }
    const classified = [...(automatic ?? []), ...approvalRequired, ...prohibited];
    if (new Set(classified).size !== classified.length) {
      throw new TypeError("an action kind may only have one policy classification");
    }
    this.automatic = automatic === undefined ? undefined : new Set(automatic);
    this.approvalRequired = new Set(approvalRequired);
    this.prohibited = new Set(prohibited);
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
        "workstream-update": this.#liveAuthority("workstream-update"),
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

    if (authority === "prohibited") {
      reasons.push(`Policy prohibits ${normalized.kind}`);
    }
    return Object.freeze({
      allowed: reasons.length === 0 && authority !== "approval" && authority !== "prohibited",
      authority,
      requiresApproval: authority === "approval",
      reasons: Object.freeze(reasons),
    });
  }

  #liveAuthority(kind) {
    if (this.prohibited.has(kind)) {
      return "prohibited";
    }
    if (this.approvalRequired.has(kind)) {
      return "approval";
    }
    if (this.automatic?.has(kind)) {
      return "automatic";
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
  reasons.push(...humanPrecedenceViolations(action, snapshot));
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

function humanPrecedenceViolations(action, snapshot) {
  if (!["canonical-reorder", "relative-precedence"].includes(action.kind)) {
    return [];
  }
  const pairs = snapshot.humanPrecedence ?? snapshot.project?.humanPrecedence ?? [];
  const proposed =
    action.kind === "canonical-reorder"
      ? action.target.orderedItemIds
      : reorderRelative(
          snapshot.project?.items ?? [],
          action.target.beforeItemId,
          action.target.afterItemId,
        );
  return pairs.flatMap((pair) => {
    const [before, after] = Array.isArray(pair)
      ? pair
      : [pair?.beforeItemId, pair?.afterItemId];
    if (!before || !after || proposed.indexOf(before) < proposed.indexOf(after)) {
      return [];
    }
    return [`Human precedence requires ${before} to remain before ${after}`];
  });
}

function reorderRelative(order, beforeItemId, afterItemId) {
  const next = [...order];
  const index = next.indexOf(beforeItemId);
  if (index === -1 || next.indexOf(afterItemId) === -1) {
    return next;
  }
  next.splice(index, 1);
  next.splice(next.indexOf(afterItemId), 0, beforeItemId);
  return next;
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
