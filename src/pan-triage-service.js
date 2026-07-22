import { createHash } from "node:crypto";

import {
  formatNeedsHuman,
  formatNeedsHumanResolved,
  latestAttention,
} from "./needs-human.js";
import {
  formatTriageApplied,
  formatTriageDecision,
  hasTriageApplied,
  hasTriageDecision,
  triageAppliedMarker,
  triageDecisionMarker,
  unappliedTriageDecisions,
} from "./triage-audit.js";
import { deriveTriage } from "./triage-policy.js";

const PROTECTED_STATUSES = new Set(["in-progress", "in-review", "done"]);

export class PanTriageService {
  constructor({ store, workstreamSource, runnerSource, attention }) {
    if (
      !store?.syncOpenIssues ||
      !store?.getItem ||
      !store?.setFields ||
      !store?.addComment ||
      !store?.listComments
    ) {
      throw new TypeError("store does not provide the required triage operations");
    }
    if (!workstreamSource?.list || !runnerSource?.loadAvailability) {
      throw new TypeError(
        "workstreamSource and runnerSource are required for triage",
      );
    }
    this.store = store;
    this.workstreamSource = workstreamSource;
    this.runnerSource = runnerSource;
    this.attention = attention;
  }

  async run({ signal } = {}) {
    const [items, context] = await Promise.all([
      this.store.syncOpenIssues({
        beforeMutation: () => signal?.throwIfAborted(),
      }),
      this.#loadContext(),
    ]);

    const summary = {
      inspected: 0,
      triaged: 0,
      needsDetail: 0,
      blocked: 0,
    };
    for (const item of items) {
      signal?.throwIfAborted();
      if (
        !item.number ||
        item.state === "closed" ||
        PROTECTED_STATUSES.has(item.fields.status)
      ) {
        continue;
      }
      summary.inspected += 1;
      const comments =
        item.comments?.length > 0
          ? item.comments
          : await this.store.listComments(item);
      await this.#reconcileApplied(item, comments, signal);
      const triage = deriveTriage(item, comments, context);
      const changed = changedFields(item.fields, triage.fields);
      if (Object.keys(changed).length > 0) {
        await this.#apply(item, comments, triage, changed, signal);
        summary.triaged += 1;
      }

      const refreshed = await this.store.getItem(item.id, { signal });
      const refreshedComments = await this.store.listComments(refreshed);
      const refreshedTriage = deriveTriage(
        refreshed,
        refreshedComments,
        await this.#loadContext(),
      );
      if (refreshedTriage.prompt) {
        summary.needsDetail += 1;
        await this.#requestDetail(
          refreshed,
          refreshedComments,
          refreshedTriage,
          signal,
        );
      } else {
        await this.#resolveDetail(refreshed, refreshedComments, signal);
      }
      if (refreshedTriage.fields.status === "blocked") {
        summary.blocked += 1;
      }
    }
    return summary;
  }

  async #apply(item, comments, triage, changed, signal) {
    await this.#assertCurrent(item.id, triage.evidenceFingerprint, signal);

    const records = [];
    for (const decision of triage.decisions) {
      if (!Object.hasOwn(changed, decision.field)) {
        continue;
      }
      const record = {
        item: item.url,
        field: decision.field,
        value: decision.value,
        ...(decision.reason ? { reason: decision.reason } : {}),
        rationale: decision.rationale,
        evidence: decision.evidence,
      };
      records.push(record);
      const marker = triageDecisionMarker(record);
      if (!hasTriageDecision(comments, marker)) {
        const body = formatTriageDecision(record);
        await this.store.addComment(item, body, { signal });
        comments.push({ body });
      }
    }

    await this.#assertCurrent(item.id, triage.evidenceFingerprint, signal);
    await this.store.setFields(item.id, orderStatusLast(changed), { signal });
    const confirmed = await this.store.getItem(item.id, { signal });
    const unconfirmed = Object.entries(changed).filter(
      ([field, value]) =>
        serializedField(confirmed.fields[field]) !== serializedField(value),
    );
    if (unconfirmed.length > 0) {
      throw triageError(
        `PAN could not confirm triage fields on ${item.url}: ${unconfirmed
          .map(([field]) => field)
          .join(", ")}`,
        "PAN_TRIAGE_UNCONFIRMED",
      );
    }

    for (const record of records) {
      const marker = triageAppliedMarker(record);
      if (!hasTriageApplied(comments, marker)) {
        const body = formatTriageApplied(record);
        await this.store.addComment(item, body, { signal });
        comments.push({ body });
      }
    }
  }

  async #reconcileApplied(item, comments, signal) {
    const pending = unappliedTriageDecisions(comments).filter(
      (record) => record.item === item.url,
    );
    if (pending.length === 0) {
      return;
    }
    const current = await this.store.getItem(item.id, { signal });
    for (const record of pending) {
      if (
        serializedField(current.fields[record.field]) !==
        serializedField(record.value)
      ) {
        continue;
      }
      signal?.throwIfAborted();
      const marker = triageAppliedMarker(record);
      if (!hasTriageApplied(comments, marker)) {
        const body = formatTriageApplied(record);
        await this.store.addComment(current, body, { signal });
        comments.push({ body });
      }
    }
  }

  async #assertCurrent(itemId, expectedFingerprint, signal) {
    const current = await this.store.getItem(itemId, { signal });
    if (!current || PROTECTED_STATUSES.has(current.fields.status)) {
      throw triageError(
        `PAN triage stopped because ${itemId} changed during review; refresh and retry`,
        "PAN_TRIAGE_STALE",
      );
    }
    const comments = await this.store.listComments(current);
    const triage = deriveTriage(
      current,
      comments,
      await this.#loadContext(),
    );
    if (triage.evidenceFingerprint !== expectedFingerprint) {
      throw triageError(
        `PAN triage stopped because ${itemId} evidence changed during review; refresh and retry`,
        "PAN_TRIAGE_STALE",
      );
    }
  }

  async #loadContext() {
    const [workstreamIndex, runnerAvailability] = await Promise.all([
      this.workstreamSource.list(),
      this.runnerSource.loadAvailability(),
    ]);
    assertCompleteEvidence(workstreamIndex, runnerAvailability);
    return {
      workstreams: workstreamIndex.workstreams,
      runners: runnerAvailability.runners,
    };
  }

  async #requestDetail(item, comments, triage, signal) {
    const marker = questionMarker(item, triage.prompt);
    if (this.attention?.requestDetail) {
      await this.attention.requestDetail(
        item,
        {
          kind: "question",
          prompt: triage.prompt,
          source: "pan",
          reason: "triage-metadata",
          locator: { issue: item.url },
          evidence: uniqueEvidence(
            triage.questions.flatMap((question) => question.evidence),
          ),
        },
        { marker, signal },
      );
      return;
    }
    const attention = latestAttention(comments);
    if (
      attention &&
      !attention.resolved &&
      attention.request.source === "pan" &&
      attention.request.reason === "triage-metadata" &&
      attention.request.prompt === triage.prompt
    ) {
      return;
    }
    await this.store.addComment(
      item,
      [
        formatNeedsHuman({
          kind: "question",
          prompt: triage.prompt,
          source: "pan",
          reason: "triage-metadata",
          locator: { issue: item.url },
        }),
        marker,
      ].join("\n\n"),
      { signal },
    );
  }

  async #resolveDetail(item, comments, signal) {
    const attention = latestAttention(comments);
    if (
      !attention ||
      attention.resolved ||
      attention.request.source !== "pan" ||
      !["missing-detail", "triage-metadata"].includes(attention.request.reason)
    ) {
      return;
    }
    await this.store.addComment(
      item,
      formatNeedsHumanResolved(
        "The requested metadata is resolved and the item has resumed triage.",
      ),
      { signal },
    );
  }
}

function assertCompleteEvidence(workstreams, runners) {
  const diagnostics = [
    ...(workstreams.errors ?? []).map(
      (error) => `workstream ${error.path || "index"}: ${error.reason}`,
    ),
    ...(runners.diagnostics ?? []).map(
      (diagnostic) =>
        `runner ${diagnostic.runnerId || diagnostic.source || "availability"}: ${diagnostic.message}`,
    ),
  ];
  if (
    workstreams.complete !== true ||
    runners.complete !== true ||
    diagnostics.length > 0
  ) {
    throw triageError(
      `PAN triage evidence is incomplete; correct these diagnostics before retrying: ${diagnostics.join("; ") || "source reported incomplete evidence"}`,
      "PAN_TRIAGE_INCOMPLETE_EVIDENCE",
    );
  }
}

function changedFields(current, desired) {
  return Object.fromEntries(
    Object.entries(desired).filter(
      ([field, value]) =>
        serializedField(current[field]) !== serializedField(value),
    ),
  );
}

function orderStatusLast(fields) {
  const { status, ...metadata } = fields;
  return status === undefined ? metadata : { ...metadata, status };
}

function questionMarker(item, prompt) {
  const digest = createHash("sha256")
    .update(`${item.url}\0${prompt}`)
    .digest("hex");
  return `<!-- pan:triage-question:${digest} -->`;
}

function serializedField(value) {
  return Array.isArray(value) ? value.join("\n") : value ?? "";
}

function uniqueEvidence(evidence) {
  const seen = new Set();
  return evidence.filter((entry) => {
    const key = `${entry.kind}\0${entry.locator}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function triageError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}
