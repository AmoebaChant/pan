import assert from "node:assert/strict";
import test from "node:test";

import {
  PAN_TOOL_OPERATIONS,
  PanToolError,
  PanToolRegistry,
} from "../src/index.js";

const DOMAIN = {
  repository: "example/domain",
  projectOwner: "example",
  projectNumber: 7,
  path: "C:\\domain",
};

test("maps every custom-agent operation to a constrained registry read", async () => {
  const { registry } = fixture();
  const customAgentOperations = [
    "read_portfolio",
    "read_workstream",
    "read_issue",
    "read_runner_availability",
    "propose_actions",
  ];

  for (const operation of customAgentOperations) {
    assert.ok(PAN_TOOL_OPERATIONS.includes(operation));
  }
  assert.equal(
    (await registry.dispatch("read_portfolio")).data.id,
    "snapshot-1",
  );
  assert.equal(
    (
      await registry.dispatch("read_workstream", {
        path: "planning/example",
      })
    ).data.path,
    "planning/example",
  );
  assert.equal(
    (await registry.dispatch("read_issue", { itemId: "item-1" })).data
      .repository,
    DOMAIN.repository,
  );
  assert.equal(
    (await registry.dispatch("read_runner_availability")).data.runners[0]
      .id,
    "runner-a",
  );
});

test("exposes bounded canonical, comment, rationale, search, history, and attention reads", async () => {
  const { registry } = fixture();

  assert.equal(
    (await registry.dispatch("read_canonical_items")).data.items.length,
    1,
  );
  assert.equal(
    (
      await registry.dispatch("read_issue_comments", {
        itemId: "item-1",
      })
    ).data[0].body,
    "Evidence",
  );
  assert.equal(
    (
      await registry.dispatch("read_current_rationale", {
        itemId: "item-1",
      })
    ).data.rationale,
    "Current rationale",
  );
  assert.equal(
    (
      await registry.dispatch("search_workstreams", {
        query: "evidence",
        limit: 5,
      })
    ).data.matches.length,
    1,
  );
  assert.equal(
    (
      await registry.dispatch("read_workstream_history", {
        path: "planning/example",
      })
    ).data[0].sha,
    "a".repeat(40),
  );
  assert.ok(
    !JSON.stringify(
      (
        await registry.dispatch("search_workstreams", {
          query: "evidence",
        })
      ).data,
    ).includes("C:\\private"),
  );
  const attention = (
    await registry.dispatch("read_unresolved_attention")
  ).data[0];
  assert.equal(attention.itemId, "item-1");
  assert.equal(Object.hasOwn(attention, "locator"), false);
});

test("rejects denied names, malformed arguments, and unknown properties before source access", async () => {
  const { registry, calls } = fixture();

  await assert.rejects(
    registry.dispatch("shell", { command: "whoami" }),
    (error) =>
      error instanceof PanToolError && error.code === "unknown-operation",
  );
  await assert.rejects(
    registry.dispatch("read_issue", {
      itemId: "item-1",
      repository: "another/domain",
    }),
    /unknown properties/i,
  );
  await assert.rejects(
    registry.dispatch("read_workstream", { path: "../private" }),
    /confined workstream path/i,
  );
  await assert.rejects(
    registry.dispatch("read_workstream", { path: "C:/private" }),
    /confined workstream path/i,
  );
  await assert.rejects(
    registry.dispatch("search_workstreams", {
      query: "evidence",
      limit: 0,
    }),
    /integer from 1 through 100/i,
  );

  assert.deepEqual(calls, {});
});

test("binds configured sources and rejects cross-domain read evidence", async () => {
  assert.throws(
    () =>
      fixture({
        projectBinding: { repository: "another/domain" },
      }),
    /does not match the configured domain/i,
  );

  const { registry } = fixture({ itemRepository: "another/domain" });
  await assert.rejects(
    registry.dispatch("read_canonical_items"),
    (error) => error.code === "cross-domain-evidence",
  );
});

test("rejects cross-domain and path-escape proposals before source access", async () => {
  const { registry, calls } = fixture();

  await assert.rejects(
    registry.dispatch("propose_issue", {
      action: issueAction({
        repository: "another/domain",
      }),
    }),
    (error) => error.code === "cross-domain-action",
  );
  await assert.rejects(
    registry.dispatch("propose_issue", {
      action: issueAction({
        repository: DOMAIN.repository,
        workstream: "../../outside",
      }),
    }),
    (error) => error.code === "invalid-workstream",
  );
  await assert.rejects(
    registry.dispatch("propose_comment", {
      action: commentAction(
        "https://github.com/another/domain/issues/1",
      ),
    }),
    (error) => error.code === "cross-domain-action",
  );

  assert.deepEqual(calls, {});
});

test("validates strict action records and generates dry-run proposals without mutation", async () => {
  const { registry, calls } = fixture();
  const proposed = await registry.dispatch("propose_actions", {
    actions: [fieldAction()],
  });

  assert.equal(proposed.proposals.length, 1);
  assert.equal(proposed.proposals[0].action.kind, "field-update");
  assert.equal(proposed.proposals[0].policy.authority, "automatic");
  assert.deepEqual(proposed.rejected, []);
  assert.equal(calls.snapshot, 1);
  assert.equal(calls.mutations, undefined);

  await assert.rejects(
    registry.dispatch("propose_actions", {
      actions: [{ ...fieldAction(), surprise: true }],
    }),
    /unknown properties/i,
  );
  const malformed = fieldAction();
  delete malformed.confidence;
  await assert.rejects(
    registry.dispatch("propose_actions", {
      actions: [malformed],
    }),
    (error) => error.code === "invalid-arguments",
  );
  await assert.rejects(
    registry.dispatch("propose_comment", {
      action: fieldAction(),
    }),
    /requires action kind issue-comment/i,
  );
});

test("returns policy rejections and does not expose local paths in source errors", async () => {
  const protectedFixture = fixture({ status: "in-progress" });
  const result = await protectedFixture.registry.dispatch(
    "propose_actions",
    { actions: [fieldAction({ status: "in-progress" })] },
  );
  assert.equal(result.proposals.length, 0);
  assert.match(result.rejected[0].reasons[0], /protected/i);

  const failing = fixture({ failRead: true }).registry;
  await assert.rejects(
    failing.dispatch("read_workstream", {
      path: "planning/example",
    }),
    (error) =>
      error.code === "domain-read-failed" &&
      !error.message.includes("C:\\private"),
  );
});

function fixture({
  status = "ready",
  failRead = false,
  itemRepository = DOMAIN.repository,
  projectBinding = {},
} = {}) {
  const calls = {};
  const item = canonicalItem(status, itemRepository);
  const project = {
    id: "project-1",
    complete: true,
    items: [item],
  };
  const snapshot = {
    id: "snapshot-1",
    usableForMutation: true,
    project: { items: [item.id] },
    dossiers: [
      {
        item,
        lease: { active: false },
      },
    ],
  };
  const count = (name) => {
    calls[name] = (calls[name] ?? 0) + 1;
  };
  return {
    calls,
    registry: new PanToolRegistry({
      domain: DOMAIN,
      snapshotSource: {
        build: async () => {
          count("snapshot");
          return snapshot;
        },
      },
      projectSource: {
        ...projectBinding,
        readCanonicalProject: async () => {
          count("project");
          return project;
        },
      },
      workstreamSource: {
        read: async (workstream) => {
          count("workstream");
          if (failRead) {
            throw new Error(
              "ENOENT: no such file at C:\\private\\domain\\README.md",
            );
          }
          return {
            path: workstream,
            sourcePath: `workstreams/${workstream}/README.md`,
            content: "Evidence",
            contentHash: "sha256:content",
            modifiedAt: "2026-07-20T20:00:00.000Z",
            revision: "b".repeat(40),
            localPath: "C:\\private\\domain",
          };
        },
        search: async () => {
          count("search");
          return {
            revision: "b".repeat(40),
            complete: false,
            limited: false,
            matches: [
              {
                path: "planning/example",
                sourcePath: "workstreams/planning/example/README.md",
                startLine: 1,
                endLine: 1,
                text: "Evidence",
              },
            ],
            errors: [
              {
                path: "other",
                reason: "Failed at C:\\private\\domain",
              },
            ],
          };
        },
        history: async () => {
          count("history");
          return [
            {
              sha: "a".repeat(40),
              committedAt: "2026-07-20T19:00:00.000Z",
              subject: "Update evidence",
              changedPath: "workstreams/planning/example/README.md",
              localPath: "C:\\private\\domain",
            },
          ];
        },
      },
      runnerSource: {
        loadAvailability: async () => {
          count("runners");
          return {
            complete: true,
            runners: [
              {
                id: "runner-a",
                online: true,
                capabilities: ["repo:example/domain"],
                maximumCapacity: 1,
                activeLeaseCount: 0,
                freeCapacity: 1,
                capacityKnown: true,
                machine: "private-machine",
              },
            ],
            diagnostics: [],
          };
        },
      },
      attentionSource: {
        inbox: async () => {
          count("attention");
          return [
            {
              id: 1,
              itemId: item.id,
              title: item.title,
              status: item.fields.status,
              priority: item.fields.priority,
              issueUrl: item.url,
              kind: "review",
              prompt: "Review it",
              locator: "C:\\private\\terminal",
            },
          ];
        },
      },
    }),
  };
}

function canonicalItem(status, repository = DOMAIN.repository) {
  return {
    id: "item-1",
    number: 1,
    title: "Task",
    body: "Evidence",
    url: "https://github.com/example/domain/issues/1",
    state: "open",
    repository,
    comments: [{ id: "comment-1", body: "Evidence" }],
    fields: {
      status,
      priority: "normal",
      rationale: "Current rationale",
      reviewAt: "2026-07-21T20:00:00.000Z",
    },
  };
}

function fieldAction({ status = "ready" } = {}) {
  return baseAction({
    kind: "field-update",
    expectedState: { status, priority: "normal" },
    target: {
      itemId: "item-1",
      field: "priority",
      value: "high",
    },
  });
}

function issueAction({ repository, workstream } = {}) {
  return baseAction({
    kind: "issue-create",
    expectedState: { absent: true },
    target: {
      repository,
      title: "New task",
      ...(workstream ? { workstream } : {}),
    },
  });
}

function commentAction(issueUrl) {
  return baseAction({
    kind: "issue-comment",
    expectedState: { updatedAt: "2026-07-20T20:00:00.000Z" },
    target: { issueUrl, body: "A durable comment." },
  });
}

function baseAction({ kind, expectedState, target }) {
  return {
    version: 1,
    actionId: `action-${kind}`,
    kind,
    rationale: "The cited evidence supports this proposed action.",
    confidence: 0.9,
    evidence: [
      {
        kind: "issue",
        locator: "https://github.com/example/domain/issues/1",
      },
    ],
    idempotencyKey: `idempotency-${kind}`,
    expectedState,
    target,
  };
}
