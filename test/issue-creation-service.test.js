import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { IssueCreationService } from "../src/index.js";

test("creates one sourced Issue then registers and initializes it", async () => {
  const fixture = creationFixture();

  const result = await fixture.service.create(action(), { identity: identity() });

  assert.equal(result.confirmedState.status, "registered");
  assert.equal(fixture.created.length, 1);
  assert.deepEqual(fixture.memberships, ["https://github.com/example/domain/issues/3"]);
  assert.deepEqual(fixture.fieldWrites[0].values, {
    owner: "unassigned",
    status: "untriaged",
    priority: "normal",
    autonomy: "manual",
    requirements: [],
    workstream: "example",
  });
});

test("finds an existing marker and retries Project registration without recreating", async () => {
  const fixture = creationFixture({
    issues: [issue({ body: `${marker(action().idempotencyKey)}`, state: "open" })],
    failMembership: true,
  });

  const interrupted = await fixture.service.create(action(), { identity: identity() });
  assert.equal(interrupted.confirmedState.status, "incomplete");
  assert.equal(interrupted.externalIdentity, "https://github.com/example/domain/issues/3");
  assert.equal(fixture.created.length, 0);

  fixture.failMembership = false;
  const retry = await fixture.service.create(action(), { identity: identity() });
  assert.equal(retry.confirmedState.status, "registered");
  assert.equal(fixture.created.length, 0);
  assert.equal(fixture.memberships.length, 2);
});

test("suppresses a closed or rejected sourced Issue instead of reopening it", async () => {
  const fixture = creationFixture({
    issues: [issue({ state: "closed", body: marker(action().idempotencyKey) })],
  });

  const result = await fixture.service.create(action(), { identity: identity() });

  assert.equal(result.confirmedState.status, "suppressed");
  assert.equal(fixture.created.length, 0);
  assert.deepEqual(fixture.memberships, []);
});

test("fails closed when Issue evidence is incomplete", async () => {
  const fixture = creationFixture({ complete: false });

  await assert.rejects(
    fixture.service.create(action(), { identity: identity() }),
    /complete open and closed issue evidence/i,
  );
  assert.equal(fixture.created.length, 0);
});

test("rejects ambiguous sourced work before it has side effects", async () => {
  const fixture = creationFixture();

  await assert.rejects(
    fixture.service.create(action({ confidence: 0.5 }), { identity: identity() }),
    /ambiguous or low-confidence/i,
  );
  assert.equal(fixture.catalogReads, 0);
  assert.equal(fixture.created.length, 0);
});

test("preserves the confirmed Issue when leadership is lost before registration", async () => {
  let assertions = 0;
  const fixture = creationFixture({
    assertLeadership: () => {
      assertions += 1;
      return assertions === 1
        ? { asserted: true }
        : { asserted: false, reason: "leader replaced" };
    },
  });

  const result = await fixture.service.create(action(), { identity: identity() });

  assert.equal(result.confirmedState.status, "incomplete");
  assert.equal(result.confirmedState.number, 3);
  assert.match(result.recovery[0], /leader replaced/i);
  assert.equal(fixture.created.length, 1);
  assert.deepEqual(fixture.memberships, []);
});

test("returns the confirmed Issue and remaining fields after partial initialization", async () => {
  const fixture = creationFixture({ incompleteFields: true });

  const result = await fixture.service.create(action(), { identity: identity() });

  assert.equal(result.confirmedState.status, "incomplete");
  assert.equal(result.confirmedState.projectRegistered, true);
  assert.deepEqual(result.remainingSteps, [
    "Initialize remaining Project fields: workstream.",
  ]);
  assert.equal(fixture.created.length, 1);
});

function creationFixture({
  issues = [],
  complete = true,
  failMembership = false,
  incompleteFields = false,
  assertLeadership = () => ({ asserted: true }),
} = {}) {
  const created = [];
  const memberships = [];
  const fieldWrites = [];
  const fixture = {
    created,
    memberships,
    fieldWrites,
    catalogReads: 0,
    failMembership,
  };
  const store = {
    readIssueCatalog: async () => {
      fixture.catalogReads += 1;
      return { id: "catalog-1", complete, issues };
    },
    createIssue: async (input) => {
      created.push(input);
      return issue({ body: input.body, title: input.title });
    },
    ensureIssueProjectMembership: async (url) => {
      memberships.push(url);
      if (fixture.failMembership) {
        throw new Error("Project unavailable");
      }
      return { item: { id: "project-item-3" }, added: true };
    },
    ensureItemFields: async (itemId, values) => {
      fieldWrites.push({ itemId, values });
      return {
        item: { id: itemId },
        complete: !incompleteFields,
        confirmedFields: incompleteFields ? ["owner"] : Object.keys(values),
        remainingFields: incompleteFields ? ["workstream"] : [],
        ...(incompleteFields ? { error: "workstream field was not confirmed" } : {}),
      };
    },
  };
  fixture.service = new IssueCreationService({ store, assertLeadership });
  return fixture;
}

function action({ confidence = 0.9 } = {}) {
  return {
    actionId: "create-1",
    idempotencyKey: "source:example:revision-1",
    confidence,
    rationale: "The dated workstream commitment requires a tracked delivery task.",
    evidence: [{ kind: "workstream", locator: "example:revision-1" }],
    expectedState: { issueCatalog: { revision: "catalog-1" } },
    target: {
      title: "Deliver the committed work",
      body: "Source revision: revision-1.",
      workstream: "example",
    },
  };
}

function issue({
  number = 3,
  title = "Deliver the committed work",
  body = "",
  state = "open",
} = {}) {
  return {
    number,
    title,
    body,
    state,
    url: `https://github.com/example/domain/issues/${number}`,
  };
}

function identity() {
  return { generation: "generation-1" };
}

function marker(key) {
  return `<!-- pan-action:${createHash("sha256").update(key).digest("hex")} -->`;
}
