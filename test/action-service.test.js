import assert from "node:assert/strict";
import test from "node:test";

import {
  ActionPolicy,
  ActionService,
  createActionCommandHandlers,
  runPanCli,
} from "../src/index.js";

test("validation is read-only and rejects stale expected state", async () => {
  const fixture = actionFixture();
  const action = fieldAction();

  const result = await fixture.service.validate(action, {
    identity: leadershipIdentity(),
  });

  assert.equal(result.receipts[0].status, "accepted");
  assert.deepEqual(fixture.writes, []);

  const stale = fieldAction({
    expectedState: {
      ...fieldAction().expectedState,
      projectField: {
        ...fieldAction().expectedState.projectField,
        value: "urgent",
      },
    },
  });
  const rejected = await fixture.service.validate(stale, {
    identity: leadershipIdentity(),
  });
  assert.equal(rejected.receipts[0].status, "rejected");
  assert.match(rejected.receipts[0].reasons.join(" "), /field state/i);
});

test("apply confirms leadership and the Project field before and after writing", async () => {
  const fixture = actionFixture();

  const result = await fixture.service.apply(fieldAction(), {
    identity: leadershipIdentity(),
  });

  assert.equal(result.effects.length, 1);
  assert.equal(result.incompleteEffects.length, 0);
  assert.deepEqual(fixture.item.fields.priority, "high");
  assert.equal(fixture.assertions, 2);
  assert.deepEqual(fixture.writes, [["field", "priority", "high"]]);
});

test("leadership loss immediately before a write leaves no later write", async () => {
  const fixture = actionFixture({
    assertLeadership: () => ({ asserted: false, reason: "leadership replaced" }),
  });

  const result = await fixture.service.apply(fieldAction(), {
    identity: leadershipIdentity(),
  });

  assert.equal(result.effects.length, 0);
  assert.equal(result.incompleteEffects.length, 1);
  assert.match(result.incompleteEffects[0].recovery[0], /leadership replaced/i);
  assert.deepEqual(fixture.writes, []);
});

test("policy preserves durable human precedence and distinguishes approvals", async () => {
  const fixture = actionFixture({
    humanPrecedence: [{ beforeItemId: "item-a", afterItemId: "item-b" }],
    policy: new ActionPolicy({ approvalRequired: ["canonical-reorder"] }),
  });
  const action = reorderAction(["item-b", "item-a"]);

  const result = await fixture.service.validate(action, {
    identity: leadershipIdentity(),
  });

  assert.equal(result.receipts[0].status, "rejected");
  assert.match(result.receipts[0].reasons.join(" "), /human precedence/i);
  assert.match(result.receipts[0].reasons.join(" "), /approval/i);
  assert.deepEqual(fixture.writes, []);
});

test("action CLI dispatches stateless validation and requires an action file", async () => {
  const output = [];
  const handlers = createActionCommandHandlers({
    portfolioBuilderFactory: () => ({ build: async () => assert.fail("must not build") }),
    readAction: async (file) => {
      assert.equal(file, "action.json");
      return {};
    },
    actionServiceFactory: () => ({
      validate: async () => ({
        snapshot: { id: "snapshot-1" },
        receipts: [{ actionId: "action-1", status: "accepted" }],
        rejected: [],
      }),
    }),
  });

  const result = await runPanCli(
    [
      "action",
      "validate",
      "--schema-version",
      "1",
      "--config",
      "domain.json",
      "--action-file",
      "action.json",
      "--json",
    ],
    {
      commandHandlers: { action: handlers },
      commandContextFactory: async () => commandContext(),
      stdout: { write: (value) => output.push(value) },
    },
  );

  assert.equal(result.status, "confirmed");
  assert.equal(JSON.parse(output[0]).operation, "action.validate");
  await assert.rejects(
    runPanCli(
      ["action", "validate", "--schema-version", "1", "--config", "domain.json"],
      { commandHandlers: { action: handlers } },
    ),
    /requires --action-file/,
  );
});

test("routes sourced Issue creation through the recovery service", async () => {
  const calls = [];
  const fixture = actionFixture({
    issueCreationService: {
      create: async (input, { identity }) => {
        calls.push([input.actionId, identity.generation]);
        return {
          resource: "issue",
          externalIdentity: "https://github.com/example/domain/issues/3",
          confirmedState: { number: 3, status: "registered" },
          recovery: [],
        };
      },
    },
  });
  const result = await fixture.service.apply(issueCreateAction(), {
    identity: leadershipIdentity(),
  });

  assert.deepEqual(calls, [["create-1", "generation-a"]]);
  assert.equal(result.effects[0].externalIdentity, "https://github.com/example/domain/issues/3");
  assert.equal(result.effects[0].confirmedState.status, "registered");
});

test("routes a prepared workstream action through direct publication", async () => {
  const calls = [];
  const fixture = actionFixture({
    workstream: {
      path: "existing",
      revision: "blob-1",
      history: [{ sha: "base-1" }],
    },
    policy: new ActionPolicy({ automatic: ["workstream-update"] }),
    workstreamDeliveryService: {
      publish: async (input) => {
        calls.push(input);
        return {
          status: "confirmed",
          pushConfirmed: { sha: "commit-1", branch: "main" },
        };
      },
    },
  });

  const result = await fixture.service.apply(workstreamAction(), {
    identity: leadershipIdentity(),
  });

  assert.deepEqual(calls, [{
    operationId: "operation-1",
    sessionId: "session-a",
    workstreamPath: "existing",
  }]);
  assert.equal(result.effects[0].resource, "workstream");
  assert.equal(result.effects[0].confirmedState.commit, "commit-1");
});

function actionFixture({
  assertLeadership = () => ({ asserted: true }),
  humanPrecedence,
  issueCreationService,
  workstream,
  workstreamDeliveryService,
  policy = new ActionPolicy({ automatic: ["field-update", "canonical-reorder"] }),
} = {}) {
  const writes = [];
  const item = {
    id: "item-a",
    number: 1,
    url: "https://github.com/example/domain/issues/1",
    state: "open",
    updatedAt: "issue-revision",
    fields: { status: "ready", priority: "normal" },
  };
  const itemB = {
    id: "item-b",
    number: 2,
    url: "https://github.com/example/domain/issues/2",
    state: "open",
    updatedAt: "issue-revision-b",
    fields: { status: "ready", priority: "normal" },
  };
  const order = ["item-a", "item-b"];
  let assertions = 0;
  const snapshot = () => ({
    id: "snapshot-1",
    complete: true,
    usableForMutation: true,
    diagnostics: [],
    project: { items: [...order] },
    dossiers: [item, itemB].map((entry) => ({
      item: structuredClone(entry),
      lease: { active: false },
      ...(workstream && entry.id === "item-a" ? { workstream } : {}),
    })),
    ...(humanPrecedence ? { humanPrecedence } : {}),
    expectedState: {
      projectFields: "fields-1",
      projectOrder: "order-1",
      issueCatalog: "catalog-1",
    },
  });
  const store = {
    repository: "example/domain",
    projectOwner: "example",
    projectNumber: 12,
    readCanonicalProject: async () => ({
      id: "project-1",
      complete: true,
      items: order.map((id) => structuredClone(id === "item-a" ? item : itemB)),
    }),
    setFields: async (itemId, fields, { beforeWrite } = {}) => {
      await beforeWrite?.();
      writes.push(["field", ...Object.entries(fields).flat()]);
      Object.assign(itemId === "item-a" ? item.fields : itemB.fields, fields);
    },
    reorderItems: async (next, { beforeWrite } = {}) => {
      for (const id of next) {
        await beforeWrite?.();
        writes.push(["reorder", id]);
      }
      order.splice(0, order.length, ...next);
    },
  };
  return {
    item,
    writes,
    get assertions() {
      return assertions;
    },
    service: new ActionService({
      snapshotSource: { build: async () => snapshot() },
      store,
      actionPolicy: policy,
      issueCreationService,
      workstreamDeliveryService,
      assertLeadership: async () => {
        assertions += 1;
        return assertLeadership();
      },
    }),
  };
}

function issueCreateAction() {
  return {
    version: 2,
    actionId: "create-1",
    kind: "issue-create",
    domain: domain(),
    rationale: "A dated workstream commitment needs a durable delivery Issue.",
    confidence: 0.9,
    evidence: [{ kind: "workstream", locator: "example:revision-1" }],
    idempotencyKey: "create-1",
    expectedState: {
      issueCatalog: { revision: "catalog-1" },
      leadership: { generation: "generation-a" },
    },
    target: {
      repository: "example/domain",
      title: "Deliver the committed work",
      body: "Source revision: revision-1.",
      workstream: "example",
    },
  };
}

function fieldAction({ expectedState } = {}) {
  return {
    version: 2,
    actionId: "field-1",
    kind: "field-update",
    domain: domain(),
    rationale: "The complete portfolio shows this task needs immediate priority.",
    confidence: 0.9,
    evidence: [{ kind: "project-field", locator: "item-a:priority" }],
    idempotencyKey: "field-1",
    expectedState: expectedState ?? {
      projectField: {
        itemId: "item-a",
        field: "priority",
        value: "normal",
        revision: "fields-1",
      },
      leadership: { generation: "generation-a" },
    },
    target: { itemId: "item-a", field: "priority", value: "high" },
  };
}

function workstreamAction() {
  return {
    version: 2,
    actionId: "workstream-1",
    kind: "workstream-update",
    domain: domain(),
    rationale: "Publish the reviewed workstream update directly to the domain default branch.",
    confidence: 0.9,
    evidence: [{ kind: "workstream", locator: "existing:blob-1" }],
    idempotencyKey: "workstream-1",
    expectedState: {
      workstream: {
        path: "existing",
        blobRevision: "blob-1",
        baseRevision: "base-1",
      },
      leadership: { generation: "generation-a" },
    },
    target: {
      preparedOperationId: "operation-1",
      workstreamPath: "existing",
    },
  };
}

function reorderAction(orderedItemIds) {
  return {
    version: 2,
    actionId: "order-1",
    kind: "canonical-reorder",
    domain: domain(),
    rationale: "The complete portfolio evidence establishes the required sequence.",
    confidence: 0.9,
    evidence: [{ kind: "project-field", locator: "item-a:priority" }],
    idempotencyKey: "order-1",
    expectedState: {
      projectOrder: { itemIds: ["item-a", "item-b"], revision: "order-1" },
      leadership: { generation: "generation-a" },
    },
    target: { orderedItemIds },
  };
}

function leadershipIdentity() {
  return { sessionId: "session-a", holder: "session-a", generation: "generation-a" };
}

function domain() {
  return { repository: "example/domain", projectOwner: "example", projectNumber: 12 };
}

function commandContext() {
  return {
    domain: { ...domain(), path: "C:\\domains\\example" },
    config: {
      state: { branch: "pan-state", leaderPath: ".pan/leader.json" },
      leadership: { leaseSeconds: 120 },
      attention: {},
      policy: { automatic: ["no-op"], approvalRequired: [], prohibited: [] },
    },
    store: {
      repository: "example/domain",
      projectOwner: "example",
      projectNumber: 12,
    },
    gh: {},
  };
}
