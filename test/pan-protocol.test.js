import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  isHostlessLiveAction,
  PAN_ACTION_VERSION,
  validatePanAction,
  validatePanActionGroup,
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
