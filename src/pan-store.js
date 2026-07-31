import { readFile } from "node:fs/promises";
import { GitHubWorkstreamStore } from "./github-workstream-store.js";

const DEFAULT_PROJECT_ITEM_SAFETY_LIMIT = 1_000;
const PROJECT_PAGE_SIZE = 20;
const CONFIRM_ATTEMPTS = 3;
const CONFIRM_DELAY_MS = 250;
const PROJECT_ITEM_SELECTION = `
  id
  fieldValues(first: 20) {
    nodes {
      ... on ProjectV2ItemFieldSingleSelectValue {
        name
        field {
          ... on ProjectV2SingleSelectField {
            name
          }
        }
      }
      ... on ProjectV2ItemFieldTextValue {
        text
        field {
          ... on ProjectV2Field {
            name
          }
        }
      }
    }
    pageInfo {
      hasNextPage
    }
  }
  content {
    __typename
    ... on Issue {
      number
      title
      body
      url
      state
      createdAt
      updatedAt
      repository {
        nameWithOwner
      }
      assignees(first: 20) {
        nodes {
          login
        }
        pageInfo {
          hasNextPage
        }
      }
      labels(first: 20) {
        nodes {
          name
        }
        pageInfo {
          hasNextPage
        }
      }
      comments(first: 100) {
        nodes {
          id
          body
          url
          createdAt
          updatedAt
          author {
            login
          }
        }
        pageInfo {
          hasNextPage
        }
      }
      closedByPullRequestsReferences(first: 10, includeClosedPrs: true) {
        nodes {
          number
          url
          state
          mergedAt
          repository {
            nameWithOwner
          }
        }
        pageInfo {
          hasNextPage
        }
      }
    }
  }
`;
const PROJECT_ITEM_QUERY = `
  query($itemId: ID!) {
    node(id: $itemId) {
      ... on ProjectV2Item {
        ${PROJECT_ITEM_SELECTION}
      }
    }
  }
`;
const PROJECT_ITEMS_QUERY = `
  query($projectId: ID!, $cursor: String) {
    node(id: $projectId) {
      ... on ProjectV2 {
        items(first: ${PROJECT_PAGE_SIZE}, after: $cursor) {
          totalCount
          pageInfo {
            hasNextPage
            endCursor
          }
          nodes {
            ${PROJECT_ITEM_SELECTION}
          }
        }
      }
    }
  }
`;
const PROJECT_FIELDS_QUERY = `
  query($projectId: ID!, $cursor: String) {
    node(id: $projectId) {
      ... on ProjectV2 {
        fields(first: ${PROJECT_PAGE_SIZE}, after: $cursor) {
          pageInfo {
            hasNextPage
            endCursor
          }
          nodes {
            __typename
            ... on ProjectV2Field {
              id
              name
            }
            ... on ProjectV2SingleSelectField {
              id
              name
              options {
                id
                name
              }
            }
          }
        }
      }
    }
  }
`;

export class PanStore {
  constructor({
    repository,
    projectOwner,
    projectNumber,
    gh,
    manifest,
    projectItemSafetyLimit = DEFAULT_PROJECT_ITEM_SAFETY_LIMIT,
    now = () => new Date(),
    sleep = (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
    workstreamStore,
  }) {
    if (!repository || !projectOwner || !Number.isInteger(projectNumber)) {
      throw new TypeError(
        "repository, projectOwner, and an integer projectNumber are required",
      );
    }
    if (!gh?.run || !gh?.runJson) {
      throw new TypeError("gh must provide run() and runJson() methods");
    }
    if (
      !Number.isInteger(projectItemSafetyLimit) ||
      projectItemSafetyLimit < 1
    ) {
      throw new TypeError("projectItemSafetyLimit must be a positive integer");
    }

    this.repository = repository;
    this.projectOwner = projectOwner;
    this.projectNumber = projectNumber;
    this.gh = gh;
    this.manifest = manifest;
    this.projectItemSafetyLimit = projectItemSafetyLimit;
    this.now = now;
    this.sleep = sleep;
    this.workstreamStore =
      workstreamStore ?? new GitHubWorkstreamStore({ repository, gh });
    this.schemaPromise = undefined;
  }

  async getSchema({ refresh = false } = {}) {
    if (refresh || !this.schemaPromise) {
      const loading = this.#loadSchema();
      this.schemaPromise = loading;
      void loading.catch(() => {
        if (this.schemaPromise === loading) {
          this.schemaPromise = undefined;
        }
      });
    }
    return this.schemaPromise;
  }

  async setFields(itemId, values, { signal, beforeWrite } = {}) {
    if (!itemId) {
      throw new TypeError("itemId is required");
    }

    const schema = await this.getSchema();
    validateFieldValues(values, schema);
    if (values.workstream) {
      await this.workstreamStore.validate(values.workstream, { signal });
    }
    for (const [key, value] of Object.entries(values)) {
      signal?.throwIfAborted();
      await beforeWrite?.();
      const field = schema.fields[key];

      const args = [
        "project",
        "item-edit",
        "--id",
        itemId,
        "--project-id",
        schema.projectId,
        "--field-id",
        field.id,
      ];
      if (
        value === null ||
        value === undefined ||
        value === "" ||
        (key === "requirements" && Array.isArray(value) && value.length === 0)
      ) {
        args.push("--clear");
      } else if (field.type === "single_select") {
        args.push("--single-select-option-id", field.options[value]);
      } else {
        args.push("--text", serializeTextField(key, value));
      }
      try {
        await this.gh.run(args, { signal });
      } catch (error) {
        if (!isNoChanges(error)) {
          throw error;
        }
      }
    }
  }

  async listByFilter(filters = {}) {
    const items = await this.#listItems();
    return items.filter((item) => matchesFilters(item, filters, this.now()));
  }

  async listItems() {
    return this.#listItems();
  }

  async listRepositoryIssues({ state = "all", signal } = {}) {
    if (this.gh.paginateRestJson) {
      const issues = await this.gh.paginateRestJson(
        `repos/${this.repository}/issues?state=${encodeURIComponent(state)}`,
        { safetyLimit: this.projectItemSafetyLimit, signal },
      );
      return issues
        .filter((issue) => !issue.pull_request)
        .map((issue) => ({
          number: issue.number,
          title: issue.title,
          body: issue.body ?? "",
          url: issue.html_url,
          state: issue.state,
          labels: issue.labels ?? [],
          createdAt: issue.created_at,
          updatedAt: issue.updated_at,
          closedAt: issue.closed_at,
        }));
    }
    const issues = await this.gh.runJson(
      [
        "issue",
        "list",
        "--repo",
        this.repository,
        "--state",
        state,
        "--limit",
        "1000",
        "--json",
        "number,title,body,url,state,labels,createdAt,updatedAt,closedAt",
      ],
      { signal },
    );
    if (!Array.isArray(issues)) {
      throw new Error("GitHub returned an invalid repository Issue list");
    }
    if (issues.length >= this.projectItemSafetyLimit) {
      throw new Error(
        `Repository Issue inventory reached the ${this.projectItemSafetyLimit}-entry safety limit without pagination support`,
      );
    }
    return issues;
  }

  async classify({ signal, beforeWrite } = {}) {
    await this.registerMissingIssues({ signal, beforeWrite });
    const [issues, items] = await Promise.all([
      this.listRepositoryIssues({ signal }),
      this.listItems(),
    ]);
    return classifyDomainIssues(issues, items);
  }

  async registerMissingIssues({ signal, beforeWrite } = {}) {
    const [issues, items] = await Promise.all([
      this.listRepositoryIssues({ signal }),
      this.listItems(),
    ]);
    const projectIssueUrls = new Set(
      items
        .filter((item) => item.contentClassification === "domain-issue")
        .map((item) => item.url),
    );
    const registered = [];
    for (const issue of issues) {
      if (projectIssueUrls.has(issue.url)) {
        continue;
      }
      registered.push(
        await this.addIssueToProject(issue, {
          allowClosed: true,
          fields: { status: "untriaged" },
          signal,
          beforeWrite,
        }),
      );
      projectIssueUrls.add(issue.url);
    }
    return registered;
  }

  async addIssueToProject(
    issue,
    { allowClosed = false, fields = {}, signal, beforeWrite } = {},
  ) {
    const issueRepository =
      issue?.repository ??
      /^https:\/\/github\.com\/([^/]+\/[^/]+)\/issues\/\d+\/?$/.exec(
        issue?.url ?? "",
      )?.[1];
    if (
      !issue?.url ||
      issueRepository?.toLowerCase() !== this.repository.toLowerCase()
    ) {
      throw new TypeError("a configured-domain Issue is required");
    }
    if (issue.state?.toLowerCase() === "closed" && !allowClosed) {
      throw new Error("Closed Issues cannot be added to the backlog Project");
    }
    signal?.throwIfAborted();
    await beforeWrite?.();
    const added = await this.gh.runJson(
      [
        "project",
        "item-add",
        String(this.projectNumber),
        "--owner",
        this.projectOwner,
        "--url",
        issue.url,
        "--format",
        "json",
      ],
      { signal },
    );
    const itemId = added?.id ?? added?.item?.id;
    if (!itemId) {
      throw new Error("GitHub did not return the added Project item ID");
    }
    const initialized = {
      owner: "unassigned",
      status: "untriaged",
      priority: "normal",
      ...fields,
    };
    await this.setFields(itemId, initialized, { signal, beforeWrite });
    return this.getItem(itemId, { signal });
  }

  async removeItem(itemId, { signal, beforeWrite } = {}) {
    const schema = await this.getSchema();
    signal?.throwIfAborted();
    await beforeWrite?.();
    await this.gh.run(
      [
        "project",
        "item-delete",
        String(this.projectNumber),
        "--owner",
        this.projectOwner,
        "--id",
        itemId,
      ],
      { signal },
    );
    return { removed: true, itemId, projectId: schema.projectId };
  }

  async getItem(itemId, { signal } = {}) {
    if (!itemId) {
      throw new TypeError("itemId is required");
    }
    const schema = await this.getSchema();
    const result = await this.gh.runJson([
      "api",
      "graphql",
      "-f",
      `query=${PROJECT_ITEM_QUERY}`,
      "-f",
      `itemId=${itemId}`,
    ], { signal });
    return normalizeGraphQlItem(result.data?.node, schema, this.repository);
  }

  async addComment(item, body, { signal, beforeWrite } = {}) {
    if (!item?.number || !item.repository) {
      throw new TypeError("an Issue-backed item is required");
    }
    if (!body?.trim()) {
      throw new TypeError("comment body is required");
    }
    signal?.throwIfAborted();
    await beforeWrite?.();
    return this.gh.run([
      "issue",
      "comment",
      String(item.number),
      "--repo",
      item.repository,
      "--body",
      body,
    ], { signal });
  }

  async listComments(item) {
    if (!item?.number || !item.repository) {
      throw new TypeError("an Issue-backed item is required");
    }
    const result = await this.gh.runJson([
      "issue",
      "view",
      String(item.number),
      "--repo",
      item.repository,
      "--json",
      "comments",
    ]);
    return (result.comments ?? []).map((comment) => ({
      id: comment.id,
      body: comment.body ?? "",
      url: comment.url,
      createdAt: comment.createdAt,
      author:
        typeof comment.author === "string"
          ? comment.author
          : comment.author?.login,
    }));
  }

  async claimWithLease({
    itemId,
    runner,
    leaseUntil,
    assignee,
    status = "in-progress",
  }) {
    validateRunnerAndLease(runner, leaseUntil, this.now());
    const current = await this.#requireItem(itemId);
    const holder = current.fields.claimedBy;
    const leaseIsActive =
      holder &&
      !isResumeAffinity(holder) &&
      !isExpired(current.fields.leaseUntil, this.now());
    if (isResumeAffinity(holder) && !resumeAffinityAllows(holder, runner)) {
      return { claimed: false, reason: "resume-affinity", item: current };
    }
    if (leaseIsActive && holder !== runner) {
      return { claimed: false, reason: "leased", item: current };
    }

    await this.setFields(itemId, {
      claimedBy: runner,
      leaseUntil,
      status,
    });

    const confirmed = await this.#confirmFields(itemId, {
      claimedBy: runner,
      leaseUntil,
      status,
    });
    if (!confirmed) {
      return {
        claimed: false,
        reason: "claim-not-confirmed",
        item: await this.#requireItem(itemId),
      };
    }
    if (assignee) {
      try {
        await this.#editAssignee(confirmed, "--add-assignee", assignee);
      } catch (error) {
        let rollback;
        try {
          rollback = await this.release({
            itemId,
            runner,
            status: "ready",
          });
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            "Issue assignment failed and the claim rollback errored",
          );
        }
        if (!rollback.released) {
          throw new AggregateError(
            [error, new Error(`Claim rollback failed: ${rollback.reason}`)],
            "Issue assignment failed after claiming the item",
          );
        }
        throw error;
      }
    }
    return { claimed: true, item: confirmed };
  }

  async heartbeat({ itemId, runner, leaseUntil }) {
    validateRunnerAndLease(runner, leaseUntil, this.now());
    const current = await this.#requireItem(itemId);
    if (current.fields.claimedBy !== runner) {
      return { renewed: false, reason: "not-owner", item: current };
    }
    if (isExpired(current.fields.leaseUntil, this.now())) {
      return { renewed: false, reason: "lease-expired", item: current };
    }

    await this.setFields(itemId, { leaseUntil });
    const confirmed = await this.#confirmFields(itemId, {
      claimedBy: runner,
      leaseUntil,
    });
    if (!confirmed) {
      return {
        renewed: false,
        reason: "heartbeat-not-confirmed",
        item: await this.#requireItem(itemId),
      };
    }
    return { renewed: true, item: confirmed };
  }

  async release({
    itemId,
    runner,
    assignee,
    status = "ready",
    force = false,
    allowExpired = false,
    resumeAffinity,
  }) {
    if (!runner && !force) {
      throw new TypeError("runner is required unless force is true");
    }
    if (resumeAffinity && status !== "ready") {
      throw new TypeError("resumeAffinity requires ready status");
    }

    const current = await this.#requireItem(itemId);
    if (!force && current.fields.claimedBy !== runner) {
      return { released: false, reason: "not-owner", item: current };
    }
    if (
      !force &&
      !allowExpired &&
      isExpired(current.fields.leaseUntil, this.now())
    ) {
      return { released: false, reason: "lease-expired", item: current };
    }

    const closesIssue = status === "done" && current.state !== "closed";
    let assigneeRemoved = false;
    try {
      await this.setFields(itemId, {
        claimedBy: resumeAffinity ?? null,
        leaseUntil: null,
        ...(status ? { status } : {}),
      });
      if (assignee) {
        await this.#editAssignee(current, "--remove-assignee", assignee);
        assigneeRemoved = true;
      }

      const expected = {
        claimedBy: resumeAffinity ?? "",
        leaseUntil: "",
        ...(status ? { status } : {}),
      };
      const confirmed = await this.#confirmFields(itemId, expected);
      if (!confirmed) {
        return {
          released: false,
          reason: "release-not-confirmed",
          item: await this.#requireItem(itemId),
        };
      }
      if (closesIssue) {
        await this.#closeIssue(confirmed);
        confirmed.state = "closed";
      }
      return { released: true, item: confirmed };
    } catch (error) {
      if (!closesIssue) {
        throw error;
      }
      try {
        await this.setFields(itemId, {
          claimedBy: current.fields.claimedBy,
          leaseUntil: current.fields.leaseUntil,
          status: current.fields.status,
        });
        if (assigneeRemoved) {
          await this.#editAssignee(current, "--add-assignee", assignee);
        }
        const restored = await this.#confirmFields(itemId, {
          claimedBy: current.fields.claimedBy,
          leaseUntil: current.fields.leaseUntil,
          status: current.fields.status,
        });
        if (!restored) {
          throw new Error(
            `Unable to restore Pan task ${itemId} after Issue closure failed`,
          );
        }
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          "Issue closure failed and the Pan task could not be restored",
        );
      }
      throw error;
    }
  }

  async requestHumanAttention({ itemId, runner }) {
    const current = await this.#requireItem(itemId);
    if (current.fields.needsHumanSince) {
      return { requested: true, item: current };
    }
    if (runner && current.fields.claimedBy !== runner) {
      return { requested: false, reason: "not-owner", item: current };
    }
    const since = new Date(this.now()).toISOString();
    await this.setFields(itemId, { needsHumanSince: since });
    const confirmed = await this.#confirmFields(itemId, {
      needsHumanSince: since,
    });
    if (!confirmed) {
      throw new Error(`Unable to confirm human attention for Pan task ${itemId}`);
    }
    return { requested: true, item: confirmed };
  }

  async resolveHumanAttention({ itemId, runner }) {
    const current = await this.#requireItem(itemId);
    if (!current.fields.needsHumanSince) {
      return { resolved: true, item: current };
    }
    if (runner && current.fields.claimedBy !== runner) {
      return { resolved: false, reason: "not-owner", item: current };
    }
    await this.setFields(itemId, { needsHumanSince: null });
    const confirmed = await this.#confirmFields(itemId, {
      needsHumanSince: "",
    });
    if (!confirmed) {
      throw new Error(
        `Unable to confirm human attention resolution for Pan task ${itemId}`,
      );
    }
    return { resolved: true, item: confirmed };
  }

  async #loadSchema() {
    const manifest =
      this.manifest ??
      JSON.parse(
        await readFile(
          new URL("../schema/project-fields.json", import.meta.url),
          "utf8",
        ),
      );
    const project = await this.gh.runJson([
      "project",
      "view",
      String(this.projectNumber),
      "--owner",
      this.projectOwner,
      "--format",
      "json",
    ]);
    if (!project.id) {
      throw new Error("gh project view returned no Project ID");
    }
    const fieldList = await this.#listProjectFields(project.id);

    const fields = {};
    for (const expected of manifest.fields) {
      const actual = fieldList.find(
        (field) => field.name.toLowerCase() === expected.name.toLowerCase(),
      );
      if (!actual) {
        throw new Error(`Project is missing required field "${expected.name}"`);
      }

      const actualType =
        actual.__typename === "ProjectV2SingleSelectField"
          ? "single_select"
          : "text";
      if (actualType !== expected.type) {
        throw new Error(
          `Project field "${expected.name}" has type ${actual.__typename}, expected ${expected.type}`,
        );
      }

      const options = Object.fromEntries(
        (actual.options ?? []).map((option) => [option.name, option.id]),
      );
      for (const option of expected.options ?? []) {
        if (!options[option]) {
          throw new Error(
            `Project field "${expected.name}" is missing option "${option}"`,
          );
        }
      }
      fields[expected.key] = {
        id: actual.id,
        key: expected.key,
        name: expected.name,
        type: expected.type,
        options,
      };
    }

    return {
      projectId: project.id,
      projectNumber: this.projectNumber,
      projectOwner: this.projectOwner,
      fields,
    };
  }

  async #listItems({ preserveIncomplete = false } = {}) {
    const schema = await this.getSchema();
    const items = await this.#readProjectConnection({
      query: PROJECT_ITEMS_QUERY,
      projectId: schema.projectId,
      connectionName: "items",
      limit: this.projectItemSafetyLimit,
    });
    const diagnostics = [];
    const normalized = items.map((item) => {
      try {
        const value = normalizeGraphQlItem(item, schema, this.repository);
        if (!value) {
          throw new Error("Project items connection included a redacted or null item");
        }
        return value;
      } catch (error) {
        if (!preserveIncomplete) {
          throw error;
        }
        const itemId = item?.id;
        if (!itemId) {
          throw error;
        }
        diagnostics.push({
          source: `project-item:${itemId}`,
          code: "unreadable-project-item",
          message: error.message,
        });
        return unreadableProjectItem(item);
      }
    });
    return preserveIncomplete ? { items: normalized, diagnostics } : normalized;
  }

  async #listProjectFields(projectId) {
    return this.#readProjectConnection({
      query: PROJECT_FIELDS_QUERY,
      projectId,
      connectionName: "fields",
      limit: 100,
    });
  }

  async #readProjectConnection({
    query,
    projectId,
    connectionName,
    limit,
  }) {
    const nodes = [];
    let cursor;
    let expectedTotal;
    const cursors = new Set();
    do {
      const args = [
        "api",
        "graphql",
        "-f",
        `query=${query}`,
        "-f",
        `projectId=${projectId}`,
      ];
      if (cursor) {
        args.push("-f", `cursor=${cursor}`);
      }
      const result = await this.gh.runJson(args);
      const connection = result.data?.node?.[connectionName];
      if (!connection) {
        throw new Error(
          `GitHub returned no Project ${connectionName} connection`,
        );
      }
      if (!Array.isArray(connection.nodes)) {
        throw new Error(
          `GitHub returned an invalid Project ${connectionName} connection`,
        );
      }
      if (Number.isInteger(connection.totalCount)) {
        expectedTotal ??= connection.totalCount;
        if (connection.totalCount !== expectedTotal) {
          throw new Error(
            `Project ${connectionName} changed while the complete read was in progress`,
          );
        }
        if (connection.totalCount > limit) {
          throw new Error(
            `Project has ${connection.totalCount} ${connectionName}, exceeding the ${limit}-entry read limit`,
          );
        }
      }
      nodes.push(...connection.nodes);
      if (nodes.length > limit) {
        throw new Error(
          `Project ${connectionName} exceeded the ${limit}-entry read limit`,
        );
      }
      if (connection.pageInfo?.hasNextPage) {
        cursor = connection.pageInfo.endCursor;
        if (!cursor || cursors.has(cursor)) {
          throw new Error(
            `GitHub returned incomplete pagination for Project ${connectionName}`,
          );
        }
        cursors.add(cursor);
      } else {
        cursor = undefined;
      }
    } while (cursor);
    if (expectedTotal !== undefined && nodes.length !== expectedTotal) {
      throw new Error(
        `GitHub returned ${nodes.length} of ${expectedTotal} Project ${connectionName}`,
      );
    }
    return nodes;
  }

  async #requireItem(itemId, { signal } = {}) {
    const item = await this.getItem(itemId, { signal });
    if (!item) {
      throw new Error(`Project item not found: ${itemId}`);
    }
    return item;
  }

  async #confirmItem(itemId) {
    for (let attempt = 0; attempt < CONFIRM_ATTEMPTS; attempt += 1) {
      const item = await this.getItem(itemId);
      if (item) {
        return item;
      }
      if (attempt < CONFIRM_ATTEMPTS - 1) {
        await this.sleep(CONFIRM_DELAY_MS);
      }
    }
    throw new Error(`Project item did not become visible: ${itemId}`);
  }

  async #confirmFields(itemId, expected, { signal } = {}) {
    for (let attempt = 0; attempt < CONFIRM_ATTEMPTS; attempt += 1) {
      signal?.throwIfAborted();
      const item = await this.getItem(itemId, { signal });
      if (
        item &&
        Object.entries(expected).every(
          ([key, value]) => (item.fields[key] ?? "") === value,
        )
      ) {
        return item;
      }
      if (attempt < CONFIRM_ATTEMPTS - 1) {
        await this.sleep(CONFIRM_DELAY_MS);
      }
    }
    return undefined;
  }

  async #confirmIssueClosed(itemId, { signal } = {}) {
    for (let attempt = 0; attempt < CONFIRM_ATTEMPTS; attempt += 1) {
      signal?.throwIfAborted();
      const item = await this.getItem(itemId, { signal });
      if (item?.state?.toLowerCase() === "closed") {
        return item;
      }
      if (attempt < CONFIRM_ATTEMPTS - 1) {
        await this.sleep(CONFIRM_DELAY_MS);
      }
    }
    return undefined;
  }

  async #editAssignee(item, flag, assignee) {
    if (!item.number) {
      throw new Error(`Project item ${item.id} is not an Issue`);
    }
    await this.gh.run([
      "issue",
      "edit",
      String(item.number),
      "--repo",
      item.repository || this.repository,
      flag,
      assignee,
    ]);
  }

  async #closeIssue(item, { signal } = {}) {
    if (!item.number) {
      throw new Error(`Project item ${item.id} is not an Issue`);
    }
    await this.gh.run([
      "issue",
      "close",
      String(item.number),
      "--repo",
      item.repository || this.repository,
      "--reason",
      "completed",
    ], { signal });
  }
}

function normalizeGraphQlItem(item, schema, defaultRepository) {
  if (!item) {
    return undefined;
  }
  const content = item.content;
  const fieldValues = requireCompleteConnection(
    item.id,
    "field values",
    item.fieldValues,
    20,
  );
  const fields = Object.fromEntries(
    Object.values(schema.fields).map((field) => [field.key, ""]),
  );
  for (const value of fieldValues) {
    const field = Object.values(schema.fields).find(
      (candidate) =>
        candidate.name.toLowerCase() === value.field?.name?.toLowerCase(),
    );
    if (field) {
      fields[field.key] = value.name ?? value.text ?? "";
    }
  }
  if (!content || content.__typename !== "Issue") {
    return {
      id: item.id,
      number: undefined,
      title: undefined,
      body: undefined,
      url: undefined,
      state: undefined,
      createdAt: undefined,
      updatedAt: undefined,
      repository: undefined,
      assignees: [],
      labels: [],
      comments: [],
      linkedPullRequests: [],
      fields,
      requirements: parseRequirements(fields.requirements),
      contentType: content?.__typename,
      contentClassification: classifyProjectContent(content),
    };
  }
  const assignees = requireCompleteConnection(
    item.id,
    "assignees",
    content.assignees,
    20,
  );
  const labels = requireCompleteConnection(
    item.id,
    "labels",
    content.labels,
    20,
  );
  const comments = requireCompleteConnection(
    item.id,
    "comments",
    content.comments,
    100,
  );
  const linkedPullRequests = requireCompleteConnection(
    item.id,
    "linked pull requests",
    content.closedByPullRequestsReferences,
    10,
  );
  requireIssueEvidence(item.id, content);
  return {
    id: item.id,
    number: content.number,
    title: content.title ?? "",
    body: content.body ?? "",
    url: content.url ?? "",
    state: (content.state ?? "").toLowerCase(),
    createdAt: content.createdAt,
    updatedAt: content.updatedAt,
    repository: content.repository?.nameWithOwner ?? defaultRepository,
    assignees: assignees.map((entry) =>
      requireEvidenceString(item.id, "assignee login", entry?.login),
    ),
    labels: labels.map((entry) =>
      requireEvidenceString(item.id, "label name", entry?.name),
    ),
    comments: comments.map((comment) =>
      normalizeComment(item.id, comment),
    ),
    linkedPullRequests: linkedPullRequests.map((pullRequest) =>
      normalizePullRequest(item.id, pullRequest),
    ),
    fields,
    requirements: parseRequirements(fields.requirements),
    contentType: content.__typename,
    contentClassification:
      content.repository?.nameWithOwner === defaultRepository
        ? "domain-issue"
        : "cross-domain-issue",
  };
}

function unreadableProjectItem(item) {
  return {
    id: item.id,
    number: undefined,
    title: undefined,
    body: undefined,
    url: undefined,
    state: undefined,
    createdAt: undefined,
    updatedAt: undefined,
    repository: undefined,
    assignees: [],
    labels: [],
    comments: [],
    linkedPullRequests: [],
    fields: {},
    requirements: [],
    contentType: item.content?.__typename,
    contentClassification: "unreadable",
  };
}

function classifyProjectContent(content) {
  if (!content) {
    return "unreadable";
  }
  if (content.__typename === "DraftIssue") {
    return "draft";
  }
  if (content.__typename === "PullRequest") {
    return "pull-request";
  }
  return "unsupported";
}

function normalizePullRequest(itemId, pullRequest) {
  if (
    !pullRequest ||
    !Number.isInteger(pullRequest.number) ||
    typeof pullRequest.url !== "string" ||
    !pullRequest.url ||
    typeof pullRequest.state !== "string" ||
    (pullRequest.mergedAt !== null &&
      pullRequest.mergedAt !== undefined &&
      !Number.isFinite(Date.parse(pullRequest.mergedAt))) ||
    typeof pullRequest.repository?.nameWithOwner !== "string"
  ) {
    throw new Error(
      `Project item ${itemId} has incomplete linked pull request evidence`,
    );
  }
  return {
    number: pullRequest.number,
    url: pullRequest.url,
    state: pullRequest.state.toLowerCase(),
    mergedAt: pullRequest.mergedAt ?? null,
    repository: pullRequest.repository.nameWithOwner,
  };
}

function normalizeComment(itemId, comment) {
  if (
    !comment ||
    typeof comment.body !== "string" ||
    !Number.isFinite(Date.parse(comment.createdAt)) ||
    !Number.isFinite(Date.parse(comment.updatedAt))
  ) {
    throw new Error(
      `Project item ${itemId} has incomplete comment evidence`,
    );
  }
  return {
    id: requireEvidenceString(itemId, "comment ID", comment.id),
    body: comment.body,
    url: requireEvidenceString(itemId, "comment URL", comment.url),
    createdAt: comment.createdAt,
    updatedAt: comment.updatedAt,
    author: comment.author?.login,
  };
}

function requireEvidenceString(itemId, name, value) {
  if (typeof value !== "string" || !value) {
    throw new Error(`Project item ${itemId} has incomplete ${name} evidence`);
  }
  return value;
}

function requireIssueEvidence(itemId, content) {
  if (
    !Number.isInteger(content.number) ||
    typeof content.title !== "string" ||
    typeof content.body !== "string" ||
    typeof content.url !== "string" ||
    !content.url ||
    typeof content.state !== "string" ||
    typeof content.createdAt !== "string" ||
    typeof content.updatedAt !== "string" ||
    typeof content.repository?.nameWithOwner !== "string"
  ) {
    throw new Error(
      `Project item ${itemId} is missing required Issue evidence`,
    );
  }
}

function requireCompleteConnection(itemId, name, connection, limit) {
  if (
    !connection ||
    !Array.isArray(connection.nodes) ||
    typeof connection.pageInfo?.hasNextPage !== "boolean"
  ) {
    throw new Error(
      `Project item ${itemId} has incomplete ${name} metadata`,
    );
  }
  if (connection.pageInfo.hasNextPage) {
    throw new Error(
      `Project item ${itemId} has more than ${limit} ${name} and cannot be read safely`,
    );
  }
  return connection.nodes;
}

function matchesFilters(item, filters, now) {
  for (const [key, expected] of Object.entries(filters)) {
    if (key === "requirements") {
      const required = Array.isArray(expected) ? expected : [expected];
      if (!required.every((value) => item.requirements.includes(value))) {
        return false;
      }
    } else if (key === "unclaimed") {
      if (Boolean(expected) !== !item.fields.claimedBy) {
        return false;
      }
    } else if (key === "leaseExpired") {
      if (Boolean(expected) !== isExpired(item.fields.leaseUntil, now)) {
        return false;
      }
    } else if (key === "claimable") {
      const claimable =
        !item.fields.claimedBy ||
        isResumeAffinity(item.fields.claimedBy) ||
        isExpired(item.fields.leaseUntil, now);
      if (Boolean(expected) !== claimable) {
        return false;
      }
    } else if (key in item.fields) {
      if (!matchesValue(item.fields[key], expected)) {
        return false;
      }
    } else if (key in item) {
      if (!matchesValue(item[key], expected)) {
        return false;
      }
    } else {
      throw new TypeError(`Unknown Pan filter: ${key}`);
    }
  }
  return true;
}

function matchesValue(actual, expected) {
  return Array.isArray(expected)
    ? expected.includes(actual)
    : actual === expected;
}

function serializeTextField(key, value) {
  if (key === "requirements" && Array.isArray(value)) {
    return value.join("\n");
  }
  if (typeof value !== "string") {
    throw new TypeError(`${key} must be a string`);
  }
  return value;
}

export function classifyDomainIssues(issues, projectItems) {
  const projectIssueUrls = new Set(
    projectItems
      .filter((item) => item.contentClassification === "domain-issue")
      .map((item) => item.url),
  );
  const byUrl = new Map(issues.map((issue) => [issue.url, issue]));
  const results = issues.map((issue) => ({
    issue,
    type: "task",
    valid: projectIssueUrls.has(issue.url),
    ...(!projectIssueUrls.has(issue.url)
      ? {
          code: "issue-outside-project",
          proposal: "register-untriaged",
        }
      : {}),
  }));
  for (const item of projectItems) {
    if (
      item.contentClassification === "domain-issue" &&
      !byUrl.has(item.url)
    ) {
      results.push({
        issue: item,
        type: "task",
        valid: false,
        code: "project-issue-missing-from-repository-read",
      });
    }
  }
  return results;
}

function validateFieldValues(values, schema) {
  for (const [key, value] of Object.entries(values)) {
    const field = schema.fields[key];
    if (!field) {
      throw new TypeError(`Unknown Pan field: ${key}`);
    }
    if (value === null || value === undefined || value === "") {
      continue;
    }
    if (field.type === "single_select" && !field.options[value]) {
      throw new TypeError(
        `Invalid ${key} value "${value}"; expected one of ${Object.keys(field.options).join(", ")}`,
      );
    }
    if (field.type === "text") {
      serializeTextField(key, value);
    }
  }
}

function parseRequirements(value) {
  return value
    .split(/\r?\n/)
    .map((requirement) => requirement.trim())
    .filter(Boolean);
}

function validateRunnerAndLease(runner, leaseUntil, now) {
  if (!runner?.trim()) {
    throw new TypeError("runner is required");
  }
  const parsed = Date.parse(leaseUntil);
  if (!Number.isFinite(parsed) || !leaseUntil.endsWith("Z")) {
    throw new TypeError("leaseUntil must be an RFC 3339 UTC timestamp");
  }
  if (parsed <= now.getTime()) {
    throw new RangeError("leaseUntil must be in the future");
  }
}

function isExpired(leaseUntil, now) {
  if (!leaseUntil) {
    return false;
  }
  const parsed = Date.parse(leaseUntil);
  return !Number.isFinite(parsed) || parsed <= now.getTime();
}

function isResumeAffinity(claimedBy) {
  return claimedBy?.startsWith("resume:");
}

function resumeAffinityAllows(affinity, runner) {
  return runner.replace(/\/slot-\d+$/, "") === affinity.slice("resume:".length);
}

function isNoChanges(error) {
  return /no changes to make/i.test(error.stderr ?? error.message);
}
