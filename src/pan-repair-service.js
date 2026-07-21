import { createHash } from "node:crypto";

const PULL_REQUEST_REQUIREMENT = "delivery:pull-request";
const MAX_TITLE_LENGTH = 180;
const MAX_STACK_LENGTH = 12_000;
const MAX_DETAILS_LENGTH = 12_000;
const ACTIVE_REPAIR_STATUSES = new Set([
  "in-progress",
  "in-review",
  "blocked",
  "done",
]);

export class PanRepairService {
  constructor({ store, policy, now = () => new Date() }) {
    if (
      !store?.findIssueByMarker ||
      !store?.createItem ||
      !store?.readCanonicalProject ||
      !store?.addIssueToProject ||
      !store?.setFields
    ) {
      throw new TypeError(
        "store must provide repair Issue and Project operations",
      );
    }
    if (
      !policy?.enabled ||
      !policy.repository ||
      !policy.workstream ||
      !Array.isArray(policy.requirements)
    ) {
      throw new TypeError("an enabled self-repair policy is required");
    }
    this.store = store;
    this.policy = policy;
    this.now = now;
  }

  async reportFailure(
    error,
    { source = "scheduled-review", model, signal } = {},
  ) {
    signal?.throwIfAborted();
    const failure = normalizeFailure(error);
    const fingerprint = createHash("sha256")
      .update(
        `${source}\n${failure.name}\n${failure.message}\n${failure.fingerprintDetails ?? ""}`,
      )
      .digest("hex")
      .slice(0, 20);
    const marker = `<!-- pan:self-repair:${fingerprint} -->`;
    const existing = await this.store.findIssueByMarker(marker, {
      state: "open",
      signal,
    });
    if (existing) {
      await this.#reconcileExisting(existing, signal);
      return {
        created: false,
        fingerprint,
        issueNumber: existing.number,
        issueUrl: existing.url,
      };
    }

    signal?.throwIfAborted();
    const item = await this.store.createItem(
      {
        title: truncate(
          `Investigate PAN host failure: ${failure.message}`,
          MAX_TITLE_LENGTH,
        ),
        body: repairTaskBody({
          failure,
          fingerprint,
          marker,
          model,
          observedAt: this.now().toISOString(),
          source,
          repository: this.policy.repository,
        }),
        fields: repairFields(this.policy),
      },
      { signal },
    );
    return {
      created: true,
      fingerprint,
      issueNumber: item.number,
      issueUrl: item.url,
    };
  }

  async #reconcileExisting(issue, signal) {
    const fields = repairFields(this.policy);
    const project = await this.store.readCanonicalProject();
    signal?.throwIfAborted();
    const item = project.items.find((candidate) => candidate.url === issue.url);
    if (!item) {
      await this.store.addIssueToProject(issue.url, fields, { signal });
      return;
    }
    if (ACTIVE_REPAIR_STATUSES.has(item.fields.status)) {
      return;
    }
    if (!matchesRepairFields(item, fields)) {
      await this.store.setFields(item.id, fields, { signal });
    }
  }
}

function normalizeFailure(error) {
  const name =
    typeof error?.name === "string" && error.name.trim()
      ? error.name.trim()
      : "Error";
  const message =
    typeof error?.message === "string" && error.message.trim()
      ? error.message.trim()
      : String(error);
  const stack =
    typeof error?.stack === "string" && error.stack.trim()
      ? truncate(error.stack.trim(), MAX_STACK_LENGTH)
      : `${name}: ${message}`;
  const details =
    error?.result === undefined
      ? undefined
      : truncate(stableStringify(error.result), MAX_DETAILS_LENGTH);
  const fingerprintDetails = repairFingerprintDetails(error?.result);
  return { name, message, stack, details, fingerprintDetails };
}

function repairTaskBody({
  failure,
  fingerprint,
  marker,
  model,
  observedAt,
  source,
  repository,
}) {
  return [
    "PAN automatically created this task after its foreground host encountered an unexpected failure.",
    "",
    "## Failure",
    "",
    `- Source: \`${source}\``,
    `- Observed: \`${observedAt}\``,
    `- Model: \`${model ?? "auto"}\``,
    `- Fingerprint: \`${fingerprint}\``,
    "",
    "```text",
    failure.stack,
    "```",
    ...(failure.details
      ? [
          "",
          "### Structured failure details",
          "",
          "```json",
          failure.details,
          "```",
        ]
      : []),
    "",
    "## Acceptance criteria",
    "",
    "- Investigate the root cause using the current repository code and the failure evidence above.",
    "- Distinguish a PAN code defect from malformed or incomplete domain data; do not hide data-integrity failures.",
    `- If ${repository} should change, implement the smallest safe generic fix and cover it with a regression test.`,
    "- Preserve PAN's fail-closed mutation behavior and provide actionable diagnostics for conditions that still require data or human repair.",
    "- Run the relevant existing tests and checks.",
    "- Deliver the change as a pull request for review; do not merge it.",
    "",
    marker,
  ].join("\n");
}

function repairFields(policy) {
  return {
    owner: "agent",
    status: "ready",
    priority: "high",
    autonomy: "full-auto",
    requirements: [
      `repo:${policy.repository}`,
      PULL_REQUEST_REQUIREMENT,
      ...policy.requirements,
    ],
    workstream: policy.workstream,
  };
}

function matchesRepairFields(item, expected) {
  return (
    item.fields.owner === expected.owner &&
    item.fields.status === expected.status &&
    item.fields.priority === expected.priority &&
    item.fields.autonomy === expected.autonomy &&
    item.fields.workstream === expected.workstream &&
    item.requirements.length === expected.requirements.length &&
    item.requirements.every(
      (requirement, index) => requirement === expected.requirements[index],
    )
  );
}

function stableStringify(value, seen = new WeakSet()) {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry, seen)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    if (seen.has(value)) {
      return JSON.stringify("[Circular]");
    }
    seen.add(value);
    const result = `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${stableStringify(value[key], seen)}`,
      )
      .join(",")}}`;
    seen.delete(value);
    return result;
  }
  const serialized = JSON.stringify(value);
  return serialized === undefined ? JSON.stringify(String(value)) : serialized;
}

function repairFingerprintDetails(result) {
  if (result === undefined) {
    return undefined;
  }
  const incomplete = result?.response?.effects?.incomplete;
  if (!Array.isArray(incomplete)) {
    return stableStringify(result);
  }
  return stableStringify(
    incomplete.map((effect) => ({
      summary: effect.summary,
      remainingSteps: effect.remainingSteps,
    })),
  );
}

function truncate(value, limit) {
  return value.length <= limit ? value : `${value.slice(0, limit - 3)}...`;
}
