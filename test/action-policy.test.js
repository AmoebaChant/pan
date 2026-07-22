import assert from "node:assert/strict";
import test from "node:test";

import { ActionPolicy } from "../src/index.js";

test("uses automatic reads and proposals with explained live mutations", () => {
  const policy = new ActionPolicy();

  assert.equal(policy.authority.reads, "automatic");
  assert.equal(policy.authority.proposals, "automatic");
  assert.equal(policy.authority.live["field-update"], "explanation");
  assert.equal(policy.authority.live["canonical-reorder"], "explanation");
  assert.equal(policy.authority.live["issue-comment"], "explanation");
  assert.equal(policy.authority.live["no-op"], "automatic");
  assert.equal(
    policy.assess(fieldAction("ready"), {
      snapshot: portfolio("ready"),
    }).authority,
    "automatic",
  );
});

test("supports configured approval requirements and material explanations", () => {
  const policy = new ActionPolicy({
    approvalRequired: ["canonical-reorder"],
  });
  const action = reorderAction(["ready", "other"], {
    rationale: "short",
  });
  const assessment = policy.assess(action, {
    snapshot: portfolio("ready", { extraIds: ["other"] }),
    mode: "live",
  });

  assert.equal(assessment.authority, "approval");
  assert.equal(assessment.requiresApproval, true);
  assert.equal(assessment.allowed, false);
  assert.match(assessment.reasons[0], /specific rationale/i);
});

test("protects active lifecycle states and leases from retriage", () => {
  const policy = new ActionPolicy();

  for (const status of ["in-progress", "in-review", "done"]) {
    const assessment = policy.assess(fieldAction(status), {
      snapshot: portfolio(status),
    });
    assert.equal(assessment.allowed, false);
    assert.match(assessment.reasons.join(" "), new RegExp(status));
  }

  const leased = policy.assess(fieldAction("ready"), {
    snapshot: portfolio("ready", { activeLease: true }),
  });
  assert.equal(leased.allowed, false);
  assert.match(leased.reasons.join(" "), /active lease/i);
});

test("does not clear human, runner, or unattributed blocks", () => {
  const policy = new ActionPolicy();

  for (const blockedBy of ["human", "runner-a", undefined]) {
    const assessment = policy.assess(
      fieldAction("blocked", {
        field: "status",
        value: "ready",
      }),
      { snapshot: portfolio("blocked", { blockedBy }) },
    );
    assert.equal(assessment.allowed, false);
    assert.match(assessment.reasons.join(" "), /not authorized to clear/i);
  }

  const panBlock = policy.assess(
    fieldAction("blocked", {
      field: "status",
      value: "ready",
    }),
    { snapshot: portfolio("blocked", { blockedBy: "pan" }) },
  );
  assert.equal(panBlock.allowed, true);
});

test("rejects stale item references and incomplete canonical reorders", () => {
  const policy = new ActionPolicy();
  const snapshot = portfolio("ready", { extraIds: ["other"] });

  assert.equal(
    policy.assess(fieldAction("ready", { itemId: "missing" }), {
      snapshot,
    }).allowed,
    false,
  );
  assert.equal(
    policy.assess(reorderAction(["ready"]), { snapshot }).allowed,
    false,
  );
});

test("protects lifecycle items when other work crosses their position", () => {
  const policy = new ActionPolicy();
  const snapshot = {
    project: { items: ["a", "protected", "b"] },
    dossiers: [
      dossier("a", "ready"),
      dossier("protected", "in-progress"),
      dossier("b", "ready"),
    ],
  };
  const assessment = policy.assess(
    reorderAction(["b", "protected", "a"]),
    { snapshot },
  );

  assert.equal(assessment.allowed, false);
  assert.match(assessment.reasons.join(" "), /protected.*in-progress/i);
});

function fieldAction(
  status,
  {
    itemId = "ready",
    field = "priority",
    value = "high",
  } = {},
) {
  return action({
    kind: "field-update",
    target: { itemId, field, value },
    expectedState: {
      snapshotId: "snapshot-1",
      status,
      [field]: "normal",
    },
  });
}

function reorderAction(orderedItemIds, { rationale } = {}) {
  return action({
    kind: "canonical-reorder",
    target: { orderedItemIds },
    expectedState: {
      snapshotId: "snapshot-1",
      orderedItemIds: [...orderedItemIds].reverse(),
    },
    rationale,
  });
}

function action({
  kind,
  target,
  expectedState,
  rationale = "The cited portfolio evidence requires this material change.",
}) {
  return {
    version: 1,
    actionId: `action-${kind}`,
    kind,
    rationale,
    confidence: 0.9,
    evidence: [{ kind: "project-field", locator: "item:ready" }],
    idempotencyKey: `idempotency-${kind}`,
    expectedState,
    target,
  };
}

function portfolio(
  status,
  { activeLease = false, blockedBy, extraIds = [] } = {},
) {
  const ids = ["ready", ...extraIds];
  return {
    project: { items: ids },
    dossiers: ids.map((id) => ({
      item: {
        id,
        fields: {
          status: id === "ready" ? status : "ready",
          priority: "normal",
          ...(id === "ready" && blockedBy ? { blockedBy } : {}),
        },
      },
      lease: { active: id === "ready" && activeLease },
    })),
  };
}

function dossier(id, status) {
  return {
    item: { id, fields: { status, priority: "normal" } },
    lease: { active: false },
  };
}
