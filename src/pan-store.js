import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { IssueCatalog } from "./issue-catalog.js";

const ISSUE_LIST_LIMIT = 1_000;
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

  async createItem({
    title,
    body = "",
    labels = [],
    assignees = [],
    fields = {},
  }, { signal } = {}) {
    if (!title?.trim()) {
      throw new TypeError("title is required");
    }
    const schema = await this.getSchema();
    validateFieldValues(fields, schema);
    signal?.throwIfAborted();

    const issueArgs = [
      "issue",
      "create",
      "--repo",
      this.repository,
      "--title",
      title,
      "--body",
      body,
    ];
    for (const label of labels) {
      issueArgs.push("--label", label);
    }
    for (const assignee of assignees) {
      issueArgs.push("--assignee", assignee);
    }

    const issueUrl = lastNonEmptyLine(
      await this.gh.run(issueArgs, { signal }),
    );
    if (!isIssueUrl(issueUrl)) {
      throw new Error(`gh issue create returned an invalid Issue URL: ${issueUrl}`);
    }
    try {
      signal?.throwIfAborted();
      return await this.addIssueToProject(issueUrl, fields, { signal });
    } catch (error) {
      if (signal?.aborted) {
        throw signal.reason ?? error;
      }
      const cleanupErrors = [];
      try {
        await this.gh.run([
          "issue",
          "delete",
          issueUrl,
          "--repo",
          this.repository,
          "--yes",
        ]);
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          [error, ...cleanupErrors],
          "PAN item creation failed and cleanup was incomplete",
        );
      }
      throw error;
    }
  }

  async addIssueToProject(issueUrl, fields = {}, { signal } = {}) {
    if (!isIssueUrl(issueUrl)) {
      throw new TypeError("a GitHub Issue URL is required");
    }
    const schema = await this.getSchema();
    validateFieldValues(fields, schema);
    signal?.throwIfAborted();
    const added = await this.gh.runJson([
      "project",
      "item-add",
      String(this.projectNumber),
      "--owner",
      this.projectOwner,
      "--url",
      issueUrl,
      "--format",
      "json",
    ], { signal });
    if (!added.id) {
      throw new Error("gh project item-add returned no Project item ID");
    }
    try {
      if (Object.keys(fields).length > 0) {
        await this.setFields(added.id, fields, { signal });
      }
      return this.#confirmItem(added.id);
    } catch (error) {
      if (signal?.aborted) {
        throw signal.reason ?? error;
      }
      try {
        await this.gh.run([
          "project",
          "item-delete",
          String(this.projectNumber),
          "--owner",
          this.projectOwner,
          "--id",
          added.id,
        ]);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "PAN Project insertion failed and cleanup was incomplete",
        );
      }
      throw error;
    }
  }

  async findProjectIssueMembership(issueUrl, { expectedProjectId } = {}) {
    if (!isIssueUrl(issueUrl)) {
      throw new TypeError("a GitHub Issue URL is required");
    }
    const snapshot = await this.readCanonicalProject();
    if (!snapshot.complete) {
      throw new Error("Project membership evidence is incomplete");
    }
    if (expectedProjectId && snapshot.id !== expectedProjectId) {
      throw new Error("Project membership changed after reconciliation planning");
    }
    return {
      snapshot,
      item: snapshot.items.find(
        (item) => item.contentClassification === "domain-issue" && item.url === issueUrl,
      ),
    };
  }

  async ensureIssueProjectMembership(
    issueUrl,
    { expectedProjectId, signal } = {},
  ) {
    const membership = await this.findProjectIssueMembership(issueUrl, {
      expectedProjectId,
    });
    if (membership.item) {
      return {
        item: membership.item,
        added: false,
        projectId: membership.snapshot.id,
      };
    }
    signal?.throwIfAborted();
    const added = await this.gh.runJson([
      "project",
      "item-add",
      String(this.projectNumber),
      "--owner",
      this.projectOwner,
      "--url",
      issueUrl,
      "--format",
      "json",
    ], { signal });
    if (!added.id) {
      throw new Error("gh project item-add returned no Project item ID");
    }
    return {
      item: await this.#confirmItem(added.id),
      added: true,
      projectId: membership.snapshot.id,
    };
  }

  async ensureItemFields(itemId, values, { signal } = {}) {
    if (!itemId) {
      throw new TypeError("itemId is required");
    }
    const schema = await this.getSchema();
    validateFieldValues(values, schema);
    let item = await this.#requireItem(itemId, { signal });
    const confirmedFields = [];
    for (const [key, value] of Object.entries(values)) {
      if ((item.fields[key] ?? "") === value) {
        confirmedFields.push(key);
        continue;
      }
      try {
        await this.setFields(itemId, { [key]: value }, { signal });
        const confirmed = await this.#confirmFields(itemId, { [key]: value }, { signal });
        if (!confirmed) {
          return {
            item,
            complete: false,
            confirmedFields,
            remainingFields: Object.keys(values).filter(
              (field) => !confirmedFields.includes(field),
            ),
            error: `Project field ${key} was not confirmed for ${itemId}`,
          };
        }
        item = confirmed;
        confirmedFields.push(key);
      } catch (error) {
        return {
          item,
          complete: false,
          confirmedFields,
          remainingFields: Object.keys(values).filter(
            (field) => !confirmedFields.includes(field),
          ),
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
    return {
      item,
      complete: true,
      confirmedFields,
      remainingFields: [],
    };
  }

  async setFields(itemId, values, { signal } = {}) {
    if (!itemId) {
      throw new TypeError("itemId is required");
    }

    const schema = await this.getSchema();
    validateFieldValues(values, schema);
    for (const [key, value] of Object.entries(values)) {
      signal?.throwIfAborted();
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

  async reconcileMergedPullRequests({ signal } = {}) {
    const items = await this.listByFilter({ status: "in-review" });
    const completed = [];
    for (const item of items) {
      signal?.throwIfAborted();
      const result = await this.completeMergedPullRequest(item.id, { signal });
      if (result.completed) {
        completed.push({
          itemId: result.item.id,
          issueNumber: result.item.number,
          pullRequestUrl: result.pullRequest.url,
        });
      }
    }
    return { scanned: items.length, completed };
  }

  async completeMergedPullRequest(itemId, { signal } = {}) {
    if (!itemId) {
      throw new TypeError("itemId is required");
    }
    const current = await this.#requireItem(itemId, { signal });
    if (current.fields.status !== "in-review") {
      return { completed: false, reason: "not-in-review", item: current };
    }
    const pullRequest = current.linkedPullRequests.find(
      (candidate) => candidate.state === "merged" || candidate.mergedAt,
    );
    if (!pullRequest) {
      return {
        completed: false,
        reason: "pull-request-not-merged",
        item: current,
      };
    }

    const closesIssue = current.state !== "closed";
    try {
      await this.setFields(itemId, { status: "done" }, { signal });
      const confirmed = await this.#confirmFields(
        itemId,
        { status: "done" },
        { signal },
      );
      if (!confirmed) {
        await this.#restoreReviewStatus(itemId);
        return {
          completed: false,
          reason: "completion-not-confirmed",
          item: await this.#requireItem(itemId, { signal }),
        };
      }
      if (closesIssue) {
        await this.#closeIssue(confirmed, { signal });
        confirmed.state = "closed";
      }
      return { completed: true, item: confirmed, pullRequest };
    } catch (error) {
      try {
        await this.#restoreReviewStatus(itemId);
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          "Merged pull request completion failed and the PAN task could not be restored",
        );
      }
      throw error;
    }
  }

  async readCanonicalProject() {
    const { items, diagnostics } = await this.#listItems({
      preserveIncomplete: true,
    });
    return {
      id: canonicalSnapshotId(items),
      capturedAt: this.now().toISOString(),
      complete: diagnostics.length === 0,
      diagnostics,
      items,
    };
  }

  async readIssueCatalog(options) {
    return new IssueCatalog({
      repository: this.repository,
      gh: this.gh,
      now: this.now,
      safetyLimit: this.projectItemSafetyLimit,
    }).read(options);
  }

  async syncOpenIssues({ beforeMutation = async () => {} } = {}) {
    const [issues, items] = await Promise.all([
      this.gh.runJson([
        "issue",
        "list",
        "--repo",
        this.repository,
        "--state",
        "open",
        "--limit",
        String(ISSUE_LIST_LIMIT),
        "--json",
        "number,title,body,url,state,updatedAt,labels,assignees",
      ]),
      this.#listItems(),
    ]);
    const knownUrls = new Set(items.map((item) => item.url));
    let added = 0;
    for (const issue of issues) {
      if (knownUrls.has(issue.url)) {
        continue;
      }
      await beforeMutation();
      await this.gh.runJson([
        "project",
        "item-add",
        String(this.projectNumber),
        "--owner",
        this.projectOwner,
        "--url",
        issue.url,
        "--format",
        "json",
      ]);
      added += 1;
    }
    return added > 0 ? this.#listItems() : items;
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

  async addComment(item, body, { signal } = {}) {
    if (!item?.number || !item.repository) {
      throw new TypeError("an Issue-backed item is required");
    }
    if (!body?.trim()) {
      throw new TypeError("comment body is required");
    }
    signal?.throwIfAborted();
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

  async findIssueByMarker(marker, { state = "all", signal } = {}) {
    if (!marker?.trim()) {
      throw new TypeError("marker is required");
    }
    if (!["open", "closed", "all"].includes(state)) {
      throw new TypeError('state must be "open", "closed", or "all"');
    }
    const issues = await this.gh.runJson([
      "issue",
      "list",
      "--repo",
      this.repository,
      "--state",
      state,
      "--limit",
      String(ISSUE_LIST_LIMIT),
      "--search",
      `${marker} in:body`,
      "--json",
      "number,title,body,url,state",
    ], { signal });
    return issues.find((issue) => issue.body?.includes(marker));
  }

  async reorderItems(itemIds, { signal } = {}) {
    if (!Array.isArray(itemIds) || itemIds.some((id) => !id)) {
      throw new TypeError("itemIds must be an array of Project item IDs");
    }
    const schema = await this.getSchema();
    const mutation =
      "mutation($projectId:ID!,$itemId:ID!,$afterId:ID){updateProjectV2ItemPosition(input:{projectId:$projectId,itemId:$itemId,afterId:$afterId}){clientMutationId}}";
    let afterId;
    for (const itemId of itemIds) {
      signal?.throwIfAborted();
      const args = [
        "api",
        "graphql",
        "-f",
        `query=${mutation}`,
        "-f",
        `projectId=${schema.projectId}`,
        "-f",
        `itemId=${itemId}`,
      ];
      if (afterId) {
        args.push("-f", `afterId=${afterId}`);
      }
      await this.gh.run(args, { signal });
      afterId = itemId;
    }
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
            `Unable to restore PAN task ${itemId} after Issue closure failed`,
          );
        }
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          "Issue closure failed and the PAN task could not be restored",
        );
      }
      throw error;
    }
  }

  async requestHumanAttention({
    itemId,
    runner,
    runnerAssignee,
    humanAssignee,
  }) {
    if (!humanAssignee?.trim()) {
      throw new TypeError("humanAssignee is required");
    }
    const current = await this.#requireItem(itemId);
    const desired = {
      claimedBy: "",
      leaseUntil: "",
      status: "blocked",
      owner: "human",
      priority: "urgent",
    };
    const fieldsReady = Object.entries(desired).every(
      ([key, value]) => (current.fields[key] ?? "") === value,
    );
    if (fieldsReady && current.assignees.includes(humanAssignee)) {
      return { requested: true, item: current };
    }
    if (!fieldsReady && runner && current.fields.claimedBy !== runner) {
      return { requested: false, reason: "not-owner", item: current };
    }

    const previousFields = {
      claimedBy: current.fields.claimedBy,
      leaseUntil: current.fields.leaseUntil,
      status: current.fields.status,
      owner: current.fields.owner,
      priority: current.fields.priority,
    };
    const removeRunner =
      runnerAssignee &&
      runnerAssignee !== humanAssignee &&
      current.assignees.includes(runnerAssignee);
    const addHuman = !current.assignees.includes(humanAssignee);
    let runnerRemoved = false;
    let humanAdded = false;
    try {
      await this.setFields(itemId, {
        claimedBy: null,
        leaseUntil: null,
        status: "blocked",
        owner: "human",
        priority: "urgent",
      });
      if (removeRunner) {
        await this.#editAssignee(current, "--remove-assignee", runnerAssignee);
        runnerRemoved = true;
      }
      if (addHuman) {
        await this.#editAssignee(current, "--add-assignee", humanAssignee);
        humanAdded = true;
      }
      const confirmed = await this.#confirmFields(itemId, desired);
      if (!confirmed) {
        throw new Error(`Unable to confirm human attention for PAN task ${itemId}`);
      }
      confirmed.assignees = [
        ...new Set([
          ...confirmed.assignees.filter(
            (assignee) => assignee !== runnerAssignee,
          ),
          humanAssignee,
        ]),
      ];
      return { requested: true, item: confirmed };
    } catch (error) {
      try {
        await this.#restoreAttentionTransition({
          itemId,
          item: current,
          fields: previousFields,
          runnerAssignee,
          humanAssignee,
          runnerRemoved,
          humanAdded,
        });
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          `Human attention transition failed and PAN task ${itemId} could not be restored: ${error.message}`,
        );
      }
      throw error;
    }
  }

  async resolveHumanAttention({
    itemId,
    humanAssignee,
    priority,
    resumeAffinity,
  }) {
    if (!humanAssignee?.trim()) {
      throw new TypeError("humanAssignee is required");
    }
    if (!["urgent", "high", "normal", "low"].includes(priority)) {
      throw new TypeError("priority must be a PAN priority");
    }
    if (resumeAffinity && !isResumeAffinity(resumeAffinity)) {
      throw new TypeError("resumeAffinity must be a PAN resume affinity");
    }
    const current = await this.#requireItem(itemId);
    const desired = {
      claimedBy: resumeAffinity ?? "",
      leaseUntil: "",
      status: "ready",
      owner: "agent",
      priority,
    };
    if (
      Object.entries(desired).every(
        ([key, value]) => (current.fields[key] ?? "") === value,
      ) &&
      !current.assignees.includes(humanAssignee)
    ) {
      return { resolved: true, item: current };
    }

    const previousFields = {
      claimedBy: current.fields.claimedBy,
      leaseUntil: current.fields.leaseUntil,
      status: current.fields.status,
      owner: current.fields.owner,
      priority: current.fields.priority,
    };
    const removeHuman = current.assignees.includes(humanAssignee);
    let humanRemoved = false;
    try {
      await this.setFields(itemId, {
        claimedBy: resumeAffinity ?? null,
        leaseUntil: null,
        status: "ready",
        owner: "agent",
        priority,
      });
      if (removeHuman) {
        await this.#editAssignee(current, "--remove-assignee", humanAssignee);
        humanRemoved = true;
      }
      const confirmed = await this.#confirmFields(itemId, desired);
      if (!confirmed) {
        throw new Error(
          `Unable to confirm human attention resolution for PAN task ${itemId}`,
        );
      }
      confirmed.assignees = confirmed.assignees.filter(
        (assignee) => assignee !== humanAssignee,
      );
      return { resolved: true, item: confirmed };
    } catch (error) {
      try {
        await this.#restoreAttentionTransition({
          itemId,
          item: current,
          fields: previousFields,
          humanAssignee,
          humanRemoved,
        });
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          `Human attention resolution failed and PAN task ${itemId} could not be restored: ${error.message}`,
        );
      }
      throw error;
    }
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

  async #restoreReviewStatus(itemId) {
    await this.setFields(itemId, { status: "in-review" });
    const restored = await this.#confirmFields(
      itemId,
      { status: "in-review" },
    );
    if (!restored) {
      throw new Error(
        `Unable to restore PAN task ${itemId} after merged pull request completion failed`,
      );
    }
  }

  async #restoreAttentionTransition({
    itemId,
    item,
    fields,
    runnerAssignee,
    humanAssignee,
    runnerRemoved = false,
    humanAdded = false,
    humanRemoved = false,
  }) {
    const errors = [];
    try {
      await this.setFields(itemId, fields);
    } catch (error) {
      errors.push(error);
    }
    if (humanAdded) {
      try {
        await this.#editAssignee(item, "--remove-assignee", humanAssignee);
      } catch (error) {
        errors.push(error);
      }
    }
    if (runnerRemoved) {
      try {
        await this.#editAssignee(item, "--add-assignee", runnerAssignee);
      } catch (error) {
        errors.push(error);
      }
    }
    if (humanRemoved) {
      try {
        await this.#editAssignee(item, "--add-assignee", humanAssignee);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(
        errors,
        `Unable to restore PAN task ${itemId} after an attention transition failed`,
      );
    }
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

function canonicalSnapshotId(items) {
  const digest = createHash("sha256")
    .update(JSON.stringify(items))
    .digest("hex");
  return `sha256:${digest}`;
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
      throw new TypeError(`Unknown PAN filter: ${key}`);
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

function validateFieldValues(values, schema) {
  for (const [key, value] of Object.entries(values)) {
    const field = schema.fields[key];
    if (!field) {
      throw new TypeError(`Unknown PAN field: ${key}`);
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

function lastNonEmptyLine(value) {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
}

function isIssueUrl(value) {
  try {
    const url = new URL(value);
    return url.hostname === "github.com" && /\/issues\/\d+$/.test(url.pathname);
  } catch {
    return false;
  }
}

function isNoChanges(error) {
  return /no changes to make/i.test(error.stderr ?? error.message);
}
