import { createHash, randomUUID } from "node:crypto";

import { ActionPolicy } from "./action-policy.js";
import { formatNeedsHuman } from "./needs-human.js";
import { normalizePanFinalResponse } from "./pan-protocol.js";

const MODEL_WRITABLE_FIELDS = new Set([
  "status",
  "owner",
  "priority",
  "autonomy",
  "requirements",
  "workstream",
]);

export class PanReviewService {
  constructor({
    snapshotSource,
    agentClient,
    store,
    actionPolicy = new ActionPolicy(),
    now = () => new Date(),
  }) {
    if (!snapshotSource?.build || !agentClient?.review || !agentClient?.chat) {
      throw new TypeError(
        "snapshotSource and an agentClient with review() and chat() are required",
      );
    }
    if (
      !store?.readCanonicalProject ||
      !store?.setFields ||
      !store?.reorderItems ||
      !store?.createItem ||
      !store?.addIssueToProject ||
      !store?.addComment ||
      !store?.listComments ||
      !store?.findIssueByMarker
    ) {
      throw new TypeError("store does not provide the required PAN operations");
    }
    this.snapshotSource = snapshotSource;
    this.agentClient = agentClient;
    this.store = store;
    this.actionPolicy = actionPolicy;
    this.now = now;
  }

  async run({ apply = false, userInput, signal } = {}) {
    const snapshot = await this.snapshotSource.build();
    if (!snapshot.complete || !snapshot.usableForMutation) {
      throw new Error(
        `PAN cannot reason from an incomplete portfolio: ${snapshot.diagnostics
          .map((diagnostic) => diagnostic.message)
          .join("; ")}`,
      );
    }

    const mode = userInput ? "interactive-chat" : "autonomous-review";
    const timestamp = this.now().toISOString();
    const turn = {
      version: 1,
      type: "request",
      turnId: randomUUID(),
      mode,
      timestamp,
      snapshot: {
        id: snapshot.id,
        capturedAt: snapshot.capturedAt,
        complete: true,
      },
      portfolio: snapshot,
      toolChannel: {
        transport: "mcp-stdio",
        server: "pan-tools",
        allowedOperations: ["propose_actions"],
      },
      ...(userInput ? { userInput } : {}),
    };
    const agentResult = userInput
      ? await this.agentClient.chat(turn, { signal })
      : await this.agentClient.review(turn, { signal });
    const response = normalizePanFinalResponse(agentResult.response);
    const evidencedResponse = validateResponseEvidence(response, snapshot);
    if (!apply) {
      return {
        applied: false,
        snapshotId: snapshot.id,
        sessionId: agentResult.sessionId,
        response: evidencedResponse,
      };
    }

    signal?.throwIfAborted();
    let outcomes;
    try {
      outcomes = await this.#apply(
        evidencedResponse.proposedActions,
        snapshot,
        signal,
      );
    } catch (error) {
      if (error.incompleteEffect) {
        error.result = {
          applied: true,
          snapshotId: snapshot.id,
          sessionId: agentResult.sessionId,
          response: normalizePanFinalResponse({
            ...evidencedResponse,
            appliedActions: [],
            rejectedActions: evidencedResponse.rejectedActions,
            effects: {
              confirmed: [],
              incomplete: [error.incompleteEffect],
            },
          }),
        };
      }
      throw error;
    }
    return {
      applied: true,
      snapshotId: snapshot.id,
      sessionId: agentResult.sessionId,
      response: normalizePanFinalResponse({
        ...evidencedResponse,
        appliedActions: outcomes.appliedActions,
        rejectedActions: [
          ...evidencedResponse.rejectedActions,
          ...outcomes.rejectedActions,
        ],
        effects: {
          confirmed: outcomes.confirmed,
          incomplete: outcomes.incomplete,
        },
      }),
    };
  }

  async applyActions(actions, { signal, snapshot } = {}) {
    snapshot ??= await this.snapshotSource.build();
    if (!snapshot.complete || !snapshot.usableForMutation) {
      throw new Error(
        `PAN cannot apply actions from an incomplete portfolio: ${snapshot.diagnostics
          .map((diagnostic) => diagnostic.message)
          .join("; ")}`,
      );
    }
    const timestamp = this.now().toISOString();
    const response = validateResponseEvidence(
      normalizePanFinalResponse({
        version: 1,
        type: "final-response",
        turnId: randomUUID(),
        mode: "interactive-chat",
        timestamp,
        snapshotId: snapshot.id,
        recommendation: "Apply the actions proposed in the interactive PAN session.",
        proposedActions: actions,
      }),
      snapshot,
    );
    signal?.throwIfAborted();
    let outcomes;
    try {
      outcomes = await this.#apply(
        response.proposedActions,
        snapshot,
        signal,
      );
    } catch (error) {
      if (error.incompleteEffect) {
        error.result = {
          snapshotId: snapshot.id,
          appliedActions: [],
          rejectedActions: response.rejectedActions,
          effects: {
            confirmed: [],
            incomplete: [error.incompleteEffect],
          },
        };
      }
      throw error;
    }
    return {
      snapshotId: snapshot.id,
      appliedActions: outcomes.appliedActions,
      rejectedActions: [
        ...response.rejectedActions,
        ...outcomes.rejectedActions,
      ],
      effects: {
        confirmed: outcomes.confirmed,
        incomplete: outcomes.incomplete,
      },
    };
  }

  async #apply(actions, snapshot, signal) {
    const appliedActions = [];
    const rejectedActions = [];
    const confirmed = [];
    const incomplete = [];
    const idempotencyKeys = new Set();
    let mutationApplied = false;

    for (const action of actions) {
      signal?.throwIfAborted();
      if (
        action.kind !== "no-op" &&
        idempotencyKeys.has(action.idempotencyKey)
      ) {
        rejectedActions.push({
          actionId: action.actionId,
          reason: "Duplicate idempotency key in one PAN response",
        });
        continue;
      }
      if (action.kind !== "no-op") {
        idempotencyKeys.add(action.idempotencyKey);
      }
      if (mutationApplied && action.kind !== "no-op") {
        rejectedActions.push({
          actionId: action.actionId,
          reason:
            "PAN applies one mutation per reasoning turn; review again before applying another change",
        });
        continue;
      }
      const current = await this.store.readCanonicalProject();
      signal?.throwIfAborted();
      const assessment = this.actionPolicy.assess(action, {
        snapshot: currentPolicySnapshot(current),
        mode: "live",
      });
      const staleReason = expectedStateViolation(action, snapshot, current);
      const domainReason =
        action.kind === "issue-create" &&
        this.store.repository &&
        action.target.repository !== this.store.repository
          ? `PAN cannot create Issues outside ${this.store.repository}`
          : undefined;
      if (
        !assessment.allowed ||
        assessment.requiresApproval ||
        staleReason ||
        domainReason
      ) {
        const policyReason =
          assessment.reasons.length > 0
            ? assessment.reasons.join("; ")
            : "Action requires approval";
        rejectedActions.push({
          actionId: action.actionId,
          reason: staleReason ?? domainReason ?? policyReason,
        });
        continue;
      }

      try {
        signal?.throwIfAborted();
        const summary = await this.#applyAction(
          action,
          snapshot,
          current,
          signal,
        );
        appliedActions.push({ actionId: action.actionId, summary });
        confirmed.push({
          actionId: action.actionId,
          summary,
          citations: action.evidence,
        });
        mutationApplied ||= action.kind !== "no-op";
      } catch (error) {
        if (signal?.aborted) {
          const abortError = signal.reason ?? error;
          abortError.incompleteEffect = incompleteEffect(action, abortError);
          throw abortError;
        }
        incomplete.push({
          actionId: action.actionId,
          summary: `PAN could not confirm the action: ${error.message}`,
          citations: action.evidence,
          remainingSteps: [
            "Refresh the canonical Project and review its current state before retrying.",
          ],
        });
        break;
      }
    }
    return { appliedActions, rejectedActions, confirmed, incomplete };
  }

  async #applyAction(action, snapshot, current, signal) {
    signal?.throwIfAborted();
    switch (action.kind) {
      case "field-update":
        if (!MODEL_WRITABLE_FIELDS.has(action.target.field)) {
          throw new Error(
            `PAN cannot modify operational field ${action.target.field}`,
          );
        }
        await this.store.setFields(
          action.target.itemId,
          {
            [action.target.field]: action.target.value,
          },
          { signal },
        );
        signal?.throwIfAborted();
        return `Updated ${action.target.field} on ${action.target.itemId}.`;
      case "canonical-reorder":
        await this.store.reorderItems(action.target.orderedItemIds, { signal });
        signal?.throwIfAborted();
        await confirmOrder(this.store, action.target.orderedItemIds);
        return "Updated the canonical Project order.";
      case "relative-precedence": {
        const order = [...snapshot.project.items];
        const before = order.indexOf(action.target.beforeItemId);
        const after = order.indexOf(action.target.afterItemId);
        if (before === -1 || after === -1) {
          throw new Error("Relative precedence references an unknown item");
        }
        order.splice(before, 1);
        const destination = order.indexOf(action.target.afterItemId);
        order.splice(destination, 0, action.target.beforeItemId);
        await this.store.reorderItems(order, { signal });
        signal?.throwIfAborted();
        await confirmOrder(this.store, order);
        return `Placed ${action.target.beforeItemId} before ${action.target.afterItemId}.`;
      }
      case "issue-create": {
        const marker = idempotencyMarker(action.idempotencyKey);
        const existing = await this.store.findIssueByMarker(marker);
        signal?.throwIfAborted();
        const fields = {
          owner: "unassigned",
          status: "untriaged",
          priority: "normal",
          autonomy: "manual",
          requirements: [],
          ...(action.target.workstream
            ? { workstream: action.target.workstream }
            : {}),
        };
        if (existing) {
          if (String(existing.state).toLowerCase() !== "open") {
            return `Issue #${existing.number} was previously closed; PAN will not recreate it.`;
          }
          if (!current.items.some((item) => item.url === existing.url)) {
            await this.store.addIssueToProject(existing.url, fields, { signal });
            signal?.throwIfAborted();
            return `Recovered Issue #${existing.number} into the Project.`;
          }
          return `Issue #${existing.number} was already created.`;
        }
        if (
          current.items.some(
            (item) =>
              item.title.toLowerCase() === action.target.title.toLowerCase() &&
              item.fields.workstream === action.target.workstream,
          )
        ) {
          throw new Error("A matching Project item already exists");
        }
        const item = await this.store.createItem({
          title: action.target.title,
          body: appendMarker(action.target.body ?? "", marker),
          fields,
        }, { signal });
        signal?.throwIfAborted();
        return `Created Issue #${item.number}.`;
      }
      case "issue-comment": {
        const item = await findIssue(this.store, action.target.issueUrl);
        const marker = idempotencyMarker(action.idempotencyKey);
        if (await hasMarker(this.store, item, marker)) {
          return `Comment on Issue #${item.number} was already applied.`;
        }
        signal?.throwIfAborted();
        await this.store.addComment(
          item,
          appendMarker(action.target.body, marker),
          { signal },
        );
        signal?.throwIfAborted();
        return `Commented on Issue #${item.number}.`;
      }
      case "needs-human": {
        const item = await findIssue(this.store, action.target.issueUrl);
        const marker = idempotencyMarker(action.idempotencyKey);
        if (await hasMarker(this.store, item, marker)) {
          return `Human-input request on Issue #${item.number} was already applied.`;
        }
        signal?.throwIfAborted();
        await this.store.addComment(
          item,
          appendMarker(
            formatNeedsHuman({
              kind: action.target.kind,
              prompt: action.target.prompt,
              source: "pan",
              reason: "portfolio-reasoning",
              locator: { issue: item.url },
            }),
            marker,
          ),
          { signal },
        );
        signal?.throwIfAborted();
        return `Requested human input on Issue #${item.number}.`;
      }
      case "no-op":
        return action.recommendation;
      default:
        throw new Error(`Unsupported PAN action ${action.kind}`);
    }
  }
}

function expectedStateViolation(action, snapshot, current) {
  if (action.kind === "no-op") {
    return undefined;
  }
  if (action.expectedState.snapshotId !== snapshot.id) {
    return "Action does not name the exact portfolio snapshot it reviewed";
  }
  const snapshotOrder = snapshot.project.items;
  const currentOrder = current.items.map((item) => item.id);
  if (
    snapshotOrder.length !== currentOrder.length ||
    snapshotOrder.some((itemId, index) => itemId !== currentOrder[index])
  ) {
    return "The canonical Project order changed while PAN was reasoning";
  }
  if (action.kind !== "field-update") {
    return undefined;
  }
  if (!MODEL_WRITABLE_FIELDS.has(action.target.field)) {
    return `PAN cannot modify operational field ${action.target.field}`;
  }
  const item = snapshot.dossiers.find(
    (dossier) => dossier.item.id === action.target.itemId,
  )?.item;
  if (!item) {
    return "Target item is absent from the portfolio snapshot";
  }
  if (!Object.hasOwn(action.expectedState, action.target.field)) {
    return `Action does not record the expected ${action.target.field} value`;
  }
  const currentItem = current.items.find(
    (candidate) => candidate.id === action.target.itemId,
  );
  const expected = action.expectedState[action.target.field];
  if (
    !currentItem ||
    JSON.stringify(currentItem.fields[action.target.field]) !==
      JSON.stringify(expected) ||
    JSON.stringify(item.fields[action.target.field]) !== JSON.stringify(expected)
  ) {
    return `Expected ${action.target.field} no longer matches GitHub`;
  }
  return undefined;
}

async function confirmOrder(store, expected) {
  const current = await store.readCanonicalProject();
  const actual = current.items.map((item) => item.id);
  if (
    actual.length !== expected.length ||
    actual.some((itemId, index) => itemId !== expected[index])
  ) {
    throw new Error("GitHub did not confirm the requested Project order");
  }
}

async function findIssue(store, issueUrl) {
  const project = await store.readCanonicalProject();
  const item = project.items.find((candidate) => candidate.url === issueUrl);
  if (!item) {
    throw new Error(`Issue is not in the configured Project: ${issueUrl}`);
  }

  return item;
}

function idempotencyMarker(key) {
  const digest = createHash("sha256").update(key).digest("hex");
  return `<!-- pan-action:${digest} -->`;
}

function appendMarker(body, marker) {
  return body.trim() ? `${body.trim()}\n\n${marker}` : marker;
}

async function hasMarker(store, item, marker) {
  const comments = await store.listComments(item);
  return comments.some((comment) => comment.body.includes(marker));
}

function currentPolicySnapshot(current) {
  const capturedAt = current.capturedAt ?? new Date().toISOString();
  return {
    project: { items: current.items.map((item) => item.id) },
    dossiers: current.items.map((item) => ({
      item,
      lease: {
        active:
          Boolean(item.fields?.claimedBy) &&
          Number.isFinite(Date.parse(item.fields?.leaseUntil)) &&
          Date.parse(item.fields.leaseUntil) > Date.parse(capturedAt),
      },
    })),
  };
}

function validateResponseEvidence(response, snapshot) {
  const index = buildEvidenceIndex(snapshot);
  for (const fact of response.facts) {
    assertCitationsResolve(fact.citations, index);
  }
  assertCitationsResolve(response.citations, index);

  const proposedActions = [];
  const rejectedActions = [...response.rejectedActions];
  for (const action of response.proposedActions) {
    try {
      assertCitationsResolve(action.evidence, index);
      proposedActions.push(action);
    } catch (error) {
      rejectedActions.push({
        actionId: action.actionId,
        reason: `PAN cited evidence outside the reviewed snapshot: ${error.message}`,
      });
    }
  }
  return normalizePanFinalResponse({
    ...response,
    proposedActions,
    rejectedActions,
  });
}

function buildEvidenceIndex(snapshot) {
  const byKind = new Map();
  const itemsById = new Map();
  const runnersById = new Map();
  addEvidence(byKind, "domain-record", snapshot.id);
  addEvidence(byKind, "domain-record", snapshot.project.id);
  addEvidence(
    byKind,
    "domain-record",
    snapshot.workstreams?.revision,
  );
  for (const dossier of snapshot.dossiers ?? []) {
    const { item, workstream } = dossier;
    itemsById.set(item.id, item);
    const issueRevisions = [item.updatedAt].filter(Boolean);
    for (const locator of [
      item.id,
      item.url,
      item.number !== undefined ? String(item.number) : undefined,
      item.number !== undefined ? `#${item.number}` : undefined,
      item.repository && item.number !== undefined
        ? `${item.repository}#${item.number}`
        : undefined,
    ]) {
      addEvidence(byKind, "issue", locator, issueRevisions);
    }
    addEvidence(byKind, "project-field", item.id, issueRevisions);
    for (const field of Object.keys(item.fields ?? {})) {
      addEvidence(
        byKind,
        "project-field",
        `${item.id}:${field}`,
        issueRevisions,
      );
      if (item.url) {
        addEvidence(
          byKind,
          "project-field",
          `${item.url}:${field}`,
          issueRevisions,
        );
      }
    }
    for (const comment of item.comments ?? []) {
      const revisions = [comment.updatedAt, comment.createdAt].filter(Boolean);
      addEvidence(byKind, "issue-comment", comment.id, revisions);
      addEvidence(byKind, "issue-comment", comment.url, revisions);
    }
    const workstreamRevisions = [
      workstream?.revision,
      ...(workstream?.history ?? []).map((history) => history.sha),
    ].filter(Boolean);
    addEvidence(
      byKind,
      "workstream",
      workstream?.path,
      workstreamRevisions,
    );
    addEvidence(
      byKind,
      "workstream",
      workstream?.path
        ? `workstreams/${workstream.path}/README.md`
        : undefined,
      workstreamRevisions,
    );
    for (const history of workstream?.history ?? []) {
      addEvidence(
        byKind,
        "workstream",
        history.changedPath,
        workstreamRevisions,
      );
    }
  }
  for (const runner of snapshot.runnerAvailability?.runners ?? []) {
    runnersById.set(runner.id, runner);
    addEvidence(byKind, "runner", runner.id);
  }
  return { byKind, itemsById, runnersById };
}

function assertCitationsResolve(citations, index) {
  for (const citation of citations) {
    if (!citationResolves(citation, index)) {
      throw new Error(
        `unknown locator ${citation.locator} for ${citation.kind} evidence; cite a snapshot locator or value assertions that match the snapshot`,
      );
    }
  }
}

function citationResolves(citation, index) {
  const kindIndex = index.byKind.get(citation.kind);
  if (!kindIndex) {
    return false;
  }
  const direct = kindIndex.get(citation.locator);
  if (direct && revisionResolves(citation.revision, direct)) {
    return true;
  }
  const revisionSeparator = citation.locator.lastIndexOf("@");
  if (revisionSeparator > 0) {
    const locator = citation.locator.slice(0, revisionSeparator);
    const revision = citation.locator.slice(revisionSeparator + 1);
    const revisions = kindIndex.get(locator);
    if (revisions?.has(revision)) {
      return true;
    }
  }
  if (citation.kind === "project-field") {
    return assertionLocatorResolves(
      citation,
      index.itemsById,
      kindIndex,
      (item) => item.fields ?? {},
    );
  }
  if (citation.kind === "runner") {
    return assertionLocatorResolves(
      citation,
      index.runnersById,
      kindIndex,
      (runner) => runner,
    );
  }
  return false;
}

function assertionLocatorResolves(citation, recordsById, kindIndex, valuesFor) {
  for (const [recordId, record] of recordsById) {
    const colonPrefix = `${recordId}:`;
    const spacePrefix = `${recordId} `;
    const prefix = citation.locator.startsWith(colonPrefix)
      ? colonPrefix
      : citation.locator.startsWith(spacePrefix)
        ? spacePrefix
        : undefined;
    if (!prefix) {
      continue;
    }
    const assertions = citation.locator
      .slice(prefix.length)
      .split(",")
      .map((assertion) => assertion.trim());
    const values = valuesFor(record);
    const fieldsMatch = assertions.every((assertion) => {
      const separator = assertion.indexOf("=");
      if (separator === -1) {
        if (assertion === "fields") {
          return values && typeof values === "object";
        }
        const field = assertion.replace(/^fields\./, "");
        return Object.hasOwn(values, field);
      }
      const field = assertion.slice(0, separator).replace(/^fields\./, "");
      const expected = assertion.slice(separator + 1);
      return Object.hasOwn(values, field) && String(values[field]) === expected;
    });
    if (!fieldsMatch) {
      continue;
    }
    const revisions = kindIndex.get(recordId) ?? new Set();
    if (revisionResolves(citation.revision, revisions)) {
      return true;
    }
  }
  return false;
}

function addEvidence(index, kind, locator, revisions = []) {
  if (!locator) {
    return;
  }
  let kindIndex = index.get(kind);
  if (!kindIndex) {
    kindIndex = new Map();
    index.set(kind, kindIndex);
  }
  let knownRevisions = kindIndex.get(locator);
  if (!knownRevisions) {
    knownRevisions = new Set();
    kindIndex.set(locator, knownRevisions);
  }
  for (const revision of revisions) {
    knownRevisions.add(revision);
  }
}

function revisionResolves(revision, knownRevisions) {
  return !revision || knownRevisions.has(revision);
}

function incompleteEffect(action, error) {
  return {
    actionId: action.actionId,
    summary: `Leadership was lost while applying the action; GitHub may contain a partial effect: ${error.message}`,
    citations: action.evidence,
    remainingSteps: [
      "Refresh the canonical Project and reconcile the action by its idempotency key before retrying.",
    ],
  };
}
