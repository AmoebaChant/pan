import assert from "node:assert/strict";
import test from "node:test";

import { PanReviewService } from "../src/index.js";

test("returns a dry-run recommendation without mutating GitHub", async () => {
  const fixture = reviewFixture();
  const result = await fixture.service.run();

  assert.equal(result.applied, false);
  assert.equal(result.response.recommendation, "Do B before A.");
  assert.deepEqual(fixture.calls, []);
});

test("validates, applies, and confirms a canonical reorder", async () => {
  const fixture = reviewFixture();
  const result = await fixture.service.run({ apply: true });

  assert.equal(result.applied, true);
  assert.deepEqual(fixture.order, ["item-b", "item-a"]);
  assert.deepEqual(fixture.calls, [["reorder", ["item-b", "item-a"]]]);
  assert.equal(result.response.appliedActions.length, 1);
  assert.deepEqual(result.response.rejectedActions, []);
});

test("applies actions submitted by the interactive host", async () => {
  const fixture = reviewFixture();
  const result = await fixture.service.applyActions([
    {
      version: 1,
      actionId: "reorder-interactive",
      kind: "canonical-reorder",
      rationale: "The user confirmed that B must be completed before A.",
      confidence: 0.95,
      evidence: [{ kind: "issue", locator: "item-b" }],
      idempotencyKey: "reorder:interactive",
      expectedState: { snapshotId: "snapshot-1" },
      target: { orderedItemIds: ["item-b", "item-a"] },
    },
  ]);

  assert.deepEqual(fixture.order, ["item-b", "item-a"]);
  assert.equal(result.appliedActions.length, 1);
  assert.deepEqual(result.effects.incomplete, []);
});

test("uses the same agent for conversational decisions", async () => {
  const fixture = reviewFixture();
  const result = await fixture.service.run({
    userInput: "Why should B come first?",
  });

  assert.equal(result.response.recommendation, "Do B before A.");
  assert.equal(fixture.lastTurn.mode, "interactive-chat");
  assert.equal(fixture.lastTurn.userInput, "Why should B come first?");
  assert.deepEqual(fixture.lastTurn.portfolio.project.items, [
    "item-a",
    "item-b",
  ]);
});

test("rejects a field update when GitHub changed during reasoning", async () => {
  const fixture = reviewFixture({
    action: {
      version: 1,
      actionId: "priority-1",
      kind: "field-update",
      rationale: "A new commitment makes this work urgent.",
      confidence: 0.9,
      evidence: [{ kind: "issue", locator: "item-a" }],
      idempotencyKey: "priority:item-a:high",
      expectedState: {
        snapshotId: "snapshot-1",
        priority: "normal",
      },
      target: {
        itemId: "item-a",
        field: "priority",
        value: "high",
      },
    },
    mutateCurrent: (items) => {
      items[0].fields.priority = "urgent";
    },
  });

  const result = await fixture.service.run({ apply: true });

  assert.equal(result.response.appliedActions.length, 0);
  assert.match(result.response.rejectedActions[0].reason, /no longer matches/i);
  assert.deepEqual(fixture.calls, []);
});

test("never permits model updates to runner lease fields", async () => {
  const fixture = reviewFixture({
    action: {
      version: 1,
      actionId: "lease-1",
      kind: "field-update",
      rationale: "The runner lease looks stale and should be cleared.",
      confidence: 0.9,
      evidence: [{ kind: "project-field", locator: "item-a:claimedBy" }],
      idempotencyKey: "lease:item-a:clear",
      expectedState: {
        snapshotId: "snapshot-1",
        claimedBy: "runner-a",
      },
      target: {
        itemId: "item-a",
        field: "claimedBy",
        value: "",
      },
    },
    mutateSnapshot: (snapshot) => {
      snapshot.dossiers[0].item.fields.claimedBy = "runner-a";
    },
  });

  const result = await fixture.service.run({ apply: true });

  assert.equal(result.response.appliedActions.length, 0);
  assert.match(result.response.rejectedActions[0].reason, /operational field/i);
  assert.deepEqual(fixture.calls, []);
});

test("reports an incomplete effect and stops after a mutation failure", async () => {
  const fixture = reviewFixture({ failReorder: true });
  const result = await fixture.service.run({ apply: true });

  assert.equal(result.response.appliedActions.length, 0);
  assert.equal(result.response.effects.incomplete.length, 1);
  assert.match(
    result.response.effects.incomplete[0].summary,
    /could not confirm/i,
  );
});

test("reassesses active leases from fresh GitHub state", async () => {
  const fixture = reviewFixture({
    action: {
      version: 1,
      actionId: "priority-1",
      kind: "field-update",
      rationale: "A new commitment makes this work urgent.",
      confidence: 0.9,
      evidence: [{ kind: "issue", locator: "item-a" }],
      idempotencyKey: "priority:item-a:high",
      expectedState: {
        snapshotId: "snapshot-1",
        priority: "normal",
      },
      target: {
        itemId: "item-a",
        field: "priority",
        value: "high",
      },
    },
    mutateCurrent: (items) => {
      items[0].fields.status = "in-progress";
      items[0].fields.claimedBy = "runner-a";
      items[0].fields.leaseUntil = "2099-01-01T00:00:00.000Z";
    },
  });

  const result = await fixture.service.run({ apply: true });

  assert.equal(result.response.appliedActions.length, 0);
  assert.match(result.response.rejectedActions[0].reason, /active lease/i);
  assert.deepEqual(fixture.calls, []);
});

test("applies an idempotent Issue comment once", async () => {
  const fixture = reviewFixture({
    action: {
      version: 1,
      actionId: "comment-1",
      kind: "issue-comment",
      rationale: "Record the current rollout recommendation for the owner.",
      confidence: 0.9,
      evidence: [{ kind: "issue", locator: "item-a" }],
      idempotencyKey: "comment:issue-a:rollout",
      expectedState: { snapshotId: "snapshot-1" },
      target: {
        issueUrl: "https://github.com/example/domain/issues/1",
        body: "Proceed with the rollout checkpoint.",
      },
    },
  });

  const first = await fixture.service.run({ apply: true });
  const second = await fixture.service.run({ apply: true });

  assert.equal(first.response.appliedActions.length, 1);
  assert.match(second.response.appliedActions[0].summary, /already applied/i);
  assert.equal(
    fixture.calls.filter(([kind]) => kind === "comment").length,
    1,
  );
});

test("routes PAN questions through the human-attention lifecycle", async () => {
  const requests = [];
  const fixture = reviewFixture({
    attention: {
      request: async (...args) => {
        requests.push(args);
      },
    },
    action: {
      version: 1,
      actionId: "question-1",
      kind: "needs-human",
      rationale: "The task has two conflicting durable requirements.",
      confidence: 0.9,
      evidence: [{ kind: "issue", locator: "item-a" }],
      idempotencyKey: "question:item-a:requirements",
      expectedState: { snapshotId: "snapshot-1" },
      target: {
        issueUrl: "https://github.com/example/domain/issues/1",
        prompt: "Which requirement is authoritative?",
        kind: "question",
      },
    },
  });

  await fixture.service.run({ apply: true });

  assert.equal(requests.length, 1);
  assert.equal(requests[0][1].prompt, "Which requirement is authoritative?");
  assert.match(requests[0][2].marker, /pan-action:/);
});

test("reuses an Issue created with the same idempotency key", async () => {
  const fixture = reviewFixture({
    action: {
      version: 1,
      actionId: "create-1",
      kind: "issue-create",
      rationale: "Capture the newly discovered commitment as durable work.",
      confidence: 0.9,
      evidence: [{ kind: "workstream", locator: "example" }],
      idempotencyKey: "create:example:commitment",
      expectedState: { snapshotId: "snapshot-1" },
      target: {
        repository: "example/domain",
        title: "Send the promised data",
        body: "Due tomorrow.",
        workstream: "example",
      },
    },
  });

  const first = await fixture.service.run({ apply: true });
  const second = await fixture.service.run({ apply: true });

  assert.match(first.response.appliedActions[0].summary, /Created Issue #3/);
  assert.match(second.response.appliedActions[0].summary, /already created/i);
  assert.equal(
    fixture.calls.filter(([kind]) => kind === "create").length,
    1,
  );
});

test("rejects fabricated evidence locators", async () => {
  const fixture = reviewFixture({
    action: {
      version: 1,
      actionId: "reorder-unsafe",
      kind: "canonical-reorder",
      rationale: "A claimed commitment requires changing the queue order.",
      confidence: 0.9,
      evidence: [{ kind: "issue", locator: "nonexistent-issue" }],
      idempotencyKey: "reorder:unsafe",
      expectedState: { snapshotId: "snapshot-1" },
      target: { orderedItemIds: ["item-b", "item-a"] },
    },
  });

  const result = await fixture.service.run({ apply: true });

  assert.equal(result.response.appliedActions.length, 0);
  assert.match(result.response.rejectedActions[0].reason, /unknown locator/i);
  assert.deepEqual(fixture.calls, []);
});

test("rejects evidence cited as the wrong source kind", async () => {
  const fixture = reviewFixture({
    action: {
      version: 1,
      actionId: "reorder-wrong-kind",
      kind: "canonical-reorder",
      rationale: "A runner record supposedly justifies changing the queue.",
      confidence: 0.9,
      evidence: [{ kind: "issue", locator: "runner-a" }],
      idempotencyKey: "reorder:wrong-kind",
      expectedState: { snapshotId: "snapshot-1" },
      target: { orderedItemIds: ["item-b", "item-a"] },
    },
    mutateSnapshot: (snapshot) => {
      snapshot.runnerAvailability = {
        complete: true,
        runners: [{ id: "runner-a" }],
      };
    },
  });

  const result = await fixture.service.run({ apply: true });

  assert.equal(result.response.appliedActions.length, 0);
  assert.match(result.response.rejectedActions[0].reason, /unknown locator/i);
  assert.deepEqual(fixture.calls, []);
});

test("accepts runner evidence with matching value assertions", async () => {
  const fixture = reviewFixture({
    factCitation: {
      kind: "runner",
      locator:
        "runner-a:online=true,freeCapacity=0,capacityKnown=false,activeLeaseCount=null",
    },
    mutateSnapshot: addUnknownCapacityRunner,
  });

  const result = await fixture.service.run();

  assert.equal(result.response.facts.length, 1);
  assert.deepEqual(fixture.calls, []);
});

test("rejects runner evidence when a value assertion does not match", async () => {
  const fixture = reviewFixture({
    factCitation: {
      kind: "runner",
      locator: "runner-a:online=true,capacityKnown=true",
    },
    mutateSnapshot: addUnknownCapacityRunner,
  });

  await assert.rejects(
    fixture.service.run(),
    /unknown locator .* for runner evidence; cite a snapshot locator or value assertions that match the snapshot/i,
  );
  assert.deepEqual(fixture.calls, []);
});

test("rejects cross-domain Issue creation", async () => {
  const fixture = reviewFixture({
    action: {
      version: 1,
      actionId: "create-foreign",
      kind: "issue-create",
      rationale: "Capture the discovered work as a durable Issue.",
      confidence: 0.9,
      evidence: [{ kind: "workstream", locator: "example" }],
      idempotencyKey: "create:foreign",
      expectedState: { snapshotId: "snapshot-1" },
      target: {
        repository: "other/domain",
        title: "Foreign work",
        body: "Must not be created here.",
        workstream: "example",
      },
    },
  });

  const result = await fixture.service.run({ apply: true });

  assert.equal(result.response.appliedActions.length, 0);
  assert.match(result.response.rejectedActions[0].reason, /outside example\/domain/i);
  assert.deepEqual(fixture.calls, []);
});

test("does not resurrect a closed inferred Issue", async () => {
  const fixture = reviewFixture({
    action: {
      version: 1,
      actionId: "create-closed",
      kind: "issue-create",
      rationale: "Capture the newly discovered commitment as durable work.",
      confidence: 0.9,
      evidence: [{ kind: "workstream", locator: "example" }],
      idempotencyKey: "create:closed",
      expectedState: { snapshotId: "snapshot-1" },
      target: {
        repository: "example/domain",
        title: "Previously rejected work",
        body: "Do not resurrect.",
        workstream: "example",
      },
    },
    existingIssue: {
      number: 9,
      title: "Previously rejected work",
      body: "closed",
      url: "https://github.com/example/domain/issues/9",
      state: "closed",
    },
  });

  const result = await fixture.service.run({ apply: true });

  assert.match(result.response.appliedActions[0].summary, /previously closed/i);
  assert.deepEqual(fixture.calls, []);
});

test("reports a possible partial effect when leadership is lost", async () => {
  const controller = new AbortController();
  const fixture = reviewFixture({
    afterReorder: () =>
      controller.abort(new Error("PAN leader lease lost: replaced")),
  });

  await assert.rejects(
    fixture.service.run({ apply: true, signal: controller.signal }),
    (error) =>
      /leader lease lost/i.test(error.message) &&
      error.result.response.effects.incomplete.length === 1 &&
      /partial effect/i.test(
        error.result.response.effects.incomplete[0].summary,
      ),
  );
});

function reviewFixture({
  action,
  attention,
  afterReorder,
  existingIssue,
  factCitation,
  failReorder = false,
  mutateCurrent,
  mutateSnapshot,
} = {}) {
  const calls = [];
  const order = ["item-a", "item-b"];
  const items = [
    item("item-a", "A"),
    item("item-b", "B"),
  ];
  const snapshot = {
    id: "snapshot-1",
    capturedAt: "2026-07-20T20:00:00.000Z",
    complete: true,
    usableForMutation: true,
    project: { id: "project-1", items: [...order] },
    dossiers: items.map((entry) => ({
      item: entry,
      lease: { active: false },
    })),
    diagnostics: [],
  };
  mutateSnapshot?.(snapshot);
  let lastTurn;
  const comments = [];
  let createdIssue;
  const response = {
    version: 1,
    type: "final-response",
    turnId: "placeholder",
    mode: "autonomous-review",
    timestamp: "2026-07-20T20:00:00.000Z",
    snapshotId: snapshot.id,
    recommendation: "Do B before A.",
    facts: [
      {
        statement: "B is due first.",
        citations: [factCitation ?? { kind: "issue", locator: "item-b" }],
      },
    ],
    interpretations: [],
    assumptions: [],
    uncertainties: [],
    citations: [],
    proposedActions: [
      action ?? {
        version: 1,
        actionId: "reorder-1",
        kind: "canonical-reorder",
        rationale: "B has the earlier durable commitment.",
        confidence: 0.9,
        evidence: [{ kind: "issue", locator: "item-b" }],
        idempotencyKey: "reorder:snapshot-1",
        expectedState: { snapshotId: snapshot.id },
        target: { orderedItemIds: ["item-b", "item-a"] },
      },
    ],
    appliedActions: [],
    rejectedActions: [],
    effects: { confirmed: [], incomplete: [] },
  };
  const runAgent = async (turn) => {
    lastTurn = turn;
    return {
      sessionId: "session-1",
      response: {
        ...response,
        turnId: turn.turnId,
        mode: turn.mode,
        timestamp: turn.timestamp,
      },
    };
  };
  const store = {
    repository: "example/domain",
    readCanonicalProject: async () => {
      const currentItems = structuredClone(
        order.map((id) => items.find((entry) => entry.id === id)),
      );
      mutateCurrent?.(currentItems);
      return {
        id: "project-1",
        complete: true,
        items: currentItems,
      };
    },
    reorderItems: async (next) => {
      calls.push(["reorder", [...next]]);
      if (failReorder) {
        throw new Error("GraphQL position update failed");
      }
      order.splice(0, order.length, ...next);
      afterReorder?.();
    },
    setFields: async () => {},
    createItem: async (input) => {
      calls.push(["create", input]);
      createdIssue = {
        id: "item-created",
        number: 3,
        title: input.title,
        body: input.body,
        url: "https://github.com/example/domain/issues/3",
        repository: "example/domain",
        state: "open",
        fields: structuredClone(input.fields),
      };
      items.push(createdIssue);
      order.push(createdIssue.id);
      return createdIssue;
    },
    addIssueToProject: async (url, fields) => {
      calls.push(["recover", url]);
      const recovered = {
        ...createdIssue,
        id: "item-created",
        fields: structuredClone(fields),
      };
      items.push(recovered);
      order.push(recovered.id);
      return recovered;
    },
    findIssueByMarker: async (marker) =>
      existingIssue ??
      (createdIssue?.body.includes(marker) ? createdIssue : undefined),
    addComment: async (entry, body) => {
      calls.push(["comment", entry.number, body]);
      comments.push({ body });
    },
    listComments: async () => comments,
  };
  return {
    calls,
    order,
    get lastTurn() {
      return lastTurn;
    },
    service: new PanReviewService({
      snapshotSource: {
        build: async () => ({
          ...snapshot,
          project: { ...snapshot.project, items: [...order] },
          dossiers: items.map((entry) => ({
            item: structuredClone(entry),
            lease: { active: false },
            workstream: {
              path: entry.fields.workstream,
              available: true,
              history: [],
            },
          })),
        }),
      },
      agentClient: { review: runAgent, chat: runAgent },
      store,
      attention,
      now: () => new Date("2026-07-20T20:00:00.000Z"),
    }),
  };
}

function addUnknownCapacityRunner(snapshot) {
  snapshot.runnerAvailability = {
    complete: true,
    runners: [
      {
        id: "runner-a",
        online: true,
        capabilities: ["coding"],
        maximumCapacity: 1,
        activeLeaseCount: null,
        freeCapacity: 0,
        capacityKnown: false,
      },
    ],
  };
}

function item(id, title) {
  const number = id === "item-a" ? 1 : 2;
  return {
    id,
    number,
    title,
    url: `https://github.com/example/domain/issues/${number}`,
    repository: "example/domain",
    state: "open",
    fields: {
      status: "ready",
      owner: "human",
      priority: "normal",
      workstream: "example",
    },
  };
}
