import assert from "node:assert/strict";
import test from "node:test";

import {
  ReasoningService,
  ReasoningTurnError,
} from "../src/index.js";

const NOW = new Date("2026-07-20T22:00:00.000Z");

test("runs one complete dry-run turn with every dossier and validated proposals", async () => {
  const observed = [];
  const observedOptions = [];
  const snapshot = portfolio();
  const service = createService({
    snapshot,
    observed,
    observedOptions,
    proposedActions: [fieldAction(snapshot.id)],
    manualConstraints: [
      { beforeItemId: "human", afterItemId: "agent" },
    ],
  });

  const result = await service.review({ dryRun: true });

  assert.equal(result.status, "dry-run");
  assert.equal(result.snapshotId, snapshot.id);
  assert.equal(result.classifications.length, snapshot.dossiers.length);
  assert.equal(result.humanNextAction.itemId, "human");
  assert.deepEqual(
    result.agentQueueRecommendation.orderedItemIds,
    ["agent"],
  );
  assert.equal(result.acceptedProposals.length, 1);
  assert.deepEqual(result.rejectedProposals, []);
  assert.equal(observed.length, 1);
  assert.deepEqual(
    observed[0].portfolio.canonicalOrder,
    snapshot.project.items,
  );
  assert.equal(
    observed[0].portfolio.dossiers.length,
    snapshot.dossiers.length,
  );
  assert.deepEqual(observed[0].portfolio.manualConstraints, [
    { beforeItemId: "human", afterItemId: "agent" },
  ]);
  assert.equal(observed[0].portfolio.authority.reads, "automatic");
  assert.equal(observedOptions[0].inlinePortfolio, true);
});

test("rejects incomplete snapshots before invoking the agent", async () => {
  let reviews = 0;
  const snapshot = { ...portfolio(), complete: false };
  const service = new ReasoningService({
    snapshotSource: { build: async () => snapshot },
    agentClient: {
      review: async () => {
        reviews += 1;
      },
    },
    now: () => NOW,
  });

  await assert.rejects(
    service.review(),
    (error) =>
      error instanceof ReasoningTurnError &&
      error.state === "incomplete-snapshot",
  );
  assert.equal(reviews, 0);
});

test("rejects omitted, duplicate, and unknown item classifications", async (t) => {
  for (const [name, mutate] of [
    ["omitted", (values) => values.slice(1)],
    ["duplicate", (values) => [values[0], values[0], ...values.slice(2)]],
    [
      "unknown",
      (values) => [
        { ...values[0], itemId: "unknown" },
        ...values.slice(1),
      ],
    ],
  ]) {
    await t.test(name, async () => {
      const service = createService({
        responseTransform: (response) => ({
          ...response,
          classifications: mutate(response.classifications),
        }),
      });
      await assert.rejects(
        service.review(),
        (error) => error.state === "incomplete-classification",
      );
    });
  }
});

test("rejects polished fixed-sort output without portfolio evidence", async () => {
  const service = createService({
    responseTransform: (response) => ({
      ...response,
      recommendation: "Sort by status and priority.",
      classifications: response.classifications.map((classification) => ({
        ...classification,
        rationale: "Sorted by fixed status and priority.",
        citations: [
          {
            kind: "issue",
            locator: "https://github.com/example/domain/issues/999",
          },
        ],
      })),
    }),
  });

  await assert.rejects(
    service.review(),
    (error) => error.state === "invalid-citation",
  );
});

test("rejects malformed and unstable final responses", async (t) => {
  await t.test("malformed", async () => {
    const service = createService({
      responseTransform: (response) => {
        const malformed = { ...response };
        delete malformed.recommendation;
        return malformed;
      },
    });
    await assert.rejects(
      service.review(),
      (error) => error.state === "invalid-response",
    );
  });

  await t.test("unstable snapshot identity", async () => {
    const service = createService({
      responseTransform: (response) => ({
        ...response,
        snapshotId: "another-snapshot",
      }),
    });
    await assert.rejects(
      service.review(),
      (error) => error.state === "unstable-response",
    );
  });
});

test("requires supported human and agent recommendations", async (t) => {
  await t.test("missing human next action", async () => {
    const service = createService({
      responseTransform: (response) => {
        const transformed = { ...response };
        delete transformed.humanNextAction;
        return transformed;
      },
    });
    await assert.rejects(
      service.review(),
      (error) => error.state === "invalid-response",
    );
  });

  await t.test("non-canonical agent queue", async () => {
    const snapshot = portfolio({
      extraAgent: true,
    });
    const service = createService({
      snapshot,
      responseTransform: (response) => ({
        ...response,
        agentQueueRecommendation: {
          ...response.agentQueueRecommendation,
          orderedItemIds: ["agent-2", "agent"],
        },
      }),
    });
    await assert.rejects(
      service.review(),
      (error) => error.state === "invalid-recommendation",
    );
  });

  await t.test("incomplete agent queue", async () => {
    const snapshot = portfolio({ extraAgent: true });
    const service = createService({
      snapshot,
      responseTransform: (response) => ({
        ...response,
        agentQueueRecommendation: {
          ...response.agentQueueRecommendation,
          orderedItemIds: ["agent"],
        },
      }),
    });
    await assert.rejects(
      service.review(),
      (error) => error.state === "invalid-recommendation",
    );
  });
});

test("collects lifecycle policy rejections without applying actions", async () => {
  const snapshot = portfolio();
  const service = createService({
    snapshot,
    proposedActions: [fieldAction(snapshot.id, "done", "done")],
  });

  const result = await service.review();

  assert.equal(result.acceptedProposals.length, 0);
  assert.equal(result.rejectedProposals.length, 1);
  assert.match(
    result.rejectedProposals[0].reasons.join(" "),
    /protected while done/i,
  );
});

test("rejects unsupported mutation targets without applying them", async () => {
  const snapshot = portfolio();
  const action = fieldAction(snapshot.id);
  action.target.field = "private-field";
  const service = createService({
    snapshot,
    proposedActions: [action],
  });

  const result = await service.review();

  assert.equal(result.acceptedProposals.length, 0);
  assert.match(
    result.rejectedProposals[0].reasons.join(" "),
    /unsupported Project field/i,
  );
});

test("rejects reported effects from a dry-run", async () => {
  const service = createService({
    responseTransform: (response) => ({
      ...response,
      appliedActions: [
        { actionId: "action-field", summary: "Applied unexpectedly." },
      ],
      effects: {
        confirmed: [
          {
            actionId: "action-field",
            summary: "Applied unexpectedly.",
            citations: [],
          },
        ],
        incomplete: [],
      },
    }),
  });

  await assert.rejects(
    service.review(),
    (error) => error.state === "dry-run-side-effect",
  );
});

test("makes agent failures visible and preserves side-effect state", async () => {
  const transportError = Object.assign(new Error("transport failed"), {
    state: "timeout",
    confirmedSideEffects: true,
  });
  const service = new ReasoningService({
    snapshotSource: { build: async () => portfolio() },
    agentClient: {
      review: async () => {
        throw transportError;
      },
    },
    now: () => NOW,
    idFactory: () => "turn-fixed",
  });

  await assert.rejects(
    service.review(),
    (error) =>
      error.state === "agent-failed" &&
      error.detail === "timeout" &&
      error.confirmedSideEffects === true,
  );
});

test("produces equivalent structural decisions for a fixed response", async () => {
  const service = createService();
  const first = await service.review();
  const second = await service.review();

  assert.deepEqual(first.classifications, second.classifications);
  assert.deepEqual(
    first.agentQueueRecommendation,
    second.agentQueueRecommendation,
  );
  assert.deepEqual(first.acceptedProposals, second.acceptedProposals);
});

function createService({
  snapshot = portfolio(),
  observed = [],
  observedOptions = [],
  proposedActions = [],
  responseTransform = (response) => response,
  manualConstraints = [],
} = {}) {
  return new ReasoningService({
    snapshotSource: { build: async () => snapshot },
    agentClient: {
      review: async (turn, options) => {
        observed.push(turn);
        observedOptions.push(options);
        return {
          response: responseTransform(
            finalResponse(turn, snapshot, proposedActions),
          ),
          sessionId: "session-fixed",
          toolMessages: [],
        };
      },
    },
    manualConstraintSource: {
      read: async () => manualConstraints,
    },
    now: () => NOW,
    idFactory: () => "turn-fixed",
  });
}

function finalResponse(turn, snapshot, proposedActions) {
  const human = snapshot.dossiers.find(
    (dossier) => dossier.item.id === "human",
  );
  const agentIds = snapshot.dossiers
    .filter(
      (dossier) =>
        dossier.item.fields.owner === "agent" &&
        dossier.preclassification === "actionable",
    )
    .map((dossier) => dossier.item.id);
  return {
    version: 1,
    type: "final-response",
    turnId: turn.turnId,
    mode: turn.mode,
    timestamp: turn.timestamp,
    snapshotId: snapshot.id,
    recommendation: "Do the human decision, then run the agent queue.",
    facts: [
      {
        statement: "The human item is ready.",
        citations: [issueCitation(human.item)],
      },
    ],
    interpretations: ["The human decision should lead."],
    assumptions: [],
    uncertainties: [],
    citations: [issueCitation(human.item)],
    classifications: snapshot.dossiers.map((dossier) => ({
      itemId: dossier.item.id,
      classification: dossier.preclassification,
      rationale: `The durable evidence classifies ${dossier.item.id}.`,
      citations: [issueCitation(dossier.item)],
    })),
    humanNextAction: {
      itemId: human.item.id,
      recommendation: "Make the documented human decision.",
      citations: [issueCitation(human.item)],
    },
    agentQueueRecommendation: {
      orderedItemIds: agentIds,
      recommendation: "Run compatible agent work in canonical order.",
      citations: agentIds.map((itemId) =>
        issueCitation(
          snapshot.dossiers.find(
            (dossier) => dossier.item.id === itemId,
          ).item,
        ),
      ),
    },
    proposedActions,
    appliedActions: [],
    rejectedActions: [],
    effects: { confirmed: [], incomplete: [] },
  };
}

function fieldAction(snapshotId, itemId = "human", status = "ready") {
  const issueNumber = itemId === "done" ? 3 : 1;
  return {
    version: 1,
    actionId: "action-field",
    kind: "field-update",
    rationale: "The cited evidence supports a material priority change.",
    confidence: 0.9,
    evidence: [
      {
        kind: "issue",
        locator: `https://github.com/example/domain/issues/${issueNumber}`,
      },
    ],
    idempotencyKey: "field-key",
    expectedState: {
      snapshotId,
      status,
      priority: "normal",
    },
    target: { itemId, field: "priority", value: "high" },
  };
}

function portfolio({ extraAgent = false } = {}) {
  const dossiers = [
    dossier("human", 1, {
      owner: "human",
      preclassification: "actionable",
    }),
    dossier("agent", 2, {
      owner: "agent",
      preclassification: "actionable",
      runner: true,
    }),
    dossier("done", 3, {
      owner: "human",
      status: "done",
      preclassification: "done",
    }),
    dossier("blocked", 4, {
      owner: "human",
      status: "blocked",
      preclassification: "blocked",
    }),
  ];
  if (extraAgent) {
    dossiers.push(
      dossier("agent-2", 5, {
        owner: "agent",
        preclassification: "actionable",
        runner: true,
      }),
    );
  }
  return {
    id: "sha256:snapshot",
    capturedAt: NOW.toISOString(),
    complete: true,
    usableForMutation: true,
    project: {
      id: "sha256:project",
      items: dossiers.map((entry) => entry.item.id),
    },
    runnerAvailability: {
      complete: true,
      runners: [
        {
          id: "runner-a",
          online: true,
          capabilities: ["repo:example/tool"],
          maximumCapacity: 2,
          activeLeaseCount: 0,
          freeCapacity: 2,
          capacityKnown: true,
        },
      ],
    },
    dossiers,
    diagnostics: [],
  };
}

function dossier(
  id,
  number,
  {
    owner,
    status = "ready",
    preclassification,
    runner = false,
  },
) {
  return {
    canonicalIndex: number - 1,
    preclassification,
    item: {
      id,
      number,
      title: `Task ${id}`,
      body: "Durable evidence.",
      url: `https://github.com/example/domain/issues/${number}`,
      state: "open",
      repository: "example/domain",
      comments: [],
      fields: {
        owner,
        status,
        priority: "normal",
        workstream: `planning/${id}`,
      },
      requirements: runner ? ["repo:example/tool"] : [],
    },
    lease: { active: false, expired: false },
    workstream: {
      path: `planning/${id}`,
      sourcePath: `workstreams/planning/${id}/README.md`,
      contentHash: `sha256:${id}`,
      revision: "a".repeat(40),
      history: [],
      available: true,
    },
    compatibility: {
      requirements: runner ? ["repo:example/tool"] : [],
      runners: runner
        ? [
            {
              id: "runner-a",
              freeCapacity: 2,
              capacityKnown: true,
            },
          ]
        : [],
    },
  };
}

function issueCitation(item) {
  return { kind: "issue", locator: item.url };
}
