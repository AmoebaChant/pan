import assert from "node:assert/strict";
import test from "node:test";

import { PortfolioSnapshotBuilder } from "../src/index.js";

const NOW = new Date("2026-07-20T22:00:00.000Z");

test("builds one evidence dossier for every canonical lifecycle item", async () => {
  const items = [
    item("ready", {
      requirements: ["repo:example/tool", "delivery:pull-request"],
    }),
    item("done", { status: "done" }),
    item("closed", { state: "closed" }),
    item("leased", {
      status: "in-progress",
      claimedBy: "runner-a",
      leaseUntil: "2026-07-20T23:00:00.000Z",
    }),
    item("blocked", { status: "blocked" }),
    item("detail", { status: "needs-detail" }),
    item("unsupported", { status: "future-state" }),
  ];
  const snapshot = await builder({ items }).build();

  assert.equal(snapshot.complete, true);
  assert.equal(snapshot.usableForMutation, true);
  assert.deepEqual(
    snapshot.dossiers.map((dossier) => [
      dossier.item.id,
      dossier.canonicalIndex,
      dossier.preclassification,
    ]),
    [
      ["ready", 0, "actionable"],
      ["done", 1, "done"],
      ["closed", 2, "closed"],
      ["leased", 3, "actively-leased"],
      ["blocked", 4, "blocked"],
      ["detail", 5, "needs-detail"],
      ["unsupported", 6, "unsupported"],
    ],
  );
  assert.deepEqual(snapshot.dossiers[0].dependencies, [
    { source: "issue-body", text: "#41" },
  ]);
  assert.deepEqual(snapshot.dossiers[0].blockers, [
    { source: "workstream:planning/example", text: "approval from legal" },
  ]);
  assert.deepEqual(snapshot.dossiers[0].compatibility.runners, [
    { id: "runner-a", freeCapacity: 1, capacityKnown: true },
  ]);
  assert.equal(snapshot.dossiers[0].workstream.history[0].sha, "a".repeat(40));
  assert.deepEqual(
    snapshot.project.items,
    items.map((entry) => entry.id),
  );
});

test("marks missing actionable workstream evidence unusable without omitting the item", async () => {
  const snapshot = await builder({
    items: [item("missing", { workstream: "missing/path" })],
    missingWorkstreams: ["missing/path"],
  }).build();

  assert.equal(snapshot.complete, false);
  assert.equal(snapshot.usableForMutation, false);
  assert.equal(snapshot.dossiers.length, 1);
  assert.equal(snapshot.dossiers[0].workstream.available, false);
  assert.ok(!JSON.stringify(snapshot).includes("C:\\private"));
  assert.ok(
    snapshot.diagnostics.some(
      (diagnostic) =>
        diagnostic.code === "unknown-workstream" ||
        diagnostic.code === "workstream-read-failed",
    ),
  );
});

test("treats an absent workstream on needs-detail work as known missing evidence", async () => {
  const snapshot = await builder({
    items: [
      item("detail", {
        status: "needs-detail",
        workstream: "",
      }),
    ],
  }).build();

  assert.equal(snapshot.complete, true);
  assert.equal(snapshot.dossiers[0].evidenceAvailable.workstream, false);
  assert.equal(
    snapshot.diagnostics.some(
      (diagnostic) => diagnostic.code === "missing-workstream",
    ),
    false,
  );
});

test("identifies how to repair an actionable item with no workstream", async () => {
  const snapshot = await builder({
    items: [
      item("42", {
        status: "ready",
        workstream: "",
      }),
    ],
  }).build();

  assert.equal(snapshot.complete, false);
  assert.equal(snapshot.usableForMutation, false);
  assert.deepEqual(snapshot.diagnostics, [
    {
      source: "item:42",
      code: "missing-workstream",
      message:
        'Project item 42 (Issue #42 "Task 42", https://github.com/example/domain/issues/42) has status ready but no workstream reference; set its Project workstream field to a valid workstream path, or move it to needs-detail until the reference is known',
    },
  ]);
});

test("propagates partial source diagnostics to mutation readiness", async () => {
  const snapshot = await builder({
    workstreamComplete: false,
    workstreamDiagnostics: [
      { path: "malformed", reason: "README.md is missing" },
    ],
    runnerComplete: false,
    runnerDiagnostics: [
      { code: "invalid-runner-profile", message: "Profile is malformed" },
    ],
  }).build();

  assert.equal(snapshot.complete, false);
  assert.equal(snapshot.usableForMutation, false);
  assert.deepEqual(
    snapshot.diagnostics.map((diagnostic) => diagnostic.source),
    ["workstreams", "runners"],
  );
});

test("joins Project items to the catalog and diagnoses a missing Issue", async () => {
  const first = item("1");
  const second = item("2");
  const snapshot = await builder({
    items: [first, second],
    catalogIssues: [catalogIssue(first)],
  }).build();

  assert.equal(snapshot.complete, false);
  assert.deepEqual(
    snapshot.dossiers.map((dossier) => dossier.evidenceAvailable.issue),
    [true, false],
  );
  assert.ok(
    snapshot.diagnostics.some(
      (diagnostic) => diagnostic.code === "project-issue-missing-catalog",
    ),
  );
});

test("retains non-Issue Project content in canonical order", async () => {
  const pullRequest = {
    ...item("1"),
    contentClassification: "pull-request",
    contentType: "PullRequest",
  };
  const snapshot = await builder({ items: [pullRequest] }).build();

  assert.equal(snapshot.complete, true);
  assert.equal(snapshot.dossiers[0].projectContent.classification, "pull-request");
  assert.equal(snapshot.dossiers[0].preclassification, "unsupported");
  assert.equal(snapshot.dossiers[0].evidenceAvailable.issue, false);
});

test("uses resource-specific expected-state references", async () => {
  const entry = item("1");
  const first = await builder({
    items: [entry],
    catalogId: "sha256:catalog-first",
  }).build();
  const changed = await builder({
    items: [entry],
    catalogId: "sha256:catalog-changed",
  }).build();

  assert.notEqual(first.id, changed.id);
  assert.notEqual(
    first.expectedState.issueCatalog,
    changed.expectedState.issueCatalog,
  );
  assert.match(first.expectedState.projectOrder, /^sha256:/);
  assert.match(first.expectedState.workstreamBlobs, /^sha256:/);
});

test("produces immutable repeatable identities independent of property insertion order", async () => {
  const firstItem = item("ready");
  const reorderedItem = {
    ...firstItem,
    fields: {
      workstream: firstItem.fields.workstream,
      claimedBy: firstItem.fields.claimedBy,
      leaseUntil: firstItem.fields.leaseUntil,
      priority: firstItem.fields.priority,
      status: firstItem.fields.status,
    },
  };
  const first = await builder({ items: [firstItem] }).build();
  const repeated = await builder({ items: [firstItem] }).build();
  const reordered = await builder({ items: [reorderedItem] }).build();

  assert.equal(first.id, repeated.id);
  assert.equal(first.id, reordered.id);
  assert.match(first.id, /^sha256:[0-9a-f]{64}$/);
  assert.match(JSON.stringify(first), /^\{"id":"sha256:/);
  assert.throws(
    () => first.dossiers.push({}),
    /object is not extensible|read only|frozen/i,
  );
});

test("does not serialize clone paths or runner-private values", async () => {
  const snapshot = await builder().build();
  const serialized = JSON.stringify(snapshot);

  for (const privateValue of [
    "C:\\private",
    "machine-a",
    "workspaceRoot",
    "terminal",
    "copilot",
  ]) {
    assert.ok(!serialized.includes(privateValue));
  }
});

function builder({
  items = [item("ready")],
  missingWorkstreams = [],
  workstreamComplete = true,
  workstreamDiagnostics = [],
  runnerComplete = true,
  runnerDiagnostics = [],
  catalogComplete = true,
  catalogIssues,
  catalogDiagnostics = [],
  catalogId = "sha256:issues",
} = {}) {
  const missing = new Set(missingWorkstreams);
  return new PortfolioSnapshotBuilder({
    now: () => NOW,
    projectSource: {
      readCanonicalProject: async () => ({
        id: "sha256:project",
        capturedAt: NOW.toISOString(),
        complete: true,
        items,
      }),
    },
    issueCatalogSource: {
      readIssueCatalog: async () => ({
        id: catalogId,
        repository: "example/domain",
        capturedAt: NOW.toISOString(),
        complete: catalogComplete,
        issues: catalogIssues ?? items.map(catalogIssue),
        excludedPullRequests: 0,
        diagnostics: catalogDiagnostics,
        source: {
          comments: { complete: true },
          relationships: { complete: false, excluded: true },
        },
      }),
    },
    workstreamSource: {
      list: async () => ({
        revision: "b".repeat(40),
        complete: workstreamComplete,
        workstreams: missing.has("planning/example")
          ? []
          : [{ path: "planning/example" }],
        errors: workstreamDiagnostics,
      }),
      read: async (workstream) => {
        if (missing.has(workstream)) {
          throw new Error(
            `Workstream ${workstream} does not exist at C:\\private\\domain`,
          );
        }
        return {
          path: workstream,
          sourcePath: `workstreams/${workstream}/README.md`,
          content: "# Example\n\nBlocker: approval from legal\n",
          contentHash: "sha256:workstream",
          modifiedAt: "2026-07-20T20:00:00.000Z",
          revision: "b".repeat(40),
          localPath: "C:\\private\\must-not-leak",
        };
      },
      history: async (workstream) => {
        if (missing.has(workstream)) {
          throw new Error(
            `Workstream ${workstream} does not exist at C:\\private\\domain`,
          );
        }
        return [
          {
            sha: "a".repeat(40),
            committedAt: "2026-07-20T19:00:00.000Z",
            subject: "Update example",
            changedPath: `workstreams/${workstream}/README.md`,
            localPath: "C:\\private\\must-not-leak",
          },
        ];
      },
    },
    runnerSource: {
      loadAvailability: async () => ({
        complete: runnerComplete,
        diagnostics: runnerDiagnostics,
        runners: [
          {
            id: "runner-a",
            online: true,
            capabilities: ["repo:example/tool"],
            playbooks: [
              {
                id: "pan-development",
                capabilities: ["repo:example/tool"],
                repositories: ["example/tool"],
                delivery: "pull-request",
              },
            ],
            maximumCapacity: 1,
            activeLeaseCount: 0,
            freeCapacity: 1,
            capacityKnown: true,
            machine: "machine-a",
            workspaceRoot: "C:\\private\\worktrees",
          },
        ],
      }),
    },
  });
}

function catalogIssue(entry) {
  return {
    id: `I_${entry.number}`,
    number: entry.number,
    title: entry.title,
    body: entry.body,
    url: entry.url,
    state: entry.state,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    closedAt: null,
    repository: entry.repository,
    labels: entry.labels,
    assignees: entry.assignees,
    comments: entry.comments,
    relationships: [],
  };
}

function item(id, options = {}) {
  const status = options.status ?? "ready";
  const requirements = options.requirements ?? [];
  const numericId = Number.parseInt(id.replace(/\D/g, ""), 10);
  return {
    id,
    number:
      options.number ??
      (numericId ||
        [...id].reduce((sum, character) => sum + character.charCodeAt(0), 0)),
    title: `Task ${id}`,
    body: "Depends on: #41",
    url: `https://github.com/example/domain/issues/${id}`,
    state: options.state ?? "open",
    createdAt: "2026-07-18T20:00:00.000Z",
    updatedAt: "2026-07-20T20:00:00.000Z",
    repository: "example/domain",
    assignees: [],
    labels: [],
    comments: [
      {
        id: `comment-${id}`,
        body: "Current evidence.",
        url: `https://github.com/example/domain/issues/${id}#comment`,
        createdAt: "2026-07-20T20:00:00.000Z",
        updatedAt: "2026-07-20T20:00:00.000Z",
        author: "octocat",
      },
    ],
    fields: {
      status,
      priority: "normal",
      leaseUntil: options.leaseUntil ?? "",
      claimedBy: options.claimedBy ?? "",
      workstream:
        options.workstream === undefined
          ? "planning/example"
          : options.workstream,
    },
    requirements,
  };
}
