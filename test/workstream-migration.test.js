import assert from "node:assert/strict";
import test from "node:test";

import { WorkstreamMigration } from "../src/index.js";

const PARENT = "https://github.com/example/domain/issues/101";
const CHILD = "https://github.com/example/domain/issues/102";

test("dry-run inventories nested workstreams and reports task changes without mutating", async () => {
  const fixture = migrationFixture();
  const report = await fixture.migration.run({ dryRun: true });

  assert.equal(report.dryRun, true);
  assert.deepEqual(
    report.sources.map((source) => source.path),
    ["parent", "parent/child"],
  );
  assert.ok(
    report.planned.some(
      (entry) =>
        entry.action === "add-sub-issue" &&
        entry.parentSource === "parent" &&
        entry.childSource === "parent/child",
    ),
  );
  assert.ok(
    report.planned.some(
      (entry) =>
        entry.action === "update-task-workstream" &&
        entry.previous === "parent/child",
    ),
  );
  assert.ok(
    report.planned.some(
      (entry) =>
        entry.action === "register-legacy-task" &&
        entry.state === "closed",
    ),
  );
  assert.deepEqual(fixture.store.mutations, []);
});

test("resume mapping makes migration idempotent and verifies before completion", async () => {
  const fixture = migrationFixture();
  const resume = {
    version: 1,
    repository: "example/domain",
    projectOwner: "example",
    projectNumber: 12,
    mapping: { parent: PARENT, "parent/child": CHILD },
    createdIssues: [],
    parentRelationships: [],
    taskFieldChanges: [],
    registeredTasks: [],
  };

  const first = await fixture.migration.run({ dryRun: false, resume });
  const second = await fixture.migration.run({
    dryRun: false,
    resume: first,
  });

  assert.equal(first.complete, true);
  assert.equal(second.complete, true);
  assert.equal(
    fixture.gh.calls.filter(
      (call) => call.includes("--method POST") && call.includes("/sub_issues"),
    ).length,
    1,
    "the resumed relationship is not written twice",
  );
  assert.equal(
    fixture.store.mutations.filter((mutation) => mutation.kind === "field")
      .length,
    1,
  );
});

test("removes mapped Workstream Issues from the backlog before completion", async () => {
  const fixture = migrationFixture({ workstreamInProject: true });
  const resume = {
    version: 1,
    repository: "example/domain",
    projectOwner: "example",
    projectNumber: 12,
    mapping: { parent: PARENT, "parent/child": CHILD },
  };

  const report = await fixture.migration.run({ dryRun: false, resume });

  assert.equal(report.complete, true);
  assert.deepEqual(report.removedWorkstreamItems, [
    { issueUrl: PARENT, itemId: "workstream-item" },
  ]);
  assert.ok(
    fixture.store.mutations.some(
      (mutation) =>
        mutation.kind === "remove" && mutation.itemId === "workstream-item",
    ),
  );
});

test("checkpoints each created Workstream mapping for safe resume", async () => {
  const fixture = migrationFixture({ createIssues: true });
  const checkpoints = [];

  const report = await fixture.migration.run({
    dryRun: false,
    checkpoint: async (current) => {
      checkpoints.push(structuredClone(current.mapping));
      if (checkpoints.length === 1) {
        throw new Error("simulated interruption");
      }
    },
  });

  assert.equal(report.complete, false);
  assert.deepEqual(checkpoints[0], { parent: PARENT });
});

function migrationFixture({
  workstreamInProject = false,
  createIssues = false,
} = {}) {
  const files = {
    "workstreams/parent/README.md": "# Parent\n",
    "workstreams/parent/child/README.md": "# Child\n",
  };
  const gh = {
    calls: [],
    async runJson(args) {
      this.calls.push(args.join(" "));
      const endpoint = args.find((arg) => arg.startsWith("repos/"));
      if (endpoint === "repos/example/domain") {
        return { default_branch: "main" };
      }
      if (endpoint?.includes("/git/trees/")) {
        return {
          truncated: false,
          tree: Object.keys(files).map((filePath) => ({
            path: filePath,
            type: "blob",
          })),
        };
      }
      if (endpoint?.includes("/contents/")) {
        const filePath = endpoint.slice(endpoint.indexOf("/contents/") + 10);
        return { content: Buffer.from(files[filePath]).toString("base64") };
      }
      if (endpoint?.endsWith("/issues/102")) {
        return { id: 1002 };
      }
      if (endpoint?.endsWith("/issues/101/sub_issues")) {
        return { id: 1 };
      }
      if (endpoint?.includes("/issues/101/sub_issues?")) {
        return [{ html_url: CHILD }];
      }
      throw new Error(`Unexpected gh call: ${args.join(" ")}`);
    },
    async run(args) {
      if (createIssues && args[0] === "issue" && args[1] === "create") {
        return args.includes("Parent") ? PARENT : CHILD;
      }
      throw new Error(`Unexpected command: ${args.join(" ")}`);
    },
  };
  const task = {
    id: "item-1",
    number: 1,
    url: "https://github.com/example/domain/issues/1",
    fields: { workstream: "parent/child", status: "ready" },
    contentClassification: "domain-issue",
  };
  const historical = {
    number: 2,
    url: "https://github.com/example/domain/issues/2",
    state: "closed",
    labels: [],
  };
  const store = {
    mutations: [],
    async listRepositoryIssues() {
      return [
        {
          number: 101,
          url: PARENT,
          state: "open",
          labels: [{ name: "Workstream" }],
        },
        {
          number: 102,
          url: CHILD,
          state: "open",
          labels: [{ name: "Workstream" }],
        },
        historical,
      ];
    },
    async listItems() {
      return [
        task,
        ...(workstreamInProject && !this.workstreamRemoved
          ? [
              {
                id: "workstream-item",
                url: PARENT,
                fields: { workstream: "" },
                contentClassification: "domain-issue",
              },
            ]
          : []),
        ...(this.registered ? [this.registered] : []),
      ];
    },
    async setFields(itemId, values) {
      this.mutations.push({ kind: "field", itemId, values });
      Object.assign(task.fields, values);
    },
    async addIssueToProject(issue) {
      this.mutations.push({ kind: "register", issue: issue.url });
      this.registered = {
        id: "item-2",
        url: issue.url,
        fields: { status: "done", workstream: "" },
        contentClassification: "domain-issue",
      };
      return this.registered;
    },
    async removeItem(itemId) {
      this.mutations.push({ kind: "remove", itemId });
      this.workstreamRemoved = true;
      return { removed: true, itemId };
    },
  };
  const bodies = new Map([
    [PARENT, files["workstreams/parent/README.md"]],
    [CHILD, files["workstreams/parent/child/README.md"]],
  ]);
  const workstreams = {
    async read(url) {
      return { url, body: bodies.get(url), labels: ["Workstream"] };
    },
    async validate(url) {
      if (!bodies.has(url)) {
        throw new Error("unknown workstream");
      }
      return { url };
    },
  };
  return {
    gh,
    store,
    migration: new WorkstreamMigration({
      repository: "example/domain",
      projectOwner: "example",
      projectNumber: 12,
      gh,
      store,
      workstreams,
      now: () => new Date("2026-07-31T12:00:00Z"),
    }),
  };
}
