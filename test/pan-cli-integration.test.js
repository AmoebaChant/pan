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

test("exposes review and chat through the injected reasoning service", async () => {
  const calls = [];
  let receivedConfiguration;
  const result = {
    applied: false,
    response: {
      recommendation: "Do the commitment first.",
      proposedActions: [],
      appliedActions: [],
      rejectedActions: [],
    },
  };
  const dependencies = {
    stdout: capture(),
    stderr: capture(),
    domainConfigLoader: async () => domainConfig,
    storeFactory: () => ({}),
    attentionFactory: () => ({}),
    reviewServiceFactory: ({ configuration }) => {
      receivedConfiguration = configuration;
      return {
      run: async (options) => {
        calls.push(options);
        return result;
      },
      };
    },
  };

  await runPanCli(
    ["review", "--config", "domain.json"],
    dependencies,
  );
  await runPanCli(
    ["chat", "What next?", "--dry-run", "--config", "domain.json"],
    dependencies,
  );

  assert.deepEqual(calls, [
    { apply: false },
    { apply: false, userInput: "What next?" },
  ]);
  assert.deepEqual(receivedConfiguration.reviewPolicy, domainConfig.reviewPolicy);
});

test("reports incomplete reasoning effects as command failures", async () => {
  const stdout = capture();
  const dependencies = {
    stdout,
    stderr: capture(),
    domainConfigLoader: async () => domainConfig,
    storeFactory: () => ({}),
    attentionFactory: () => ({}),
    reviewServiceFactory: () => ({
      run: async () => ({
        applied: true,
        response: {
          recommendation: "Move B before A.",
          proposedActions: [],
          appliedActions: [],
          rejectedActions: [],
          effects: {
            confirmed: [],
            incomplete: [
              {
                summary: "PAN could not confirm the Project reorder.",
              },
            ],
          },
        },
      }),
    }),
    runtimeFactory: ({ reviewService }) => ({
      runOnce: async () => {
        const result = await reviewService.run({ apply: true });
        const error = new Error("incomplete mutation");
        error.result = result;
        throw error;
      },
    }),
  };

  await assert.rejects(
    runPanCli(["review", "--apply", "--config", "domain.json"], dependencies),
    /could not safely complete/i,
  );
  assert.match(stdout.value, /INCOMPLETE:/);
});

test("reports normal live-command lease contention", async () => {
  const stdout = capture();
  const result = await runPanCli(
    ["review", "--apply", "--config", "domain.json"],
    {
      stdout,
      stderr: capture(),
      domainConfigLoader: async () => domainConfig,
      storeFactory: () => ({}),
      attentionFactory: () => ({}),
      reviewServiceFactory: () => ({ run: async () => assert.fail("not run") }),
      runtimeFactory: () => ({
        runOnce: async () => ({ leader: false, reason: "leased" }),
      }),
    },
  );

  assert.equal(result.leader, false);
  assert.match(stdout.value, /already running elsewhere/i);
});

test("starts and stops the persistent PAN experience", async () => {
  const calls = [];
  const dependencies = {
    stdout: capture(),
    stderr: capture(),
    domainConfigLoader: async () => domainConfig,
    storeFactory: () => ({}),
    attentionFactory: () => ({}),
    startFactory: async (options) => {
      calls.push(["start", options]);
      return { started: true, terminalOpened: true };
    },
    stopFactory: async (options) => {
      calls.push(["stop", options]);
      return { stopped: true };
    },
    hostname: "machine-a",
    runnerProfileSourceFactory: () => ({
      load: async () => [
        {
          machine: "MACHINE-A",
          terminal: { profile: "PowerShell" },
        },
      ],
    }),
  };

  await runPanCli(
    ["start", "--background", "--config", "domain.json"],
    dependencies,
  );
  await runPanCli(
    ["stop", "--config", "domain.json"],
    dependencies,
  );

  assert.equal(calls[0][0], "start");
  assert.equal(calls[0][1].configPath, "domain.json");
  assert.equal(calls[0][1].autonomousApply, false);
  assert.equal(calls[0][1].agentName, "pan");
  assert.equal(calls[0][1].terminalProfile, "PowerShell");
  assert.equal(calls[1][0], "stop");
  assert.equal(calls[1][1].configPath, "domain.json");
});

test("does not force a terminal profile when the local runner omits it", async () => {
  let startOptions;

  await runPanCli(
    ["start", "--background", "--config", "domain.json"],
    {
      stdout: capture(),
      stderr: capture(),
      domainConfigLoader: async () => domainConfig,
      storeFactory: () => ({}),
      attentionFactory: () => ({}),
      hostname: "machine-a",
      runnerProfileSourceFactory: () => ({
        load: async () => [
          {
            machine: "machine-a",
            terminal: {},
          },
        ],
      }),
      startFactory: async (options) => {
        startOptions = options;
        return { started: false, terminalOpened: true };
      },
    },
  );

  assert.equal(startOptions.terminalProfile, undefined);
});

test("runs the host in the foreground and exposes its configured model", async () => {
  const calls = [];
  const logger = {
    info: (message) => calls.push(["log", message]),
    error() {},
    async close() {
      calls.push(["logger-close"]);
    },
  };
  await runPanCli(
    ["start", "--config", "domain.json"],
    {
      stdout: capture(),
      stderr: capture(),
      domainConfigLoader: async () => ({
        ...domainConfig,
        agent: {
          name: "pan",
          executable: "copilot",
          model: "gpt-5.6-sol",
        },
        selfRepair: {
          enabled: true,
          repository: "example/pan",
          workstream: "pan",
          requirements: ["task:self-repair"],
        },
      }),
      storeFactory: () => ({
        readCanonicalProject: async () => ({}),
      }),
      attentionFactory: () => ({}),
      reviewServiceFactory: () => ({
        run: async () => ({}),
        applyActions: async () => ({}),
      }),
      repairServiceFactory: ({ policy }) => ({
        policy,
        reportFailure: async () => ({}),
      }),
      toolRegistryFactory: () => ({
        dispatch: async () => ({}),
      }),
      prepareRuntimeFactory: async () => ({
        stateFile: "C:\\runtime\\host.json",
        logFile: "C:\\runtime\\host.log",
      }),
      loggerFactory: async () => logger,
      hostFactory: (options) => ({
        run: async () => {
          calls.push(["host", options]);
        },
      }),
    },
  );

  const options = calls.find(([kind]) => kind === "host")[1];
  assert.equal(options.model, "gpt-5.6-sol");
  assert.equal(options.repairService.policy.repository, "example/pan");
  assert.equal(typeof options.taskStore.readCanonicalProject, "function");
  assert.equal(options.stateFile, "C:\\runtime\\host.json");
  assert.ok(
    calls.some(
      ([kind, message]) =>
        kind === "log" && message.includes("press Ctrl+C"),
    ),
  );
  assert.deepEqual(calls.at(-1), ["logger-close"]);
});

test("connects an attached interactive session with an explicit model", async () => {
  let options;
  const stdout = capture();
  await runPanCli(
    ["connect", "--model", "gpt-5.6-sol", "--config", "domain.json"],
    {
      stdout,
      stderr: capture(),
      domainConfigLoader: async () => ({
        ...domainConfig,
        agent: {
          name: "pan",
          executable: "copilot-test",
        },
      }),
      storeFactory: () => ({}),
      attentionFactory: () => ({}),
      connectFactory: async (input) => {
        options = input;
        return { model: input.model };
      },
    },
  );

  assert.equal(options.executable, "copilot-test");
  assert.equal(options.agentName, "pan");
  assert.equal(options.model, "gpt-5.6-sol");
  assert.match(stdout.value, /use \/model/);
});

test("stops PAN even when the domain config can no longer load", async () => {
  let stopped = false;
  const result = await runPanCli(
    ["stop", "--config", "missing.json"],
    {
      stdout: capture(),
      stderr: capture(),
      domainConfigLoader: async () => assert.fail("config should not load"),
      stopFactory: async () => {
        stopped = true;
        return { stopped: true };
      },
    },
  );

  assert.equal(stopped, true);
  assert.deepEqual(result, { stopped: true });
});

function capture() {
  return {
    value: "",
    write(value) {
      this.value += value;
    },
  };
}
