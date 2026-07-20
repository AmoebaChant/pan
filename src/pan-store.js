import { readFile } from "node:fs/promises";

const DEFAULT_LIST_LIMIT = 1_000;
const CONFIRM_ATTEMPTS = 3;
const CONFIRM_DELAY_MS = 250;

export class PanStore {
  constructor({
    repository,
    projectOwner,
    projectNumber,
    gh,
    manifest,
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

    this.repository = repository;
    this.projectOwner = projectOwner;
    this.projectNumber = projectNumber;
    this.gh = gh;
    this.manifest = manifest;
    this.now = now;
    this.sleep = sleep;
    this.schemaPromise = undefined;
  }

  async getSchema({ refresh = false } = {}) {
    if (refresh || !this.schemaPromise) {
      this.schemaPromise = this.#loadSchema();
    }
    return this.schemaPromise;
  }

  async createItem({
    title,
    body = "",
    labels = [],
    assignees = [],
    fields = {},
  }) {
    if (!title?.trim()) {
      throw new TypeError("title is required");
    }
    const schema = await this.getSchema();
    validateFieldValues(fields, schema);

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

    const issueUrl = lastNonEmptyLine(await this.gh.run(issueArgs));
    if (!isIssueUrl(issueUrl)) {
      throw new Error(`gh issue create returned an invalid Issue URL: ${issueUrl}`);
    }
    let added;
    try {
      added = await this.gh.runJson([
        "project",
        "item-add",
        String(this.projectNumber),
        "--owner",
        this.projectOwner,
        "--url",
        issueUrl,
        "--format",
        "json",
      ]);
      if (!added.id) {
        throw new Error("gh project item-add returned no Project item ID");
      }

      if (Object.keys(fields).length > 0) {
        await this.setFields(added.id, fields);
      }
      return this.#confirmItem(added.id);
    } catch (error) {
      const cleanupErrors = [];
      if (added?.id) {
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
          cleanupErrors.push(cleanupError);
        }
      }
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

  async setFields(itemId, values) {
    if (!itemId) {
      throw new TypeError("itemId is required");
    }

    const schema = await this.getSchema();
    validateFieldValues(values, schema);
    for (const [key, value] of Object.entries(values)) {
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
        await this.gh.run(args);
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
        String(DEFAULT_LIST_LIMIT),
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

  async getItem(itemId) {
    if (!itemId) {
      throw new TypeError("itemId is required");
    }
    return (await this.#listItems()).find((item) => item.id === itemId);
  }

  async addComment(item, body) {
    if (!item?.number || !item.repository) {
      throw new TypeError("an Issue-backed item is required");
    }
    if (!body?.trim()) {
      throw new TypeError("comment body is required");
    }
    return this.gh.run([
      "issue",
      "comment",
      String(item.number),
      "--repo",
      item.repository,
      "--body",
      body,
    ]);
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

  async reorderItems(itemIds) {
    if (!Array.isArray(itemIds) || itemIds.some((id) => !id)) {
      throw new TypeError("itemIds must be an array of Project item IDs");
    }
    const schema = await this.getSchema();
    const mutation =
      "mutation($projectId:ID!,$itemId:ID!,$afterId:ID){updateProjectV2ItemPosition(input:{projectId:$projectId,itemId:$itemId,afterId:$afterId}){clientMutationId}}";
    let afterId;
    for (const itemId of itemIds) {
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
      await this.gh.run(args);
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
      holder && !isExpired(current.fields.leaseUntil, this.now());
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
  }) {
    if (!runner && !force) {
      throw new TypeError("runner is required unless force is true");
    }

    const current = await this.#requireItem(itemId);
    if (!force && current.fields.claimedBy !== runner) {
      return { released: false, reason: "not-owner", item: current };
    }

    await this.setFields(itemId, {
      claimedBy: null,
      leaseUntil: null,
      ...(status ? { status } : {}),
    });
    if (assignee) {
      await this.#editAssignee(current, "--remove-assignee", assignee);
    }

    const expected = {
      claimedBy: "",
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
    return { released: true, item: confirmed };
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
    const [project, fieldList] = await Promise.all([
      this.gh.runJson([
        "project",
        "view",
        String(this.projectNumber),
        "--owner",
        this.projectOwner,
        "--format",
        "json",
      ]),
      this.gh.runJson([
        "project",
        "field-list",
        String(this.projectNumber),
        "--owner",
        this.projectOwner,
        "--format",
        "json",
      ]),
    ]);
    if (!project.id) {
      throw new Error("gh project view returned no Project ID");
    }

    const fields = {};
    for (const expected of manifest.fields) {
      const actual = fieldList.fields.find(
        (field) => field.name.toLowerCase() === expected.name.toLowerCase(),
      );
      if (!actual) {
        throw new Error(`Project is missing required field "${expected.name}"`);
      }

      const actualType =
        actual.type === "ProjectV2SingleSelectField" ? "single_select" : "text";
      if (actualType !== expected.type) {
        throw new Error(
          `Project field "${expected.name}" has type ${actual.type}, expected ${expected.type}`,
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

  async #listItems() {
    const schema = await this.getSchema();
    const result = await this.gh.runJson([
      "project",
      "item-list",
      String(this.projectNumber),
      "--owner",
      this.projectOwner,
      "--limit",
      String(DEFAULT_LIST_LIMIT),
      "--format",
      "json",
    ]);
    if (result.totalCount > result.items.length) {
      throw new Error(
        `Project has ${result.totalCount} items, exceeding the ${DEFAULT_LIST_LIMIT}-item read limit`,
      );
    }
    return result.items.map((item) =>
      normalizeItem(item, schema, this.repository),
    );
  }

  async #requireItem(itemId) {
    const item = await this.getItem(itemId);
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

  async #confirmFields(itemId, expected) {
    for (let attempt = 0; attempt < CONFIRM_ATTEMPTS; attempt += 1) {
      const item = await this.getItem(itemId);
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
}

function normalizeItem(item, schema, defaultRepository) {
  const content = item.content ?? {};
  const fields = {};
  for (const field of Object.values(schema.fields)) {
    const value = getCaseInsensitive(item, field.name, field.key);
    fields[field.key] = value ?? "";
  }

  return {
    id: item.id,
    number: content.number ?? item.number,
    title: content.title ?? item.title ?? "",
    body: content.body ?? item.body ?? "",
    url: content.url ?? item.url ?? "",
    state: (content.state ?? item.state ?? "").toLowerCase(),
    repository:
      normalizeRepository(content.repository ?? item.repository) ??
      defaultRepository,
    assignees: normalizeNames(content.assignees ?? item.assignees),
    labels: normalizeNames(content.labels ?? item.labels),
    fields,
    requirements: parseRequirements(fields.requirements),
  };
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
        !item.fields.claimedBy || isExpired(item.fields.leaseUntil, now);
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

function getCaseInsensitive(object, ...keys) {
  for (const key of keys) {
    if (Object.hasOwn(object, key)) {
      return object[key];
    }
    const match = Object.keys(object).find(
      (candidate) => candidate.toLowerCase() === key.toLowerCase(),
    );
    if (match) {
      return object[match];
    }
  }
  return undefined;
}

function normalizeNames(values = []) {
  return values.map((value) =>
    typeof value === "string" ? value : value.login ?? value.name,
  );
}

function normalizeRepository(repository) {
  if (!repository) {
    return undefined;
  }
  if (typeof repository === "string") {
    return repository;
  }
  return repository.nameWithOwner ?? repository.name;
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
