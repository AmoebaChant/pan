import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
  reviewPolicy: {
    higherRisk: {
      enabled: true,
      actionKinds: ["canonical-reorder"],
    },
  },
  agent: {
    name: "pan",
  },
};

test("runs setup before loading any existing configuration", async () => {
  const stdout = capture();
  let received;
  const expected = {
    repository: "example/domain",
    directory: "C:\\domains\\example",
    configPath: "C:\\domains\\example\\pan.json",
    projectOwner: "example",
    projectNumber: 12,
    projectUrl: "https://github.com/users/example/projects/12",
    runnerProfilePath: "C:\\domains\\example\\runners\\machine.json",
    approvalMode: "prompt",
    runnerOnline: false,
  };

  const result = await runPanCli(
    ["setup", "--repository", "example/domain", "--json"],
    {
      stdout,
      stderr: capture(),
      domainConfigLoader: async () => assert.fail("config loader was called"),
      runnerProfileLoader: async () => assert.fail("profile loader was called"),
      setupFactory: async (options) => {
        received = options;
        return expected;
      },
    },
  );

  assert.equal(received.repository, "example/domain");
  assert.deepEqual(result, expected);
  assert.deepEqual(JSON.parse(stdout.value), expected);
});

test("dispatches a hostless session without constructing legacy host services", async () => {
  const stdout = capture();
  let received;
  const config = {
    ...domainConfig,
    version: 2,
    state: { branch: "pan-state", path: ".pan", leaderPath: ".pan/leader.json" },
    session: { agent: { name: "pan", executable: "copilot-test" }, productContextRoots: [] },
  };

  const result = await runPanCli(["session", "--config", "domain.json", "--json"], {
    stdout,
    stderr: capture(),
    domainConfigLoader: async () => config,
    storeFactory: () => assert.fail("session must not construct a legacy store"),
    attentionFactory: () => assert.fail("session must not construct legacy attention"),
    sessionFactory: async (options) => {
      received = options;
      options.onMode?.({ mode: "writing" });
      return { exitCode: 0, domain: { repository: "example/domain" } };
    },
  });

  assert.equal(received.config, config);
  assert.equal(received.configPath, "domain.json");
  assert.equal(received.executable, "copilot-test");
  assert.equal(received.onMode, undefined);
  assert.deepEqual(result, { exitCode: 0, domain: { repository: "example/domain" } });
  assert.deepEqual(JSON.parse(stdout.value), result);
});

test("reports session mode and leadership-loss recovery guidance", async () => {
  const stdout = capture();
  const config = {
    ...domainConfig,
    version: 2,
    state: { branch: "pan-state", path: ".pan", leaderPath: ".pan/leader.json" },
    session: { agent: { name: "pan", executable: "copilot-test" }, productContextRoots: [] },
  };

  await runPanCli(["session", "--config", "domain.json"], {
    stdout,
    stderr: capture(),
    domainConfigLoader: async () => config,
    sessionFactory: async ({ onMode }) => {
      onMode({ mode: "read-only", reason: "held-by-another-session" });
      return {
        exitCode: 1,
        mode: "read-only",
        leadership: {
          status: "lost",
          diagnostic: "PAN leadership lost: contended",
          guidance: "Restart the session to acquire leadership, or continue in read-only mode.",
        },
      };
    },
  });

  assert.match(stdout.value, /read-only session started/i);
  assert.match(stdout.value, /mutations and scheduled reviews are unavailable/i);
  assert.match(stdout.value, /Leadership lost/i);
  assert.match(stdout.value, /Restart the session/i);
});

test("reports successful setup in the default human-readable format", async () => {
  const stdout = capture();
  await runPanCli(["setup", "--repository", "example/domain"], {
    stdout,
    stderr: capture(),
    setupFactory: async () => ({
      repository: "example/domain",
      directory: "C:\\domains\\example",
      configPath: "C:\\domains\\example\\pan.json",
      projectOwner: "example",
      projectNumber: 12,
      projectUrl: "https://github.com/users/example/projects/12",
      runnerProfilePath: "C:\\domains\\example\\runners\\machine.json",
      approvalMode: "prompt",
      runnerOnline: false,
    }),
  });

  assert.match(stdout.value, /PAN domain ready: example\/domain/);
  assert.match(stdout.value, /Runner profile: .* \(offline\)/);
  assert.match(stdout.value, /Copilot approvals: prompt/);
});

test("keeps legacy attention aliases equivalent to canonical helper commands", async () => {
  const domain = {
    repository: "example/domain",
    projectOwner: "example",
    projectNumber: 12,
  };
  const command = (operation, specification) =>
    Object.assign(
      async ({ options }) => ({
        version: 1,
        status: "confirmed",
        operation,
        operationId: `${operation}-1`,
        domain,
        confirmedEffects: [operation],
        remainingSteps: [],
        diagnostics: [],
        recovery: { safe: true, steps: [] },
        data: options,
      }),
      { specification },
    );
  const commandHandlers = {
    attention: {
      list: command("attention.list", {}),
      answer: command("attention.answer", { positionals: ["identifier", "text"] }),
      add: command("attention.add", {
        positionals: ["title"],
        options: ["body", "body-file", "workstream", "owner", "priority", "autonomy"],
        repeatableOptions: ["requirement", "repo"],
      }),
    },
  };
  const cases = [
    {
      canonical: ["attention", "list", "--schema-version", "1", "--config", "domain.json", "--json"],
      alias: ["inbox", "--config", "domain.json", "--json"],
      replacement: "attention list",
    },
    {
      canonical: ["attention", "answer", "42", "Use option A.", "--schema-version", "1", "--config", "domain.json", "--json"],
      alias: ["answer", "42", "Use option A.", "--config", "domain.json", "--json"],
      replacement: "attention answer",
    },
    {
      canonical: ["attention", "add", "Implement it", "--repo", "example/tool", "--requirement", "env:local", "--schema-version", "1", "--config", "domain.json", "--json"],
      alias: ["add", "Implement it", "--repo", "example/tool", "--requirement", "env:local", "--config", "domain.json", "--json"],
      replacement: "attention add",
    },
  ];

  for (const { canonical, alias, replacement } of cases) {
    const canonicalOutput = capture();
    const aliasOutput = capture();
    const stderr = capture();
    const dependencies = {
      commandHandlers,
      commandContextFactory: async () => ({ domain }),
    };
    const expected = await runPanCli(canonical, {
      ...dependencies,
      stdout: canonicalOutput,
      stderr: capture(),
    });
    const actual = await runPanCli(alias, {
      ...dependencies,
      stdout: aliasOutput,
      stderr,
    });

    assert.deepEqual(actual, expected);
    assert.equal(aliasOutput.value, canonicalOutput.value);
    assert.match(stderr.value, /deprecated/i);
    assert.match(stderr.value, new RegExp(replacement));
  }
});

test("retires host-era commands before constructing services", async () => {
  for (const command of ["start", "stop", "host", "connect", "daemon", "chat", "review"]) {
    await assert.rejects(
      runPanCli([command, "--json"], {
        domainConfigLoader: async () => assert.fail("config loader was called"),
        sessionFactory: async () => assert.fail("session factory was called"),
        runtimeFactory: () => assert.fail("runtime factory was called"),
      }),
      (error) => {
        assert.match(error.message, /is retired/i);
        assert.deepEqual(error.result, {
          version: 1,
          status: "retired",
          command,
          replacement: "pan session --config <path>",
          guidance: [error.result.guidance[0]],
        });
        return true;
      },
    );
  }
});

test("prints a structured retirement result from the executable", () => {
  const result = spawnSync(process.execPath, ["bin/pan.js", "host", "--json"], {
    cwd: process.cwd(),
    encoding: "utf8",
  });

  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(result.stdout), {
    version: 1,
    status: "retired",
    command: "host",
    replacement: "pan session --config <path>",
    guidance: [
      "Run pan session --config <path> in the foreground; PAN no longer runs a host or bridge.",
    ],
  });
});

function capture() {
  return {
    value: "",
    write(value) {
      this.value += value;
    },
  };
}
