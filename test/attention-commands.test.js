import assert from "node:assert/strict";
import test from "node:test";

import {
  createAttentionCommandHandlers,
  PanCommandError,
  runPanCli,
} from "../src/index.js";

const domain = {
  repository: "example/domain",
  projectOwner: "example",
  projectNumber: 12,
};

test("lists attention through the common result envelope without leadership", async () => {
  const stdout = capture();
  const entries = [
    {
      id: 42,
      kind: "question",
      priority: "urgent",
      title: "Choose an API",
      issueUrl: "https://github.com/example/domain/issues/42",
      locator: { machine: "machine-a", localUrl: "http://localhost:3000" },
    },
  ];
  const handlers = createAttentionCommandHandlers({
    attentionFactory: () => ({ inbox: async () => entries }),
    leadershipHandlers: {
      assert: async () => assert.fail("list must not assert leadership"),
    },
  });

  const result = await runPanCli(
    ["attention", "list", "--schema-version", "1", "--config", "domain.json", "--json"],
    {
      stdout,
      commandHandlers: { attention: handlers },
      commandContextFactory: async () => context(),
    },
  );

  assert.equal(result.status, "confirmed");
  assert.deepEqual(result.data.entries, entries);
  assert.deepEqual(JSON.parse(stdout.value).data.entries, entries);
});

test("answers and adds tasks with their legacy JSON payloads nested in envelopes", async () => {
  const stdout = capture();
  const calls = [];
  const handlers = createAttentionCommandHandlers({
    attentionFactory: (options) => ({
      answer: async (identifier, text) => {
        calls.push({ options, identifier, text });
        return issue(42);
      },
      add: async (input) => {
        calls.push({ options, input });
        return issue(43);
      },
    }),
    leadershipHandlers: confirmedLeadership(),
  });
  const dependencies = {
    stdout,
    commandHandlers: { attention: handlers },
    commandContextFactory: async () => context(),
  };

  const answer = await runPanCli(
    [
      "attention",
      "answer",
      "42",
      "Use option A.",
      "--schema-version",
      "1",
      "--config",
      "domain.json",
    ],
    dependencies,
  );
  const added = await runPanCli(
    [
      "attention",
      "add",
      "Implement it",
      "--schema-version",
      "1",
      "--config",
      "domain.json",
      "--repo",
      "example/tool",
      "--requirement",
      "env:local",
      "--requirement",
      "tool:git",
    ],
    dependencies,
  );

  assert.deepEqual(answer.data, legacyItem(42));
  assert.deepEqual(added.data, legacyItem(43));
  assert.deepEqual(calls[0].identifier, "42");
  assert.deepEqual(calls[0].text, "Use option A.");
  assert.deepEqual(calls[1].input, {
    title: "Implement it",
    body: "",
    workstream: undefined,
    owner: "unassigned",
    priority: "normal",
    autonomy: "manual",
    requirements: ["env:local", "tool:git", "repo:example/tool"],
  });
});

test("rejects mutating attention commands before construction when leadership is absent", async () => {
  let constructed = false;
  const handlers = createAttentionCommandHandlers({
    attentionFactory: () => {
      constructed = true;
      return {};
    },
    leadershipHandlers: {
      assert: async () => ({
        status: "rejected",
        diagnostics: ["Leadership is held by another session."],
      }),
    },
  });

  await assert.rejects(
    runPanCli(
      [
        "attention",
        "add",
        "New task",
        "--schema-version",
        "1",
        "--config",
        "domain.json",
      ],
      {
        stdout: capture(),
        commandHandlers: { attention: handlers },
        commandContextFactory: async () => context(),
      },
    ),
    (error) => {
      assert.ok(error instanceof PanCommandError);
      assert.equal(error.result.status, "rejected");
      assert.match(error.result.diagnostics[0], /another session/);
      return true;
    },
  );
  assert.equal(constructed, false);
});

test("rejects missing attention command arguments before creating command context", async () => {
  await assert.rejects(
    runPanCli(
      [
        "attention",
        "answer",
        "42",
        "--schema-version",
        "1",
        "--config",
        "domain.json",
      ],
      {
        commandHandlers: {
          attention: createAttentionCommandHandlers({
            attentionFactory: () => assert.fail("handler must not run"),
          }),
        },
        commandContextFactory: async () => assert.fail("context must not be constructed"),
      },
    ),
    /requires <text>/,
  );
});

function context() {
  return {
    config: { attention: { assignee: "octocat" } },
    domain,
    store: {},
  };
}

function confirmedLeadership() {
  return {
    assert: async () => ({ status: "confirmed", diagnostics: [] }),
  };
}

function issue(number) {
  return {
    number,
    url: `https://github.com/example/domain/issues/${number}`,
  };
}

function legacyItem(number) {
  return {
    id: number,
    issueUrl: `https://github.com/example/domain/issues/${number}`,
  };
}

function capture() {
  return {
    value: "",
    write(chunk) {
      this.value += chunk;
    },
  };
}
