import path from "node:path";

import { ActionPolicy } from "./action-policy.js";
import { validatePanAction } from "./pan-protocol.js";

const OPERATION_NAMES = Object.freeze([
  "read_portfolio",
  "read_canonical_items",
  "read_issue",
  "read_issue_comments",
  "read_workstream",
  "search_workstreams",
  "read_workstream_history",
  "read_current_rationale",
  "read_runner_availability",
  "read_unresolved_attention",
  "propose_actions",
  "propose_field_change",
  "propose_reorder",
  "propose_relative_precedence",
  "propose_issue",
  "propose_comment",
  "propose_question",
  "propose_noop",
]);
const MAX_SEARCH_LENGTH = 1_000;
const MAX_SEARCH_RESULTS = 100;
const MAX_HISTORY_RESULTS = 50;

const MUTABLE_FIELDS = new Set([
  "status",
  "owner",
  "priority",
  "autonomy",
  "requirements",
  "workstream",
  "rationale",
  "reviewAt",
]);

const PROPOSAL_KIND_BY_OPERATION = Object.freeze({
  propose_field_change: "field-update",
  propose_reorder: "canonical-reorder",
  propose_relative_precedence: "relative-precedence",
  propose_issue: "issue-create",
  propose_comment: "issue-comment",
  propose_question: "needs-human",
  propose_noop: "no-op",
});

export class PanToolRegistry {
  constructor({
    domain,
    snapshotSource,
    projectSource,
    workstreamSource,
    runnerSource,
    attentionSource,
    actionPolicy = new ActionPolicy(),
  }) {
    this.domain = normalizeDomain(domain);
    requireMethod(snapshotSource, "build", "snapshotSource");
    requireMethod(projectSource, "readCanonicalProject", "projectSource");
    requireMethod(workstreamSource, "read", "workstreamSource");
    requireMethod(workstreamSource, "search", "workstreamSource");
    requireMethod(workstreamSource, "history", "workstreamSource");
    requireMethod(runnerSource, "loadAvailability", "runnerSource");
    if (attentionSource !== undefined) {
      requireMethod(attentionSource, "inbox", "attentionSource");
    }
    if (!actionPolicy?.assess) {
      throw new TypeError("actionPolicy must provide assess()");
    }
    validateSourceBindings(this.domain, projectSource, workstreamSource);

    this.snapshotSource = snapshotSource;
    this.projectSource = projectSource;
    this.workstreamSource = workstreamSource;
    this.runnerSource = runnerSource;
    this.attentionSource = attentionSource;
    this.actionPolicy = actionPolicy;
    this.operations = OPERATION_NAMES;
    Object.freeze(this);
  }

  async dispatch(operation, args = {}) {
    if (!OPERATION_NAMES.includes(operation)) {
      throw toolError(
        "unknown-operation",
        `PAN operation ${String(operation)} is not allowed`,
      );
    }
    requireRecord(args, "arguments");

    try {
      const data = await this.#dispatchValidated(operation, args);
      return Object.freeze({ operation, status: "confirmed", ...data });
    } catch (error) {
      if (error instanceof PanToolError) {
        throw error;
      }
      throw toolError(
        "domain-read-failed",
        `PAN operation ${operation} could not read configured domain evidence`,
      );
    }
  }

  async #dispatchValidated(operation, args) {
    switch (operation) {
      case "read_portfolio": {
        exactKeys(args, [], "arguments");
        const snapshot = validatePortfolioDomain(
          await this.snapshotSource.build(),
          this.domain,
        );
        return {
          snapshotReference: {
            field: "actions[].expectedState.snapshotId",
            value: snapshot.id,
            usableForMutation: snapshot.usableForMutation === true,
          },
          data: snapshot,
        };
      }
      case "read_canonical_items":
        exactKeys(args, [], "arguments");
        return { data: await this.#readProject() };
      case "read_issue": {
        exactKeys(args, ["itemId"], "arguments");
        requireString(args.itemId, "arguments.itemId");
        return { data: await this.#readItem(args.itemId) };
      }
      case "read_issue_comments": {
        exactKeys(args, ["itemId"], "arguments");
        requireString(args.itemId, "arguments.itemId");
        const item = await this.#readItem(args.itemId);
        return { data: item.comments ?? [] };
      }
      case "read_workstream": {
        exactKeys(args, ["path"], "arguments");
        validateWorkstream(args.path, "arguments.path");
        return {
          data: normalizeWorkstreamRead(
            await this.workstreamSource.read(args.path),
          ),
        };
      }
      case "search_workstreams": {
        exactKeys(
          args,
          ["query", "caseSensitive", "limit"],
          "arguments",
          { required: ["query"] },
        );
        requireString(args.query, "arguments.query");
        if (args.query.length > MAX_SEARCH_LENGTH) {
          throw toolError(
            "invalid-arguments",
            `arguments.query must not exceed ${MAX_SEARCH_LENGTH} characters`,
          );
        }
        optionalBoolean(args.caseSensitive, "arguments.caseSensitive");
        optionalBoundedInteger(
          args.limit,
          MAX_SEARCH_RESULTS,
          "arguments.limit",
        );
        return {
          data: normalizeWorkstreamSearch(
            await this.workstreamSource.search(args.query, {
              ...(args.caseSensitive === undefined
                ? {}
                : { caseSensitive: args.caseSensitive }),
              ...(args.limit === undefined ? {} : { limit: args.limit }),
            }),
          ),
        };
      }
      case "read_workstream_history": {
        exactKeys(args, ["path", "limit"], "arguments", {
          required: ["path"],
        });
        validateWorkstream(args.path, "arguments.path");
        optionalBoundedInteger(
          args.limit,
          MAX_HISTORY_RESULTS,
          "arguments.limit",
        );
        return {
          data: normalizeWorkstreamHistory(
            await this.workstreamSource.history(args.path, {
              ...(args.limit === undefined ? {} : { limit: args.limit }),
            }),
          ),
        };
      }
      case "read_current_rationale": {
        exactKeys(args, ["itemId"], "arguments");
        requireString(args.itemId, "arguments.itemId");
        const item = await this.#readItem(args.itemId);
        return {
          data: {
            itemId: item.id,
            rationale: item.fields?.rationale ?? "",
            reviewAt: item.fields?.reviewAt ?? "",
          },
        };
      }
      case "read_runner_availability":
        exactKeys(args, [], "arguments");
        return {
          data: normalizeRunnerAvailability(
            await this.runnerSource.loadAvailability(),
          ),
        };
      case "read_unresolved_attention":
        exactKeys(args, [], "arguments");
        return {
          data: this.attentionSource
            ? normalizeAttention(await this.attentionSource.inbox())
            : deriveAttention(
                (await this.#readProject()).items,
              ),
        };
      case "propose_actions":
        exactKeys(args, ["actions"], "arguments");
        if (!Array.isArray(args.actions) || args.actions.length === 0) {
          throw toolError(
            "invalid-arguments",
            "arguments.actions must be a non-empty array",
          );
        }
        return this.#propose(args.actions);
      default: {
        exactKeys(args, ["action"], "arguments");
        const expectedKind = PROPOSAL_KIND_BY_OPERATION[operation];
        return this.#propose([args.action], expectedKind);
      }
    }
  }

  async #readItem(itemId) {
    const project = await this.#readProject();
    const item = project.items.find((candidate) => candidate.id === itemId);
    if (!item || item.repository !== this.domain.repository) {
      throw toolError(
        "item-not-found",
        `Project item ${itemId} was not found in the configured domain`,
      );
    }
    return item;
  }

  async #readProject() {
    return validateProjectDomain(
      await this.projectSource.readCanonicalProject(),
      this.domain,
    );
  }

  async #propose(actions, expectedKind) {
    const normalized = actions.map((action, index) => {
      validateStrictAction(action, `arguments.actions[${index}]`);
      let validated;
      try {
        validated = validatePanAction(
          action,
          `arguments.actions[${index}]`,
        );
      } catch (error) {
        throw toolError("invalid-action", error.message);
      }
      if (expectedKind && validated.kind !== expectedKind) {
        throw toolError(
          "invalid-action-kind",
          `The requested proposal operation requires action kind ${expectedKind}`,
        );
      }
      validateActionDomain(validated, this.domain);
      return validated;
    });

    const needsSnapshot = normalized.some(actionTouchesExistingItem);
    const snapshot = needsSnapshot
      ? await this.snapshotSource.build()
      : undefined;
    if (snapshot && snapshot.usableForMutation !== true) {
      throw toolError(
        "incomplete-evidence",
        "The portfolio snapshot is incomplete; refresh domain evidence before proposing mutations",
      );
    }

    const proposals = [];
    const rejected = [];
    for (const action of normalized) {
      const policy = this.actionPolicy.assess(action, {
        snapshot,
        mode: "proposal",
      });
      if (policy.allowed) {
        proposals.push({ action, policy });
      } else {
        rejected.push({
          actionId: action.actionId,
          reasons: [...policy.reasons],
        });
      }
    }
    return { proposals, rejected };
  }
}

export class PanToolError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PanToolError";
    this.code = code;
  }
}

function normalizeDomain(domain) {
  requireRecord(domain, "domain");
  exactKeys(
    domain,
    ["repository", "projectOwner", "projectNumber", "path"],
    "domain",
  );
  if (!/^[^/\s]+\/[^/\s]+$/.test(domain.repository ?? "")) {
    throw new TypeError("domain.repository must be owner/name");
  }
  requireString(domain.projectOwner, "domain.projectOwner");
  if (!Number.isInteger(domain.projectNumber) || domain.projectNumber < 1) {
    throw new TypeError("domain.projectNumber must be a positive integer");
  }
  if (!path.isAbsolute(domain.path ?? "")) {
    throw new TypeError("domain.path must be absolute");
  }
  return Object.freeze({
    repository: domain.repository,
    projectOwner: domain.projectOwner,
    projectNumber: domain.projectNumber,
    path: path.resolve(domain.path),
  });
}

function validateSourceBindings(domain, projectSource, workstreamSource) {
  for (const [property, expected] of [
    ["repository", domain.repository],
    ["projectOwner", domain.projectOwner],
    ["projectNumber", domain.projectNumber],
  ]) {
    if (
      projectSource[property] !== undefined &&
      projectSource[property] !== expected
    ) {
      throw new TypeError(
        `projectSource ${property} does not match the configured domain`,
      );
    }
  }
  if (
    workstreamSource.repositoryPath !== undefined &&
    path.resolve(workstreamSource.repositoryPath) !== domain.path
  ) {
    throw new TypeError(
      "workstreamSource repositoryPath does not match the configured domain",
    );
  }
}

function validateProjectDomain(project, domain) {
  if (!project || !Array.isArray(project.items)) {
    throw toolError(
      "invalid-domain-evidence",
      "The configured Project returned an invalid canonical read",
    );
  }
  if (
    project.items.some(
      (item) => item.repository !== domain.repository,
    )
  ) {
    throw toolError(
      "cross-domain-evidence",
      "The configured Project returned an item from another domain",
    );
  }
  return project;
}

function validatePortfolioDomain(snapshot, domain) {
  if (
    !snapshot ||
    !Array.isArray(snapshot.dossiers) ||
    snapshot.dossiers.some(
      (dossier) => dossier.item?.repository !== domain.repository,
    )
  ) {
    throw toolError(
      "cross-domain-evidence",
      "The portfolio snapshot does not match the configured domain",
    );
  }
  return snapshot;
}

function validateActionDomain(action, domain) {
  if (
    action.kind === "issue-create" &&
    action.target.repository !== domain.repository
  ) {
    throw toolError(
      "cross-domain-action",
      "Issue creation must target the configured domain repository",
    );
  }
  if (
    ["issue-comment", "needs-human"].includes(action.kind) &&
    !isDomainIssueUrl(
      action.target.issueUrl,
      domain.repository,
    )
  ) {
    throw toolError(
      "cross-domain-action",
      "Issue actions must target an Issue in the configured domain repository",
    );
  }
  if (
    action.kind === "issue-create" &&
    action.target.workstream !== undefined
  ) {
    validateWorkstream(
      action.target.workstream,
      "action.target.workstream",
    );
  }
  if (action.kind === "field-update") {
    if (!MUTABLE_FIELDS.has(action.target.field)) {
      throw toolError(
        "unsupported-field",
        `Field ${action.target.field} is not available to PAN`,
      );
    }
    if (action.target.field === "workstream") {
      validateWorkstream(action.target.value, "action.target.value");
    }
  }
}

function validateStrictAction(action, name) {
  requireRecord(action, name);
  const base = [
    "version",
    "actionId",
    "kind",
    "rationale",
    "confidence",
    "evidence",
  ];
  if (action.kind === "no-op") {
    exactKeys(action, [...base, "recommendation"], name);
  } else {
    exactKeys(
      action,
      [...base, "idempotencyKey", "expectedState", "target"],
      name,
    );
  }
  if (Array.isArray(action.evidence)) {
    action.evidence.forEach((citation, index) =>
      exactKeys(
        citation,
        ["kind", "locator", "revision", "label"],
        `${name}.evidence[${index}]`,
        { required: ["kind", "locator"] },
      ),
    );
  }
  const targetKeys = {
    "field-update": ["itemId", "field", "value"],
    "canonical-reorder": ["orderedItemIds"],
    "relative-precedence": ["beforeItemId", "afterItemId"],
    "issue-create": ["repository", "title", "body", "workstream"],
    "issue-comment": ["issueUrl", "body"],
    "needs-human": ["issueUrl", "prompt", "kind"],
  }[action.kind];
  if (targetKeys) {
    exactKeys(action.target, targetKeys, `${name}.target`, {
      required:
        action.kind === "issue-create"
          ? ["repository", "title"]
          : targetKeys,
    });
  }
}

function actionTouchesExistingItem(action) {
  return [
    "field-update",
    "canonical-reorder",
    "relative-precedence",
  ].includes(action.kind);
}

function normalizeWorkstreamRead(read) {
  return {
    path: read.path,
    sourcePath: read.sourcePath,
    content: read.content,
    contentHash: read.contentHash,
    modifiedAt: read.modifiedAt,
    revision: read.revision,
  };
}

function normalizeWorkstreamSearch(result) {
  return {
    revision: result.revision,
    complete: result.complete === true,
    limited: result.limited === true,
    matches: (result.matches ?? []).map((match) => ({
      path: match.path,
      sourcePath: match.sourcePath,
      startLine: match.startLine,
      endLine: match.endLine,
      text: match.text,
    })),
    errors: (result.errors ?? []).map((error) => ({
      path: error.path,
      reason: "Workstream content was unavailable or malformed",
    })),
  };
}

function normalizeWorkstreamHistory(entries) {
  return entries.map((entry) => ({
    sha: entry.sha,
    committedAt: entry.committedAt,
    subject: entry.subject,
    changedPath: entry.changedPath,
  }));
}

function normalizeRunnerAvailability(result) {
  return {
    complete: result.complete === true,
    runners: (result.runners ?? []).map((runner) => ({
      id: runner.id,
      online: runner.online,
      capabilities: [...runner.capabilities],
      maximumCapacity: runner.maximumCapacity,
      activeLeaseCount: runner.activeLeaseCount,
      freeCapacity: runner.freeCapacity,
      capacityKnown: runner.capacityKnown,
    })),
    diagnostics: (result.diagnostics ?? []).map((diagnostic) => ({
      runnerId: diagnostic.runnerId,
      code: diagnostic.code,
      message: diagnostic.runnerId
        ? `Runner ${diagnostic.runnerId} availability is incomplete`
        : "Runner availability is incomplete",
    })),
  };
}

function normalizeAttention(entries) {
  return entries.map((entry) => ({
    id: entry.id,
    itemId: entry.itemId,
    title: entry.title,
    status: entry.status,
    priority: entry.priority,
    issueUrl: entry.issueUrl,
    kind: entry.kind,
    prompt: entry.prompt,
    pullRequestUrl: entry.pullRequestUrl,
  }));
}

function deriveAttention(items) {
  return items
    .filter(
      (item) =>
        item.state !== "closed" && item.fields?.status === "in-review",
    )
    .map((item) => ({
      id: item.number ?? item.id,
      itemId: item.id,
      title: item.title,
      status: item.fields.status,
      priority: item.fields.priority,
      issueUrl: item.url,
      kind: "review",
      prompt: "Review the completed work.",
    }));
}

function validateWorkstream(value, name) {
  requireString(value, name);
  if (
    value.includes("\\") ||
    path.isAbsolute(value) ||
    value.startsWith("/") ||
    value
      .split("/")
      .some(
        (segment) =>
          !segment || segment === "." || segment === "..",
      )
  ) {
    throw toolError(
      "invalid-workstream",
      `${name} must be a confined workstream path`,
    );
  }
}

function isDomainIssueUrl(value, repository) {
  try {
    const url = new URL(value);
    const repositoryPath = repository.replace(
      /[.*+?^${}()|[\]\\]/g,
      "\\$&",
    );
    return (
      url.protocol === "https:" &&
      url.hostname === "github.com" &&
      new RegExp(`^/${repositoryPath}/issues/\\d+(?:/|$)`).test(
        url.pathname,
      )
    );
  } catch {
    return false;
  }
}

function exactKeys(
  value,
  allowed,
  name,
  { required = allowed } = {},
) {
  requireRecord(value, name);
  const allowedSet = new Set(allowed);
  const unexpected = Object.keys(value).filter(
    (key) => !allowedSet.has(key),
  );
  if (unexpected.length > 0) {
    throw toolError(
      "invalid-arguments",
      `${name} contains unknown properties: ${unexpected.join(", ")}`,
    );
  }
  const missing = required.filter((key) => !Object.hasOwn(value, key));
  if (missing.length > 0) {
    throw toolError(
      "invalid-arguments",
      `${name} is missing required properties: ${missing.join(", ")}`,
    );
  }
}

function requireMethod(value, method, name) {
  if (typeof value?.[method] !== "function") {
    throw new TypeError(`${name} must provide ${method}()`);
  }
}

function requireRecord(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw toolError("invalid-arguments", `${name} must be an object`);
  }
}

function requireString(value, name) {
  if (typeof value !== "string" || !value.trim()) {
    throw toolError(
      "invalid-arguments",
      `${name} must be a non-empty string`,
    );
  }
}

function optionalBoolean(value, name) {
  if (value !== undefined && typeof value !== "boolean") {
    throw toolError("invalid-arguments", `${name} must be boolean`);
  }
}

function optionalBoundedInteger(value, maximum, name) {
  if (
    value !== undefined &&
    (!Number.isInteger(value) || value < 1 || value > maximum)
  ) {
    throw toolError(
      "invalid-arguments",
      `${name} must be an integer from 1 through ${maximum}`,
    );
  }
}

function toolError(code, message) {
  return new PanToolError(code, message);
}

export const PAN_TOOL_OPERATIONS = OPERATION_NAMES;
