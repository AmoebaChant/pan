import { createHash } from "node:crypto";

import { ActionPolicy } from "./action-policy.js";
import {
  isHostlessLiveAction,
  validatePanAction,
  validatePanActionGroup,
} from "./pan-protocol.js";

const MODEL_WRITABLE_FIELDS = new Set([
  "status",
  "owner",
  "priority",
  "autonomy",
  "requirements",
  "workstream",
]);

export class ActionService {
  constructor({
    snapshotSource,
    store,
    actionPolicy = new ActionPolicy(),
    assertLeadership = async () => ({ asserted: true }),
    attention,
  } = {}) {
    if (!snapshotSource?.build || !store?.readCanonicalProject) {
      throw new TypeError("snapshotSource and store.readCanonicalProject are required");
    }
    if (typeof assertLeadership !== "function") {
      throw new TypeError("assertLeadership must be a function");
    }
    this.snapshotSource = snapshotSource;
    this.store = store;
    this.actionPolicy = actionPolicy;
    this.assertLeadership = assertLeadership;
    this.attention = attention;
  }

  async validate(input, { identity } = {}) {
    const group = normalizeGroup(input);
    const snapshot = await this.#snapshot();
    const receipts = [];
    for (const action of group.actions) {
      const reasons = this.#validateAction(action, snapshot, { identity });
      receipts.push(receipt(action, reasons));
    }
    return { snapshot, group, receipts };
  }

  async apply(input, { identity } = {}) {
    if (!identity?.generation) {
      throw new TypeError("leadership identity is required to apply actions");
    }
    const validated = await this.validate(input, { identity });
    const rejected = validated.receipts.filter((entry) => entry.status !== "accepted");
    if (rejected.length > 0) {
      return { ...validated, effects: [], incompleteEffects: [], rejected };
    }

    const effects = [];
    const incompleteEffects = [];
    for (const action of validated.group.actions) {
      try {
        effects.push(
          await this.#applyAction(action, {
            groupId: validated.group.groupId,
            identity,
          }),
        );
      } catch (error) {
        incompleteEffects.push(incompleteEffect(action, validated.group.groupId, error));
        break;
      }
    }
    return {
      ...validated,
      effects,
      incompleteEffects,
      rejected: [],
    };
  }

  async #snapshot() {
    const snapshot = await this.snapshotSource.build();
    if (!snapshot.complete || !snapshot.usableForMutation) {
      throw new Error(
        `Complete portfolio evidence is required: ${snapshot.diagnostics
          .map((entry) => entry.message)
          .join("; ")}`,
      );
    }
    return snapshot;
  }

  #validateAction(action, snapshot, { identity } = {}) {
    const reasons = [];
    if (action.kind === "no-op") {
      return reasons;
    }
    if (!isHostlessLiveAction(action)) {
      reasons.push("Only version 2 actions may be applied by the hostless action service");
      return reasons;
    }
    if (
      action.domain.repository !== this.store.repository ||
      action.domain.projectOwner !== this.store.projectOwner ||
      action.domain.projectNumber !== this.store.projectNumber
    ) {
      reasons.push("Action domain does not match the configured PAN domain");
    }
    if (
      identity?.generation &&
      action.expectedState.leadership.generation !== identity.generation
    ) {
      reasons.push("Action leadership generation does not match the current session");
    }
    const assessment = this.actionPolicy.assess(action, {
      snapshot: currentPolicySnapshot(snapshot),
      mode: "live",
    });
    if (!assessment.allowed) {
      reasons.push(...assessment.reasons);
    }
    if (assessment.requiresApproval) {
      reasons.push("Action requires approval");
    }
    if (assessment.authority === "prohibited") {
      reasons.push("Action is prohibited by configured policy");
    }
    reasons.push(...expectedStateViolations(action, snapshot));
    return [...new Set(reasons)];
  }

  async #applyAction(action, { groupId, identity }) {
    const snapshot = await this.#snapshot();
    const reasons = this.#validateAction(action, snapshot, { identity });
    if (reasons.length > 0) {
      throw new Error(reasons.join("; "));
    }
    switch (action.kind) {
      case "field-update":
        return this.#applyField(action, { groupId, identity });
      case "canonical-reorder":
        return this.#applyOrder(action, action.target.orderedItemIds, {
          groupId,
          identity,
        });
      case "relative-precedence": {
        const current = await this.store.readCanonicalProject();
        const order = current.items.map((item) => item.id);
        const before = order.indexOf(action.target.beforeItemId);
        const after = order.indexOf(action.target.afterItemId);
        if (before === -1 || after === -1) {
          throw new Error("Relative precedence references an unknown Project item");
        }
        order.splice(before, 1);
        order.splice(order.indexOf(action.target.afterItemId), 0, action.target.beforeItemId);
        return this.#applyOrder(action, order, { groupId, identity });
      }
      case "issue-comment":
        return this.#applyComment(action, { groupId, identity });
      case "needs-human":
        return this.#applyAttention(action, { groupId, identity });
      case "issue-create":
        return this.#applyIssueCreate(action, { groupId, identity });
      case "no-op":
        return effect(action, groupId, "recommendation", action.actionId, {
          recommendation: action.recommendation,
        });
      default:
        throw new Error(`Action kind ${action.kind} is not yet applicable`);
    }
  }

  async #applyField(action, { groupId, identity }) {
    if (!MODEL_WRITABLE_FIELDS.has(action.target.field)) {
      throw new Error(`PAN cannot modify operational field ${action.target.field}`);
    }
    const item = await this.#readExpectedItem(action);
    await this.#assertLeadership(identity);
    await this.store.setFields(
      item.id,
      { [action.target.field]: action.target.value },
      { beforeWrite: () => this.#assertLeadership(identity) },
    );
    const confirmed = await this.#readExpectedItem(action, action.target.value);
    return effect(action, groupId, "project-field", confirmed.id, {
      [action.target.field]: confirmed.fields[action.target.field],
    });
  }

  async #applyOrder(action, orderedItemIds, { groupId, identity }) {
    const current = await this.store.readCanonicalProject();
    assertExpectedOrder(action, current.items.map((item) => item.id));
    await this.#assertLeadership(identity);
    await this.store.reorderItems(orderedItemIds, {
      beforeWrite: () => this.#assertLeadership(identity),
    });
    const confirmed = await this.store.readCanonicalProject();
    const actual = confirmed.items.map((item) => item.id);
    if (!sameArray(actual, orderedItemIds)) {
      throw new Error("GitHub did not confirm the requested Project order");
    }
    return effect(action, groupId, "project-order", confirmed.id, {
      itemIds: actual,
    });
  }

  async #applyComment(action, { groupId, identity }) {
    const item = await this.#findIssue(action.target.issueUrl);
    const marker = idempotencyMarker(action.idempotencyKey);
    const comments = await this.store.listComments(item);
    if (!comments.some((comment) => comment.body.includes(marker))) {
      await this.#assertLeadership(identity);
      await this.store.addComment(
        item,
        appendMarker(action.target.body, marker),
        { beforeWrite: () => this.#assertLeadership(identity) },
      );
    }
    const confirmed = await this.store.listComments(item);
    if (!confirmed.some((comment) => comment.body.includes(marker))) {
      throw new Error("GitHub did not confirm the idempotent Issue comment");
    }
    return effect(action, groupId, "issue-comment", action.target.issueUrl, {
      marker,
    });
  }

  async #applyAttention(action, { groupId, identity }) {
    if (!this.attention?.request) {
      throw new Error("Human-attention application is not configured");
    }
    const item = await this.#findIssue(action.target.issueUrl);
    const marker = idempotencyMarker(action.idempotencyKey);
    const comments = await this.store.listComments(item);
    if (!comments.some((comment) => comment.body.includes(marker))) {
      await this.#assertLeadership(identity);
      await this.attention.request(
        item,
        {
          kind: action.target.kind,
          prompt: action.target.prompt,
          source: "pan",
          reason: "portfolio-reasoning",
          locator: { issue: item.url },
        },
        { marker },
      );
    }
    const confirmed = await this.store.listComments(item);
    if (!confirmed.some((comment) => comment.body.includes(marker))) {
      throw new Error("GitHub did not confirm the human-attention request");
    }
    return effect(action, groupId, "attention", action.target.issueUrl, { marker });
  }

  async #applyIssueCreate(action, { groupId, identity }) {
    const marker = idempotencyMarker(action.idempotencyKey);
    let item = await this.store.findIssueByMarker(marker);
    if (!item) {
      await this.#assertLeadership(identity);
      item = await this.store.createItem(
        {
          title: action.target.title,
          body: appendMarker(action.target.body ?? "", marker),
          fields: {
            owner: "unassigned",
            status: "untriaged",
            priority: "normal",
            autonomy: "manual",
            requirements: [],
            ...(action.target.workstream ? { workstream: action.target.workstream } : {}),
          },
        },
        { beforeWrite: () => this.#assertLeadership(identity) },
      );
    }
    if (!item?.url) {
      throw new Error("GitHub did not confirm the idempotent Issue creation");
    }
    return effect(action, groupId, "issue", item.url, {
      number: item.number,
      marker,
    });
  }

  async #readExpectedItem(action, expectedValue = undefined) {
    const current = await this.store.readCanonicalProject();
    const item = current.items.find(
      (candidate) => candidate.id === action.expectedState.projectField.itemId,
    );
    if (!item) {
      throw new Error("Project field target is absent from the current Project");
    }
    const expected =
      expectedValue === undefined
        ? action.expectedState.projectField.value
        : expectedValue;
    if (
      JSON.stringify(item.fields[action.target.field]) !== JSON.stringify(expected)
    ) {
      throw new Error(`Expected ${action.target.field} no longer matches GitHub`);
    }
    return item;
  }

  async #findIssue(issueUrl) {
    const current = await this.store.readCanonicalProject();
    const item = current.items.find((candidate) => candidate.url === issueUrl);
    if (!item) {
      throw new Error(`Issue is not in the configured Project: ${issueUrl}`);
    }
    return item;
  }

  async #assertLeadership(identity) {
    const result = await this.assertLeadership(identity);
    if (!result?.asserted) {
      const error = new Error(
        result?.reason ?? "Leadership was not confirmed before mutation",
      );
      error.code = "PAN_LEADERSHIP_REQUIRED";
      throw error;
    }
  }
}

function normalizeGroup(input) {
  if (input?.actions) {
    return validatePanActionGroup(input);
  }
  const action = validatePanAction(input);
  return {
    version: 2,
    groupId: action.actionId,
    semantics: "independent",
    actions: [action],
  };
}

function currentPolicySnapshot(snapshot) {
  return {
    project: snapshot.project,
    dossiers: snapshot.dossiers,
    humanPrecedence: snapshot.humanPrecedence,
  };
}

function expectedStateViolations(action, snapshot) {
  const expected = action.expectedState;
  const actual = snapshot.expectedState;
  const reasons = [];
  if (expected.projectField) {
    const item = snapshot.dossiers.find(
      (entry) => entry.item.id === expected.projectField.itemId,
    )?.item;
    if (
      !item ||
      JSON.stringify(item.fields?.[expected.projectField.field]) !==
        JSON.stringify(expected.projectField.value) ||
      expected.projectField.revision !== actual.projectFields
    ) {
      reasons.push("Expected Project field state no longer matches current evidence");
    }
  }
  if (
    expected.projectOrder &&
    (expected.projectOrder.revision !== actual.projectOrder ||
      !sameArray(expected.projectOrder.itemIds, snapshot.project.items))
  ) {
    reasons.push("Expected Project order no longer matches current evidence");
  }
  if (
    expected.issueCatalog &&
    expected.issueCatalog.revision !== actual.issueCatalog
  ) {
    reasons.push("Expected Issue catalog no longer matches current evidence");
  }
  if (expected.issue) {
    const issue = snapshot.dossiers.find(
      (entry) => entry.item.url === expected.issue.url,
    )?.item;
    if (
      !issue ||
      issue.state !== expected.issue.state ||
      issue.updatedAt !== expected.issue.revision
    ) {
      reasons.push("Expected Issue state no longer matches current evidence");
    }
  }
  if (expected.workstream) {
    const workstream = snapshot.dossiers.find(
      (entry) => entry.workstream.path === expected.workstream.path,
    )?.workstream;
    if (
      !workstream ||
      workstream.revision !== expected.workstream.blobRevision ||
      !workstream.history?.some(
        (entry) => entry.sha === expected.workstream.baseRevision,
      )
    ) {
      reasons.push("Expected workstream state no longer matches current evidence");
    }
  }
  return reasons;
}

function assertExpectedOrder(action, actual) {
  const expected = action.expectedState.projectOrder.itemIds;
  if (!sameArray(actual, expected)) {
    throw new Error("Expected Project order no longer matches GitHub");
  }
}

function receipt(action, reasons) {
  return {
    actionId: action.actionId,
    status: reasons.length === 0 ? "accepted" : "rejected",
    ...(reasons.length === 0 ? {} : { reasons }),
  };
}

function effect(action, groupId, resource, externalIdentity, confirmedState) {
  return {
    actionId: action.actionId,
    groupId,
    resource,
    externalIdentity,
    confirmedState,
    recovery: [],
  };
}

function incompleteEffect(action, groupId, error) {
  return {
    actionId: action.actionId,
    groupId,
    resource: action.kind,
    externalIdentity: action.actionId,
    confirmedState: { status: "unconfirmed" },
    remainingSteps: ["Refresh complete evidence and review the affected resource before retrying."],
    recovery: [error instanceof Error ? error.message : String(error)],
  };
}

function idempotencyMarker(key) {
  return `<!-- pan-action:${createHash("sha256").update(key).digest("hex")} -->`;
}

function appendMarker(body, marker) {
  return body.trim() ? `${body.trim()}\n\n${marker}` : marker;
}

function sameArray(left, right) {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}
