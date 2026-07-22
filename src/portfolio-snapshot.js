import { createHash } from "node:crypto";

const SNAPSHOT_VERSION = 2;
const KNOWN_STATUSES = new Set([
  "untriaged",
  "needs-detail",
  "ready",
  "in-progress",
  "in-review",
  "done",
  "blocked",
]);

/**
 * Builds the immutable evidence set used to make portfolio decisions.
 */
export class PortfolioSnapshotBuilder {
  constructor({
    projectSource,
    issueCatalogSource = projectSource,
    workstreamSource,
    runnerSource,
    now = () => new Date(),
    historyLimit = 10,
  }) {
    if (!projectSource?.readCanonicalProject) {
      throw new TypeError("projectSource must provide readCanonicalProject()");
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
      throw new TypeError("runnerSource must provide loadAvailability()");
    }
    if (!Number.isInteger(historyLimit) || historyLimit < 1) {
      throw new TypeError("historyLimit must be a positive integer");
    }
    this.projectSource = projectSource;
    this.issueCatalogSource = issueCatalogSource;
    this.workstreamSource = workstreamSource;
    this.runnerSource = runnerSource;
    this.now = now;
    this.historyLimit = historyLimit;
  }

  async build() {
    const capturedAt = this.now().toISOString();
    const [projectResult, catalogResult, workstreamResult, runnerResult] =
      await Promise.all([
        readSource("project", () => this.projectSource.readCanonicalProject()),
        this.issueCatalogSource?.readIssueCatalog
          ? readSource("issues", () => this.issueCatalogSource.readIssueCatalog())
          : Promise.resolve({ source: "issues", value: unavailableCatalog() }),
        readSource("workstreams", () => this.workstreamSource.list()),
        readSource("runners", () => this.runnerSource.loadAvailability()),
      ]);
    const project = projectResult.value ?? unavailableProject();
    const catalog = catalogResult.value ?? unavailableCatalog();
    const workstreamIndex = workstreamResult.value ?? unavailableWorkstreams();
    const runnerAvailability = runnerResult.value ?? unavailableRunners();

    validateProject(project);
    const diagnostics = [
      ...readDiagnostics(projectResult),
      ...readDiagnostics(catalogResult),
      ...readDiagnostics(workstreamResult),
      ...readDiagnostics(runnerResult),
      ...sourceDiagnostics("project", project),
      ...sourceDiagnostics("issues", catalog),
      ...sourceDiagnostics("workstreams", workstreamIndex),
      ...sourceDiagnostics("runners", runnerAvailability),
    ];
    const issueByNumber = new Map(
      (catalog.issues ?? []).map((issue) => [issue.number, issue]),
    );
    const knownWorkstreams = new Set(
      (workstreamIndex.workstreams ?? []).map((entry) => entry.path),
    );
    const workstreamCache = new Map();
    const dossiers = [];

    for (const [canonicalIndex, projectItem] of project.items.entries()) {
      const joined = joinProjectItem(
        projectItem,
        catalog,
        issueByNumber,
        diagnostics,
      );
      const preclassification = classifyItem(joined.item, capturedAt);
      const workstream = await this.#workstreamEvidence(
        joined.item,
        preclassification,
        knownWorkstreams,
        workstreamCache,
        diagnostics,
      );
      const relations = extractRelations(joined.item, workstream);
      dossiers.push({
        canonicalIndex,
        preclassification,
        projectContent: joined.projectContent,
        item: normalizeItem(joined.item),
        lease: leaseEvidence(joined.item, capturedAt),
        dependencies: relations.dependencies,
        blockers: relations.blockers,
        workstream,
        compatibility: compatibilityEvidence(
          joined.item.requirements ?? [],
          runnerAvailability.runners ?? [],
        ),
        evidenceAvailable: {
          project: project.complete === true,
          issue: joined.issueAvailable,
          workstream: workstream.available,
          runnerAvailability: runnerAvailability.complete === true,
        },
      });
    }

    const source = {
      project: summarizeProjectSource(project),
      issues: summarizeCatalogSource(catalog),
      workstreams: summarizeWorkstreamSource(workstreamIndex),
      runners: summarizeRunnerSource(runnerAvailability),
    };
    const complete =
      project.complete === true &&
      catalog.complete === true &&
      workstreamIndex.complete === true &&
      runnerAvailability.complete === true &&
      diagnostics.length === 0;
    const expectedState = expectedStateReferences(
      project,
      catalog,
      workstreamIndex,
      dossiers,
    );
    const durable = {
      version: SNAPSHOT_VERSION,
      complete,
      usableForMutation: complete,
      source,
      expectedState,
      project: {
        id: project.id,
        items: project.items.map((item) => item.id),
      },
      issueCatalog: {
        id: catalog.id,
        excludedPullRequests: catalog.excludedPullRequests ?? 0,
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
      diagnostics: deduplicateDiagnostics(diagnostics),
    };
    return deepFreeze({
      id: stableIdentity(durable),
      capturedAt,
      ...durable,
    });
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
        return { path: workstreamPath, available: false, history: [] };
      }
    })();
    cache.set(workstreamPath, promise);
    return promise;
  }
}

async function readSource(source, read) {
  try {
    return { source, value: await read() };
  } catch (error) {
    return { source, error };
  }
}

function readDiagnostics(result) {
  if (!result.error) {
    return [];
  }
  return [{
    source: result.source,
    code: "source-read-failed",
    message: result.error instanceof Error ? result.error.message : String(result.error),
  }];
}

function unavailableProject() {
  return { id: "unavailable", complete: false, items: [] };
}

function unavailableCatalog() {
  return { id: "unavailable", complete: false, issues: [], diagnostics: [] };
}

function unavailableWorkstreams() {
  return {
    revision: "unavailable",
    complete: false,
    workstreams: [],
    diagnostics: [],
  };
}

function unavailableRunners() {
  return { complete: false, runners: [], diagnostics: [] };
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

function joinProjectItem(projectItem, catalog, issueByNumber, diagnostics) {
  const classification =
    projectItem.contentClassification ??
    (projectItem.repository === catalog.repository
      ? "domain-issue"
      : "unreadable");
  const projectContent = {
    classification,
    type: projectItem.contentType,
    repository: projectItem.repository,
    number: projectItem.number,
  };
  if (projectContent.classification !== "domain-issue") {
    return {
      item: projectItem,
      projectContent,
      issueAvailable: false,
    };
  }
  const issue = issueByNumber.get(projectItem.number);
  if (!issue) {
    diagnostics.push({
      source: `project-item:${projectItem.id}`,
      code: "project-issue-missing-catalog",
      message: `Project item ${projectItem.id} references Issue #${projectItem.number}, which is absent from the complete Issue catalog`,
    });
    return { item: projectItem, projectContent, issueAvailable: false };
  }
  return {
    item: {
      ...issue,
      id: projectItem.id,
      projectItemId: projectItem.id,
      fields: { ...(projectItem.fields ?? {}) },
      requirements: [...(projectItem.requirements ?? [])],
      linkedPullRequests: [...(projectItem.linkedPullRequests ?? [])],
      contentClassification: projectContent.classification,
      contentType: projectContent.type,
    },
    projectContent,
    issueAvailable: true,
  };
}

function classifyItem(item, capturedAt) {
  if (item.contentClassification !== "domain-issue") {
    return "unsupported";
  }
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

function describeProjectItem(item) {
  const issue = item.number ? `Issue #${item.number}` : "Issue";
  const title = item.title?.trim() ? ` ${JSON.stringify(item.title.trim())}` : "";
  const locator = [issue + title, item.url?.trim()].filter(Boolean).join(", ");
  return `Project item ${item.id} (${locator})`;
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
  const diagnostics = result.diagnostics ?? result.errors ?? [];
  const incomplete = result.complete !== true;
  return [
    ...(incomplete && diagnostics.length === 0
      ? [{
          source,
          code: `incomplete-${source}`,
          message: `The ${source} evidence source is incomplete`,
        }]
      : []),
    ...diagnostics.map((diagnostic) => ({
      source,
      code: diagnostic.code ?? "source-diagnostic",
      message:
        source === "workstreams"
          ? diagnostic.path
            ? `Workstream ${diagnostic.path} is unavailable or malformed`
            : "The workstream index is incomplete"
          : diagnostic.message ?? diagnostic.reason ?? "Source reported incomplete evidence",
      ...(diagnostic.path ? { path: diagnostic.path } : {}),
      ...(diagnostic.runnerId ? { runnerId: diagnostic.runnerId } : {}),
    })),
  ];
}

function summarizeProjectSource(project) {
  return {
    complete: project.complete === true,
    id: project.id,
    classifications: project.items.map((item) => ({
      itemId: item.id,
      classification: item.contentClassification ?? "unreadable",
    })),
  };
}

function summarizeCatalogSource(catalog) {
  return {
    complete: catalog.complete === true,
    id: catalog.id,
    commentsComplete: catalog.source?.comments?.complete === true,
    relationshipsComplete: catalog.source?.relationships?.complete === true,
    excludedPullRequests: catalog.excludedPullRequests ?? 0,
  };
}

function summarizeWorkstreamSource(workstreams) {
  return {
    complete: workstreams.complete === true,
    revision: workstreams.revision,
  };
}

function summarizeRunnerSource(runners) {
  return {
    complete: runners.complete === true,
    runnerCount: (runners.runners ?? []).length,
  };
}

function expectedStateReferences(project, catalog, workstreams, dossiers) {
  return {
    projectOrder: stableIdentity(project.items.map((item) => item.id)),
    projectItems: project.id,
    projectFields: stableIdentity(
      project.items.map((item) => ({ id: item.id, fields: item.fields ?? {} })),
    ),
    projectMembership: stableIdentity(
      project.items.map((item) => ({
        id: item.id,
        classification: item.contentClassification ?? "unreadable",
        number: item.number,
        repository: item.repository,
      })),
    ),
    issueCatalog: catalog.id,
    workstreamIndex: workstreams.revision,
    workstreamBlobs: stableIdentity(
      dossiers.map((dossier) => ({
        itemId: dossier.item.id,
        path: dossier.workstream.path,
        contentHash: dossier.workstream.contentHash,
        revision: dossier.workstream.revision,
      })),
    ),
    attentionRecords: "not-read",
    leadershipGeneration: "not-read",
  };
}

function deduplicateDiagnostics(diagnostics) {
  const seen = new Set();
  return diagnostics.filter((entry) => {
    const key = stableStringify(entry);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
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
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
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
