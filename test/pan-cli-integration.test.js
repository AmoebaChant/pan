import assert from "node:assert/strict";
import test from "node:test";

import { runPanCli } from "../src/index.js";

const domainConfig = {
  domain: {
    repository: "example/domain",
    projectOwner: "example",
    projectNumber: 12,
    path: "C:\\domains\\example",
  },
  state: {
    branch: "pan-state",
    leaderPath: ".pan/leader.json",
  },
  cadences: {
    activePollSeconds: 30,
    leaderLeaseSeconds: 120,
    leaderHeartbeatSeconds: 30,
  },
};

const runnerProfile = {
  machine: "machine-a",
  pollIntervalSeconds: 30,
  store: {
    repository: "example/domain",
    projectOwner: "example",
    projectNumber: 12,
    path: "C:\\domains\\example",
  },
};

const inboxEntries = [
  {
    id: 42,
    kind: "needs-human",
    priority: "high",
    title: "Choose an API",
    issueUrl: "https://github.com/example/domain/issues/42",
  },
];

test("composes attention commands from domain config without a runner profile", async () => {
  const stdout = capture();
  const calls = [];

  const result = await runPanCli(["inbox", "--json", "--config", "domain.json"], {
    stdout,
    stderr: capture(),
    domainConfigLoader: async (configPath) => {
      calls.push(["config", configPath]);
      return domainConfig;
    },
    runnerProfileLoader: async () => assert.fail("profile loader was called"),
    storeFactory: (options) => {
      calls.push(["store", options]);
      return { kind: "domain-store" };
    },
    attentionFactory: ({ store }) => {
      assert.equal(store.kind, "domain-store");
      return { inbox: async () => inboxEntries };
    },
  });

  assert.deepEqual(result, inboxEntries);
  assert.deepEqual(calls[0], ["config", "domain.json"]);
  assert.deepEqual(calls[1][1], {
    repository: "example/domain",
    projectOwner: "example",
    projectNumber: 12,
    gh: calls[1][1].gh,
  });
  assert.deepEqual(JSON.parse(stdout.value), inboxEntries);
});

test("legacy profile mode adapts the same store and warns on stderr", async () => {
  const stdout = capture();
  const stderr = capture();
  let storeOptions;

  const result = await runPanCli(["inbox", "--json", "--profile", "runner.json"], {
    stdout,
    stderr,
    domainConfigLoader: async () => assert.fail("config loader was called"),
    runnerProfileLoader: async (profilePath) => {
      assert.equal(profilePath, "runner.json");
      return runnerProfile;
    },
    storeFactory: (options) => {
      storeOptions = options;
      return {};
    },
    attentionFactory: () => ({ inbox: async () => inboxEntries }),
  });

  assert.deepEqual(result, inboxEntries);
  assert.deepEqual(
    {
      repository: storeOptions.repository,
      projectOwner: storeOptions.projectOwner,
      projectNumber: storeOptions.projectNumber,
    },
    {
      repository: domainConfig.domain.repository,
      projectOwner: domainConfig.domain.projectOwner,
      projectNumber: domainConfig.domain.projectNumber,
    },
  );
  assert.doesNotThrow(() => JSON.parse(stdout.value));
  assert.match(stderr.value, /deprecated/i);
});

test("preserves answer and add result shapes through injected composition", async () => {
  const results = [];
  const dependencies = {
    stdout: capture(),
    stderr: capture(),
    domainConfigLoader: async () => domainConfig,
    storeFactory: () => ({}),
    attentionFactory: () => ({
      answer: async (identifier, text) => {
        results.push({ identifier, text });
        return { number: 42, url: "https://github.com/example/domain/issues/42" };
      },
      add: async (input) => {
        results.push(input);
        return { number: 43, url: "https://github.com/example/domain/issues/43" };
      },
    }),
  };

  const answer = await runPanCli(
    ["answer", "42", "Use option A.", "--config", "domain.json"],
    dependencies,
  );
  const added = await runPanCli(
    [
      "add",
      "Implement it",
      "--config",
      "domain.json",
      "--repo",
      "example/tool",
      "--requirement",
      "env:local",
    ],
    dependencies,
  );

  assert.deepEqual(answer, {
    id: 42,
    issueUrl: "https://github.com/example/domain/issues/42",
  });
  assert.deepEqual(added, {
    id: 43,
    issueUrl: "https://github.com/example/domain/issues/43",
  });
  assert.deepEqual(results[0], {
    identifier: "42",
    text: "Use option A.",
  });
  assert.deepEqual(results[1].requirements, [
    "env:local",
    "repo:example/tool",
  ]);
});

function capture() {
  return {
    value: "",
    write(value) {
      this.value += value;
    },
  };
}
