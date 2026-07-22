import assert from "node:assert/strict";
import test from "node:test";

import { createEvidenceCommandHandlers, runPanCli } from "../src/index.js";

test("emits the common envelope for a complete Issue catalog", async () => {
  const stdout = capture();
  const catalog = {
    id: "sha256:catalog",
    capturedAt: "2026-07-22T00:00:00.000Z",
    complete: true,
    issues: [{ number: 1 }],
    excludedPullRequests: 2,
    diagnostics: [],
    source: {
      comments: { complete: true },
      relationships: { complete: false },
    },
  };

  const result = await runPanCli(
    ["evidence", "issues", "--schema-version", "1", "--config", "domain.json", "--json"],
    {
      stdout,
      commandContextFactory: async () => ({
        domain: {
          repository: "example/domain",
          projectOwner: "example",
          projectNumber: 1,
        },
        store: { readIssueCatalog: async () => catalog },
      }),
    },
  );

  assert.equal(result.status, "confirmed");
  assert.deepEqual(JSON.parse(stdout.value).snapshot, {
    catalogId: "sha256:catalog",
    capturedAt: "2026-07-22T00:00:00.000Z",
    complete: true,
    commentsComplete: true,
    relationshipsComplete: false,
    excludedPullRequests: 2,
  });
});

test("emits a version 2 portfolio snapshot with expected-state references", async () => {
  const stdout = capture();
  const snapshot = {
    id: "sha256:portfolio",
    version: 2,
    complete: true,
    usableForMutation: true,
    project: { items: ["project-item-1"] },
    issueCatalog: { id: "sha256:issues" },
    dossiers: [],
    diagnostics: [],
    expectedState: {
      projectOrder: "sha256:order",
      projectItems: "sha256:items",
      projectFields: "sha256:fields",
      projectMembership: "sha256:membership",
      issueCatalog: "sha256:issues",
      workstreamIndex: "revision",
      workstreamBlobs: "sha256:blobs",
      attentionRecords: "not-read",
      leadershipGeneration: "not-read",
    },
  };
  const result = await runPanCli(
    ["evidence", "portfolio", "--schema-version", "1", "--config", "domain.json", "--json"],
    {
      stdout,
      commandHandlers: {
        evidence: createEvidenceCommandHandlers({
          portfolioBuilderFactory: () => ({ build: async () => snapshot }),
        }),
      },
      commandContextFactory: async () => ({
        domain: {
          repository: "example/domain",
          projectOwner: "example",
          projectNumber: 1,
          path: "C:\\domain",
        },
        store: {},
      }),
    },
  );

  assert.equal(result.status, "confirmed");
  assert.deepEqual(JSON.parse(stdout.value).snapshot, {
    snapshotId: "sha256:portfolio",
    version: 2,
    complete: true,
    usableForMutation: true,
  });
  assert.equal(JSON.parse(stdout.value).expectedState.issueCatalog, "sha256:issues");
});

function capture() {
  return {
    value: "",
    write(chunk) {
      this.value += chunk;
    },
  };
}
