import assert from "node:assert/strict";
import test from "node:test";

import { runPanCli } from "../src/index.js";

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

function capture() {
  return {
    value: "",
    write(chunk) {
      this.value += chunk;
    },
  };
}
