import { createHash } from "node:crypto";

const KNOWN_STATUSES = new Set([
  "untriaged",
  "needs-detail",
  "ready",
  "in-progress",
  "in-review",
  "done",
  "blocked",
]);

export class PortfolioSnapshotBuilder {
  constructor({
    projectSource,
    workstreamSource,
    runnerSource,
    now = () => new Date(),
    historyLimit = 10,
  }) {
    if (!projectSource?.readCanonicalProject) {
      throw new TypeError(
        "projectSource must provide readCanonicalProject()",
      );
    }
    if (
      !workstreamSource?.list ||
      !workstreamSource?.read ||
      !workstreamSource?.history
    ) {
      throw new TypeError(
        "workstreamSource must provide list(), read(), and history()",
      );
    }
    if (!runnerSource?.loadAvailability) {
      throw new TypeError(
        "runnerSource must provide loadAvailability()",
      );
    }
    if (!Number.isInteger(historyLimit) || historyLimit < 1) {
      throw new TypeError("historyLimit must be a positive integer");
    }
    this.projectSource = projectSource;
    this.workstreamSource = workstreamSource;
    this.runnerSource = runnerSource;
    this.now = now;
    this.historyLimit = historyLimit;
  }

  async build() {
    const capturedAt = this.now().toISOString();
    const [project, workstreamIndex, runnerAvailability] =
      await Promise.all([
        this.projectSource.readCanonicalProject(),
        this.workstreamSource.list(),
        this.runnerSource.loadAvailability(),
      ]);
    validateProject(project);

    const diagnostics = [
      ...sourceDiagnostics("workstreams", workstreamIndex),
      ...sourceDiagnostics("runners", runnerAvailability),
    ];
    if (project.complete !== true) {
      diagnostics.push({
        source: "project",
        code: "incomplete-project",
        message: "The canonical Project read is incomplete",
      });
    }

    const knownWorkstreams = new Set(
      (workstreamIndex.workstreams ?? []).map((entry) => entry.path),
    );
    const workstreamCache = new Map();
    const dossiers = [];
    for (const [canonicalIndex, item] of project.items.entries()) {
      const preclassification = classifyItem(item, capturedAt);
      const workstream = await this.#workstreamEvidence(
        item,
        preclassification,
        knownWorkstreams,
        workstreamCache,
        diagnostics,
      );
      const relations = extractRelations(item, workstream);
      dossiers.push({
        canonicalIndex,
        preclassification,
        item: normalizeItem(item),
        lease: leaseEvidence(item, capturedAt),
        dependencies: relations.dependencies,
        blockers: relations.blockers,
        workstream,
        compatibility: compatibilityEvidence(
          item.requirements ?? [],
          runnerAvailability.runners ?? [],
        ),
        evidenceAvailable: {
          project: true,
          issue: true,
          workstream: workstream.available,
          runnerAvailability: runnerAvailability.complete === true,
        },
      });
    }

    const complete =
      project.complete === true &&
      workstreamIndex.complete === true &&
      runnerAvailability.complete === true &&
      diagnostics.length === 0;
    const durable = {
      version: 1,
      capturedAt,
      complete,
      usableForMutation: complete,
      project: {
        id: project.id,
        items: project.items.map((item) => item.id),
      },
      workstreams: {
        revision: workstreamIndex.revision,
      },
      runnerAvailability: {
        complete: runnerAvailability.complete === true,
        runners: (runnerAvailability.runners ?? []).map(
          normalizeAvailabilityRunner,
        ),
      },
      dossiers,
      diagnostics,
    };
    const snapshot = {
      id: stableIdentity(durable),
      ...durable,
    };
    return deepFreeze(snapshot);
  }

  async #workstreamEvidence(
    item,
    preclassification,
    knownWorkstreams,
    cache,
    diagnostics,
  ) {
    const workstreamPath = item.fields?.workstream;
    const required = [
      "actionable",
      "actively-leased",
      "blocked",
    ].includes(preclassification);
    if (!workstreamPath) {
      if (required) {
        diagnostics.push({
          source: `item:${item.id}`,
          code: "missing-workstream",
          message: `${describeProjectItem(item)} has status ${item.fields?.status || "unknown"} but no workstream reference; set its Project workstream field to a valid workstream path, or move it to needs-detail until the reference is known`,
        });
      }
      return { path: undefined, available: false, required };
    }
    if (cache.has(workstreamPath)) {
      return cache.get(workstreamPath);
    }

    const promise = (async () => {
      if (!knownWorkstreams.has(workstreamPath)) {
        diagnostics.push({
          source: `item:${item.id}`,
          code: "unknown-workstream",
          message: `Referenced workstream ${workstreamPath} is absent from the workstream index`,
        });
      }
      try {
        const [read, history] = await Promise.all([
          this.workstreamSource.read(workstreamPath),
          this.workstreamSource.history(workstreamPath, {
            limit: this.historyLimit,
          }),
        ]);
        return {
          path: workstreamPath,
          available: true,
          sourcePath: read.sourcePath,
          content: read.content,
          contentHash: read.contentHash,
          modifiedAt: read.modifiedAt,
          revision: read.revision,
          history: history.map(normalizeHistory),
        };
      } catch (error) {
        diagnostics.push({
          source: `workstream:${workstreamPath}`,
          code: "workstream-read-failed",
          message: `Unable to read referenced workstream ${workstreamPath}${error.cause?.code ? ` (${error.cause.code})` : ""}`,
        });
        return {
          path: workstreamPath,
          available: false,
          history: [],
        };
      }
    })();
    cache.set(workstreamPath, promise);
    return promise;
  }
}

function describeProjectItem(item) {
  const issue = item.number ? `Issue #${item.number}` : "Issue";
  const title = item.title?.trim() ? ` ${JSON.stringify(item.title.trim())}` : "";
  const url = item.url?.trim();
  const locator = [issue + title, url].filter(Boolean).join(", ");
  return `Project item ${item.id} (${locator})`;
}

function validateProject(project) {
  if (!project || !Array.isArray(project.items) || !project.id) {
    throw new Error("Canonical Project source returned an invalid snapshot");
  }
  const ids = project.items.map((item) => item?.id);
  if (ids.some((id) => !id) || new Set(ids).size !== ids.length) {
    throw new Error(
      "Canonical Project snapshot contains missing or duplicate item IDs",
    );
  }
}

function classifyItem(item, capturedAt) {
  const status = item.fields?.status;
  if (item.state === "closed") {
    return "closed";
  }
  if (status === "done") {
    return "done";
  }
  if (!KNOWN_STATUSES.has(status)) {
    return "unsupported";
  }
  if (leaseEvidence(item, capturedAt).active) {
    return "actively-leased";
  }
  if (status === "blocked") {
    return "blocked";
  }
  if (status === "needs-detail" || status === "untriaged") {
    return "needs-detail";
  }
  return "actionable";
}

function leaseEvidence(item, capturedAt) {
  const claimedBy = item.fields?.claimedBy ?? "";
  const leaseUntil = item.fields?.leaseUntil ?? "";
  const parsed = Date.parse(leaseUntil);
  const valid = Boolean(leaseUntil) && Number.isFinite(parsed);
  return {
    claimedBy,
    leaseUntil,
    active:
      Boolean(claimedBy) && valid && parsed > Date.parse(capturedAt),
    expired: Boolean(claimedBy) && (!valid || parsed <= Date.parse(capturedAt)),
  };
}

function normalizeItem(item) {
  return {
    id: item.id,
    number: item.number,
    title: item.title,
    body: item.body,
    url: item.url,
    state: item.state,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    repository: item.repository,
    assignees: [...(item.assignees ?? [])],
    labels: [...(item.labels ?? [])],
    comments: (item.comments ?? []).map((comment) => ({ ...comment })),
    linkedPullRequests: (item.linkedPullRequests ?? []).map((pullRequest) => ({
      ...pullRequest,
    })),
    fields: { ...(item.fields ?? {}) },
    requirements: [...(item.requirements ?? [])],
  };
}

function normalizeHistory(entry) {
  return {
    sha: entry.sha,
    committedAt: entry.committedAt,
    subject: entry.subject,
    changedPath: entry.changedPath,
  };
}

function compatibilityEvidence(requirements, runners) {
  const repositories = requirements
    .filter((requirement) => requirement.startsWith("repo:"))
    .map((requirement) => requirement.slice("repo:".length));
  const repository = repositories.length === 1 ? repositories[0] : undefined;
  return {
    requirements: [...requirements],
    runners: runners
      .filter(
        (runner) =>
          runner.online &&
          runner.playbooks.some((playbook) =>
            (!repository || playbook.repositories.includes(repository)) &&
            requirements.every((requirement) =>
              requirement.startsWith("delivery:")
                ? requirement === `delivery:${playbook.delivery}`
                : playbook.capabilities.includes(requirement),
            ),
          ),
      )
      .map((runner) => ({
        id: runner.id,
        freeCapacity: runner.freeCapacity,
        capacityKnown: runner.capacityKnown,
      })),
  };
}

function normalizeAvailabilityRunner(runner) {
  return {
    id: runner.id,
    online: runner.online,
    capabilities: [...runner.capabilities],
    playbooks: runner.playbooks.map((playbook) => ({
      id: playbook.id,
      capabilities: [...playbook.capabilities],
      repositories: [...playbook.repositories],
      delivery: playbook.delivery,
    })),
    maximumCapacity: runner.maximumCapacity,
    activeLeaseCount: runner.activeLeaseCount,
    freeCapacity: runner.freeCapacity,
    capacityKnown: runner.capacityKnown,
  };
}

function extractRelations(item, workstream) {
  const sources = [
    { source: "issue-body", text: item.body },
    ...(item.comments ?? []).map((comment) => ({
      source: `issue-comment:${comment.id}`,
      text: comment.body,
    })),
    ...(workstream.content
      ? [{ source: `workstream:${workstream.path}`, text: workstream.content }]
      : []),
  ];
  const dependencies = [];
  const blockers = [];
  for (const { source, text } of sources) {
    for (const line of String(text ?? "").split(/\r?\n/)) {
      const match = line.match(
        /^\s*(?:[-*]\s*)?(depends on|dependency|blocked by|blocker)\s*:\s*(.+?)\s*$/i,
      );
      if (!match) {
        continue;
      }
      const record = { source, text: match[2] };
      if (/^block/i.test(match[1])) {
        blockers.push(record);
      } else {
        dependencies.push(record);
      }
    }
  }
  return { dependencies, blockers };
}

function sourceDiagnostics(source, result) {
  return (result.diagnostics ?? result.errors ?? []).map((diagnostic) => ({
    source,
    code: diagnostic.code ?? "source-diagnostic",
    message:
      source === "workstreams"
        ? diagnostic.path
          ? `Workstream ${diagnostic.path} is unavailable or malformed`
          : "The workstream index is incomplete"
        : diagnostic.message ?? diagnostic.reason,
    ...(diagnostic.path ? { path: diagnostic.path } : {}),
    ...(diagnostic.runnerId ? { runnerId: diagnostic.runnerId } : {}),
  }));
}

function stableIdentity(value) {
  return `sha256:${createHash("sha256")
    .update(stableStringify(value))
    .digest("hex")}`;
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

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}
