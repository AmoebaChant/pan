import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  isHostlessLiveAction,
  normalizePanFinalResponse,
  PAN_ACTION_VERSION,
  PAN_PROTOCOL_VERSION,
  validatePanAction,
  validatePanActionGroup,
  validatePanFinalResponse,
  validatePanToolMessage,
  validatePanTurnRequest,
} from "../src/index.js";

const citation = {
  kind: "issue",
  locator: "https://github.com/example/domain/issues/42",
  revision: "comment-7",
};

function mutation(
  kind,
  target,
  expectedState = {
    snapshotId: "snapshot-sha256",
    revision: "before-1",
  },
) {
  return {
    version: 1,
    actionId: `action-${kind}`,
    kind,
    evidence: [citation],
    rationale: `Apply ${kind} based on the cited domain state.`,
    confidence: 0.9,
    idempotencyKey: `turn-1:${kind}`,
    expectedState,
    target,
  };
}

const actions = [
  mutation("field-update", {
    itemId: "PVTI_1",
    field: "priority",
    value: "high",
  }),
  mutation("canonical-reorder", {
    orderedItemIds: ["PVTI_1", "PVTI_2"],
  }),
  mutation("relative-precedence", {
    beforeItemId: "PVTI_1",
    afterItemId: "PVTI_2",
  }),
  mutation("issue-create", {
    repository: "example/domain",
    title: "Follow up on the commitment",
    body: "Acceptance criteria",
    workstream: "planning/example",
  }),
  mutation("issue-comment", {
    issueUrl: "https://github.com/example/domain/issues/42",
    body: "PAN review note",
  }),
  mutation("needs-human", {
    issueUrl: "https://github.com/example/domain/issues/42",
    prompt: "Which deadline is authoritative?",
    kind: "question",
  }),
  {
    version: 1,
    actionId: "action-no-op",
    kind: "no-op",
    evidence: [citation],
    rationale: "The current ordering already reflects the evidence.",
    confidence: 0.95,
    recommendation: "Keep the current portfolio order.",
  },
];

test("validates every planned PAN action kind", () => {
  assert.equal(PAN_PROTOCOL_VERSION, 1);
  for (const action of actions) {
    assert.deepEqual(validatePanAction(action), action);
  }
});

test("validates resource-specific version 2 action state", () => {
  assert.equal(PAN_ACTION_VERSION, 2);
  const versionTwoActions = [
    v2Mutation("field-update", {
      itemId: "PVTI_1",
      field: "priority",
      value: "high",
    }, {
      projectField: {
        itemId: "PVTI_1",
        field: "priority",
        value: "normal",
        revision: "sha256:fields",
      },
      leadership: { generation: "leader-1" },
    }),
    v2Mutation("canonical-reorder", {
      orderedItemIds: ["PVTI_2", "PVTI_1"],
    }, {
      projectOrder: {
        itemIds: ["PVTI_1", "PVTI_2"],
        revision: "sha256:order",
      },
      leadership: { generation: "leader-1" },
    }),
    v2Mutation("relative-precedence", {
      beforeItemId: "PVTI_1",
      afterItemId: "PVTI_2",
    }, {
      projectOrder: {
        itemIds: ["PVTI_1", "PVTI_2"],
        revision: "sha256:order",
      },
      leadership: { generation: "leader-1" },
    }),
    v2Mutation("issue-create", {
      repository: "example/domain",
      title: "Follow up",
    }, {
      issueCatalog: { revision: "sha256:catalog" },
      leadership: { generation: "leader-1" },
    }),
    v2Mutation("issue-comment", {
      issueUrl: "https://github.com/example/domain/issues/42",
      body: "A durable comment.",
    }, {
      issueCatalog: { revision: "sha256:catalog" },
      issue: {
        url: "https://github.com/example/domain/issues/42",
        state: "open",
        revision: "issue-42:7",
      },
      leadership: { generation: "leader-1" },
    }),
    v2Mutation("needs-human", {
      issueUrl: "https://github.com/example/domain/issues/42",
      prompt: "Which deadline is authoritative?",
      kind: "question",
    }, {
      issue: {
        url: "https://github.com/example/domain/issues/42",
        state: "open",
        revision: "issue-42:7",
      },
      attention: { recordId: "attention-42", revision: "attention:5" },
      leadership: { generation: "leader-1" },
    }),
    v2Mutation("workstream-update", {
      preparedOperationId: "prepare-42",
      workstreamPath: "planning/example",
    }, {
      workstream: {
        path: "planning/example",
        blobRevision: "sha256:blob",
        baseRevision: "main:123",
      },
      leadership: { generation: "leader-1" },
    }),
  ];

  for (const action of versionTwoActions) {
    assert.deepEqual(validatePanAction(action), action);
    assert.equal(isHostlessLiveAction(action), true);
  }
  assert.equal(isHostlessLiveAction(actions[0]), false);
});

test("validates autonomous and interactive turn requests", () => {
  const base = {
    version: 1,
    type: "request",
    turnId: "turn-1",
    timestamp: "2026-07-20T21:00:00.000Z",
    snapshot: {
      id: "snapshot-sha256",
      capturedAt: "2026-07-20T20:59:59.000Z",
      complete: true,
    },
    toolChannel: {
      transport: "mcp-stdio",
      server: "pan-tools",
      allowedOperations: ["read_portfolio", "propose_actions"],
    },
  };

  assert.equal(
    validatePanTurnRequest({
      ...base,
      mode: "autonomous-review",
    }).snapshot.id,
    "snapshot-sha256",
  );
  assert.equal(
    validatePanTurnRequest({
      ...base,
      mode: "interactive-chat",
      userInput: "Why is item 42 first?",
    }).userInput,
    "Why is item 42 first?",
  );
  assert.throws(
    () =>
      validatePanTurnRequest({
        ...base,
        mode: "interactive-chat",
      }),
    /turn\.userInput must be a non-empty string; correct the protocol record/,
  );
});

test("rejects unknown versions, action kinds, and malformed citations", () => {
  assert.throws(
    () => validatePanAction({ ...actions[0], version: 3 }),
    /action\.version must be supported version 1 or 2/,
  );
  assert.throws(
    () => validatePanAction({ ...actions[0], kind: "run-shell" }),
    /action\.kind must be one of/,
  );
  assert.throws(
    () =>
      validatePanAction({
        ...actions[0],
        evidence: [{ kind: "issue", locator: "" }],
      }),
    /action\.evidence\[0\]\.locator must be a non-empty string/,
  );
});

test("rejects global snapshots, unrelated resources, and mismatched version 2 state", () => {
  const action = v2Mutation("field-update", {
    itemId: "PVTI_1",
    field: "priority",
    value: "high",
  }, {
    projectField: {
      itemId: "PVTI_1",
      field: "priority",
      value: "normal",
      revision: "sha256:fields",
    },
    leadership: { generation: "leader-1" },
  });

  assert.throws(
    () =>
      validatePanAction({
        ...action,
        expectedState: { snapshotId: "stale-global-snapshot" },
      }),
    /expectedState\.snapshotId is not supported/,
  );
  assert.throws(
    () =>
      validatePanAction({
        ...action,
        expectedState: {
          ...action.expectedState,
          issueCatalog: { revision: "sha256:catalog" },
        },
      }),
    /must only describe resources used by field-update/,
  );
  assert.throws(
    () =>
      validatePanAction({
        ...action,
        expectedState: {
          ...action.expectedState,
          projectField: {
            ...action.expectedState.projectField,
            field: "owner",
          },
        },
      }),
    /must identify the same item and field as the target/,
  );
  assert.throws(
    () => validatePanAction({ ...action, surprise: true }),
    /action\.surprise is not supported/,
  );
});

test("accepts independent groups and rejects unsupported atomic groups", () => {
  const action = v2Mutation("issue-create", {
    repository: "example/domain",
    title: "Follow up",
  }, {
    issueCatalog: { revision: "sha256:catalog" },
    leadership: { generation: "leader-1" },
  });
  const group = {
    version: 2,
    groupId: "group-1",
    semantics: "independent",
    actions: [action],
  };
  assert.deepEqual(validatePanActionGroup(group), group);
  assert.throws(
    () => validatePanActionGroup({ ...group, semantics: "all-or-none" }),
    /all-or-none groups are not supported/,
  );
});

test("rejects mutations without concurrency and idempotency records", () => {
  const withoutExpectedState = { ...actions[0] };
  delete withoutExpectedState.expectedState;
  assert.throws(
    () => validatePanAction(withoutExpectedState),
    /action\.expectedState must be an object/,
  );

  assert.throws(
    () =>
      validatePanAction({
        ...actions[0],
        expectedState: { priority: "normal" },
      }),
    /action\.expectedState\.snapshotId must be a non-empty string/,
  );

  const withoutIdempotencyKey = { ...actions[0] };
  delete withoutIdempotencyKey.idempotencyKey;
  assert.throws(
    () => validatePanAction(withoutIdempotencyKey),
    /action\.idempotencyKey must be a non-empty string/,
  );
});

test("normalizes and validates final responses with partial effects", () => {
  const response = normalizePanFinalResponse({
    version: 1,
    type: "final-response",
    turnId: "turn-1",
    mode: "autonomous-review",
    timestamp: "2026-07-20T21:05:00.000Z",
    snapshotId: "snapshot-sha256",
    recommendation: "Keep item 42 first and repair its missing Project field.",
    facts: [
      {
        statement: "Item 42 has the earliest explicit commitment.",
        citations: [citation],
      },
    ],
    interpretations: ["The commitment makes item 42 the best next action."],
    uncertainties: ["The target date has not been reconfirmed this week."],
    proposedActions: [actions[0]],
    appliedActions: [
      {
        actionId: actions[0].actionId,
        summary: "The Issue was updated.",
      },
    ],
    effects: {
      confirmed: [
        {
          actionId: actions[0].actionId,
          summary: "The Issue exists with the requested content.",
          citations: [citation],
        },
      ],
      incomplete: [
        {
          actionId: actions[0].actionId,
          summary: "The Project field was not applied.",
          citations: [citation],
          remainingSteps: ["Apply the priority field to Project item PVTI_1."],
        },
      ],
    },
  });

  assert.deepEqual(response.assumptions, []);
  assert.deepEqual(response.citations, []);
  assert.deepEqual(response.rejectedActions, []);
  assert.equal(response.effects.confirmed.length, 1);
  assert.equal(response.effects.incomplete.length, 1);
  assert.deepEqual(validatePanFinalResponse(response), response);
});

test("validates confirmed and incomplete tool results", () => {
  const request = {
    version: 1,
    type: "tool-request",
    requestId: "request-1",
    turnId: "turn-1",
    operation: "apply_action",
    arguments: { action: actions[0] },
  };
  assert.deepEqual(validatePanToolMessage(request), request);

  const result = validatePanToolMessage({
    version: 1,
    type: "tool-result",
    requestId: "request-1",
    turnId: "turn-1",
    operation: "apply_action",
    status: "incomplete",
    confirmedEffects: [
      {
        actionId: actions[0].actionId,
        summary: "The Issue was created.",
      },
    ],
    incompleteEffects: [
      {
        actionId: actions[0].actionId,
        summary: "Project registration failed.",
        remainingSteps: ["Register the existing Issue in the Project."],
      },
    ],
  });

  assert.equal(result.status, "incomplete");
  assert.throws(
    () =>
      validatePanToolMessage({
        ...result,
        incompleteEffects: [],
      }),
    /toolMessage\.incompleteEffects must describe remaining work/,
  );
});

test("validates structured action effect records with recovery", () => {
  const message = validatePanToolMessage({
    version: 1,
    type: "tool-result",
    requestId: "request-2",
    turnId: "turn-1",
    operation: "apply_action",
    status: "incomplete",
    confirmedEffects: [
      {
        actionId: "action-1",
        groupId: "group-1",
        summary: "The Issue was created.",
        resource: "issue",
        externalIdentity: "https://github.com/example/domain/issues/42",
        confirmedState: { state: "open" },
        recovery: ["Register the existing Issue in the Project."],
      },
    ],
    incompleteEffects: [
      {
        actionId: "action-1",
        groupId: "group-1",
        summary: "Project registration failed.",
        resource: "project-membership",
        externalIdentity: "PVTI_1",
        confirmedState: { present: false },
        remainingSteps: ["Register the existing Issue in the Project."],
        recovery: ["Retry Project registration without creating another Issue."],
      },
    ],
  });

  assert.equal(message.incompleteEffects[0].resource, "project-membership");
});

test("protocol JSON schemas are committed as valid versioned JSON", async () => {
  for (const file of [
    "schema/pan-action.json",
    "schema/pan-tool-message.json",
    "schema/pan-turn.json",
  ]) {
    const schema = JSON.parse(await readFile(path.resolve(file), "utf8"));
    assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
    assert.match(schema.$id, /\/schema\/pan-/);
  }
});

function v2Mutation(kind, target, expectedState) {
  return {
    version: 2,
    actionId: `action-v2-${kind}`,
    kind,
    domain: {
      repository: "example/domain",
      projectOwner: "example",
      projectNumber: 12,
    },
    evidence: [citation],
    rationale: `Apply ${kind} using complete, current resource evidence.`,
    confidence: 0.9,
    idempotencyKey: `turn-2:${kind}`,
    expectedState,
    target,
  };
}
