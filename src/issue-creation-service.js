import { createHash } from "node:crypto";

const INITIAL_FIELDS = Object.freeze({
  owner: "unassigned",
  status: "untriaged",
  priority: "normal",
  autonomy: "manual",
  requirements: [],
});

/**
 * Creates source-backed Issues and recovers their Project registration safely.
 */
export class IssueCreationService {
  constructor({
    store,
    assertLeadership = async () => ({ asserted: true }),
    minimumConfidence = 0.8,
  } = {}) {
    if (
      !store?.readIssueCatalog ||
      !store?.createIssue ||
      !store?.ensureIssueProjectMembership ||
      !store?.ensureItemFields
    ) {
      throw new TypeError("store must provide Issue creation and reconciliation primitives");
    }
    if (typeof assertLeadership !== "function") {
      throw new TypeError("assertLeadership must be a function");
    }
    this.store = store;
    this.assertLeadership = assertLeadership;
    this.minimumConfidence = minimumConfidence;
  }

  async create(action, { identity } = {}) {
    const candidateError = validateCandidate(action, this.minimumConfidence);
    if (candidateError) {
      throw new Error(candidateError);
    }

    const catalog = await this.store.readIssueCatalog();
    if (!catalog.complete) {
      throw new Error("Complete open and closed Issue evidence is required before creating sourced work");
    }
    if (
      action.expectedState.issueCatalog &&
      action.expectedState.issueCatalog.revision !== catalog.id
    ) {
      throw new Error("Issue catalog changed while PAN was reasoning");
    }

    const marker = idempotencyMarker(action.idempotencyKey);
    const existing = findExisting(catalog.issues, action, marker);
    if (existing) {
      if (existing.state !== "open") {
        return suppressed(existing, marker);
      }
      return this.#register(existing, action, marker, identity);
    }

    await this.#assertLeadership(identity);
    const issue = await this.store.createIssue({
      title: action.target.title,
      body: appendMarker(action.target.body ?? "", marker),
    }, { beforeWrite: () => this.#assertLeadership(identity) });
    if (!issue?.url || !issue.number) {
      throw new Error("GitHub did not confirm the sourced Issue identity");
    }
    return this.#register(issue, action, marker, identity, { created: true });
  }

  async #register(issue, action, marker, identity, { created = false } = {}) {
    const fields = {
      ...INITIAL_FIELDS,
      ...(action.target.workstream ? { workstream: action.target.workstream } : {}),
    };
    const confirmedState = {
      number: issue.number,
      issueUrl: issue.url,
      marker,
      created,
    };
    const recovery = [];
    const remainingSteps = [];

    try {
      await this.#assertLeadership(identity);
      const membership = await this.store.ensureIssueProjectMembership(issue.url, {
        beforeWrite: () => this.#assertLeadership(identity),
      });
      confirmedState.projectItemId = membership.item.id;
      confirmedState.projectRegistered = true;
      confirmedState.projectAdded = membership.added;
    } catch (error) {
      recovery.push(message(error));
      remainingSteps.push("Register the confirmed Issue in the canonical Project.");
      return incomplete(issue, marker, confirmedState, recovery, remainingSteps);
    }

    try {
      await this.#assertLeadership(identity);
      const fieldsResult = await this.store.ensureItemFields(
        confirmedState.projectItemId,
        fields,
        { beforeWrite: () => this.#assertLeadership(identity) },
      );
      confirmedState.confirmedFields = fieldsResult.confirmedFields;
      if (!fieldsResult.complete) {
        recovery.push(fieldsResult.error ?? "Project field initialization was not confirmed.");
        remainingSteps.push(
          `Initialize remaining Project fields: ${fieldsResult.remainingFields.join(", ")}.`,
        );
        return incomplete(issue, marker, confirmedState, recovery, remainingSteps);
      }
      confirmedState.status = "registered";
      return {
        resource: "issue",
        externalIdentity: issue.url,
        confirmedState,
        recovery: [],
      };
    } catch (error) {
      recovery.push(message(error));
      remainingSteps.push("Initialize the confirmed Issue's Project fields.");
      return incomplete(issue, marker, confirmedState, recovery, remainingSteps);
    }
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

function validateCandidate(action, minimumConfidence) {
  if (!action.evidence?.length) {
    return "Sourced Issue creation requires a durable evidence location";
  }
  if (!action.expectedState.issueCatalog?.revision) {
    return "Sourced Issue creation requires an Issue catalog revision";
  }
  if (!action.target.title?.trim() || !action.rationale?.trim()) {
    return "Sourced Issue creation requires an interpreted action and specific rationale";
  }
  if (action.confidence < minimumConfidence) {
    return "Ambiguous or low-confidence sourced work must be a recommendation or human question";
  }
  return undefined;
}

function findExisting(issues, action, marker) {
  const title = normalize(action.target.title);
  return issues.find(
    (issue) =>
      issue.body?.includes(marker) ||
      normalize(issue.title) === title,
  );
}

function suppressed(issue, marker) {
  return {
    resource: "issue",
    externalIdentity: issue.url,
    confirmedState: {
      number: issue.number,
      issueUrl: issue.url,
      marker,
      status: "suppressed",
      reason: "A matching sourced Issue is closed or rejected.",
    },
    recovery: [],
  };
}

function incomplete(issue, marker, confirmedState, recovery, remainingSteps) {
  return {
    resource: "issue",
    externalIdentity: issue.url,
    confirmedState: { ...confirmedState, status: "incomplete" },
    recovery,
    remainingSteps,
  };
}

function idempotencyMarker(key) {
  return `<!-- pan-action:${createHash("sha256").update(key).digest("hex")} -->`;
}

function appendMarker(body, marker) {
  return body.trim() ? `${body.trim()}\n\n${marker}` : marker;
}

function normalize(value) {
  return value.trim().replaceAll(/\s+/g, " ").toLowerCase();
}

function message(error) {
  return error instanceof Error ? error.message : String(error);
}
