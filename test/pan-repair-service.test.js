import assert from "node:assert/strict";
import test from "node:test";

import { PanRepairService } from "../src/index.js";

const POLICY = {
  enabled: true,
  repository: "example/pan",
  workstream: "pan",
  requirements: ["env:local", "tool:node22", "task:self-repair"],
};

test("queues a ready pull-request repair task with failure evidence", async () => {
  const calls = [];
  const service = new PanRepairService({
    policy: POLICY,
    now: () => new Date("2026-07-21T20:43:34.681Z"),
    store: {
      findIssueByMarker: async (marker, options) => {
        calls.push(["find", marker, options]);
        return undefined;
      },
      createItem: async (input, options) => {
        calls.push(["create", input, options]);
        return {
          number: 12,
          url: "https://github.com/example/domain/issues/12",
        };
      },
      readCanonicalProject: async () => assert.fail("not called"),
      addIssueToProject: async () => assert.fail("not called"),
      setFields: async () => assert.fail("not called"),
    },
  });
  const error = new Error(
    "PAN cannot reason from an incomplete portfolio: item has no workstream reference",
  );

  const result = await service.reportFailure(error, {
    source: "scheduled-review",
    model: "gpt-5.6-sol",
  });

  assert.deepEqual(result, {
    created: true,
    fingerprint: result.fingerprint,
    issueNumber: 12,
    issueUrl: "https://github.com/example/domain/issues/12",
  });
  assert.match(result.fingerprint, /^[a-f0-9]{20}$/);
  assert.equal(calls[0][0], "find");
  assert.equal(calls[0][2].state, "open");
  const task = calls[1][1];
  assert.match(task.title, /^Investigate PAN host failure:/);
  assert.match(task.body, /Preserve PAN's fail-closed mutation behavior/);
  assert.match(task.body, /gpt-5\.6-sol/);
  assert.match(task.body, new RegExp(`pan:self-repair:${result.fingerprint}`));
  assert.deepEqual(task.fields, {
    owner: "agent",
    status: "ready",
    priority: "high",
    autonomy: "full-auto",
    requirements: [
      "repo:example/pan",
      "delivery:pull-request",
      "env:local",
      "tool:node22",
      "task:self-repair",
    ],
    workstream: "pan",
  });
});

test("reuses an open repair task with the same failure fingerprint", async () => {
  let created = false;
  const service = new PanRepairService({
    policy: POLICY,
    store: {
      findIssueByMarker: async () => ({
        number: 7,
        url: "https://github.com/example/domain/issues/7",
      }),
      createItem: async () => {
        created = true;
      },
      readCanonicalProject: async () => ({
        items: [
          {
            id: "item-7",
            url: "https://github.com/example/domain/issues/7",
            requirements: [],
            fields: { status: "in-review" },
          },
        ],
      }),
      addIssueToProject: async () => assert.fail("not called"),
      setFields: async () => assert.fail("not called"),
    },
  });

  const result = await service.reportFailure(new Error("same failure"));

  assert.equal(result.created, false);
  assert.equal(result.issueNumber, 7);
  assert.equal(created, false);
});

test("includes structured mutation evidence in the repair fingerprint", async () => {
  const markers = [];
  const bodies = [];
  const service = new PanRepairService({
    policy: POLICY,
    store: {
      findIssueByMarker: async (marker) => {
        markers.push(marker);
        return undefined;
      },
      createItem: async ({ body }) => {
        bodies.push(body);
        return {
          number: bodies.length,
          url: `https://github.com/example/domain/issues/${bodies.length}`,
        };
      },
      readCanonicalProject: async () => assert.fail("not called"),
      addIssueToProject: async () => assert.fail("not called"),
      setFields: async () => assert.fail("not called"),
    },
  });
  const first = new Error("PAN scheduled review produced an incomplete mutation");
  first.result = {
    response: {
      effects: { incomplete: [{ actionId: "action-1", summary: "First" }] },
    },
  };
  const second = new Error("PAN scheduled review produced an incomplete mutation");
  second.result = {
    response: {
      effects: { incomplete: [{ actionId: "action-2", summary: "Second" }] },
    },
  };

  await service.reportFailure(first);
  await service.reportFailure(second);

  assert.notEqual(markers[0], markers[1]);
  assert.match(bodies[0], /"actionId":"action-1"/);
  assert.match(bodies[1], /"actionId":"action-2"/);
});

test("ignores volatile action IDs when deduplicating the same mutation failure", async () => {
  const markers = [];
  const service = new PanRepairService({
    policy: POLICY,
    store: {
      findIssueByMarker: async (marker) => {
        markers.push(marker);
        return undefined;
      },
      createItem: async () => ({
        number: markers.length,
        url: `https://github.com/example/domain/issues/${markers.length}`,
      }),
      readCanonicalProject: async () => assert.fail("not called"),
      addIssueToProject: async () => assert.fail("not called"),
      setFields: async () => assert.fail("not called"),
    },
  });
  const first = new Error("PAN scheduled review produced an incomplete mutation");
  first.result = {
    sessionId: "session-1",
    response: {
      effects: {
        incomplete: [{ actionId: "action-1", summary: "Same failure" }],
      },
    },
  };
  const second = new Error("PAN scheduled review produced an incomplete mutation");
  second.result = {
    sessionId: "session-2",
    response: {
      effects: {
        incomplete: [{ actionId: "action-2", summary: "Same failure" }],
      },
    },
  };

  await service.reportFailure(first);
  await service.reportFailure(second);

  assert.equal(markers[0], markers[1]);
});

test("recovers an orphaned open repair Issue into the Project", async () => {
  let recovered;
  const service = new PanRepairService({
    policy: POLICY,
    store: {
      findIssueByMarker: async () => ({
        number: 7,
        url: "https://github.com/example/domain/issues/7",
      }),
      createItem: async () => assert.fail("not called"),
      readCanonicalProject: async () => ({ items: [] }),
      addIssueToProject: async (url, fields) => {
        recovered = { url, fields };
      },
      setFields: async () => assert.fail("not called"),
    },
  });

  const result = await service.reportFailure(new Error("same failure"));

  assert.equal(result.created, false);
  assert.equal(recovered.url, result.issueUrl);
  assert.equal(recovered.fields.status, "ready");
  assert.ok(recovered.fields.requirements.includes("delivery:pull-request"));
});

test("requires an explicit enabled repair policy", () => {
  assert.throws(
    () =>
      new PanRepairService({
        policy: { enabled: false },
        store: {
          findIssueByMarker() {},
          createItem() {},
          readCanonicalProject() {},
          addIssueToProject() {},
          setFields() {},
        },
      }),
    /enabled self-repair policy/,
  );
});
