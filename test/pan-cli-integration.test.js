import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

import { runPanCli } from "../src/index.js";

const domainConfig = {
  domain: {
    repository: "example/domain",
    projectOwner: "example",
    projectNumber: 12,
    path: "C:\\domains\\example",
  },
  session: { agent: { name: "pan" }, productContextRoots: [] },
  scheduling: { enabled: false },
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

test("dispatches verification and shortcut creation with both configurations", async () => {
  const stdout = capture();
  const config = {
    version: 2,
    domain: {
      repository: "example/domain",
      projectOwner: "example",
      projectNumber: 12,
      path: "C:\\domains\\example",
    },
  };
  const profile = {
    domainConfigPath: path.resolve("domain.json"),
    store: {
      repository: "example/domain",
      projectOwner: "example",
      projectNumber: 12,
      path: "C:\\domains\\example",
    },
  };
  const verified = await runPanCli(
    ["verify", "--config", "domain.json", "--profile", "runner.json", "--json"],
    {
      stdout,
      domainConfigLoader: async () => config,
      verificationFactory: async (options) => ({
        status: "ready",
        repository: options.config.domain.repository,
      }),
    },
  );
  assert.equal(verified.status, "ready");

  stdout.value = "";
  const shortcuts = await runPanCli(
    [
      "shortcuts",
      "create",
      "--config",
      "domain.json",
      "--profile",
      "runner.json",
      "--selection",
      "both",
      "--json",
    ],
    {
      stdout,
      domainConfigLoader: async () => config,
      runnerProfileLoader: async () => profile,
      shortcutFactory: async (options) => ({
        status: "created",
        shortcuts: [{ kind: options.selection, path: "desktop" }],
      }),
    },
  );
  assert.equal(shortcuts.status, "created");
});

test("dispatches an ordinary foreground session", async () => {
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
    sessionFactory: async (options) => {
      received = options;
      return { exitCode: 0, domain: { repository: "example/domain" } };
    },
  });

  assert.equal(received.config, config);
  assert.equal(received.configPath, "domain.json");
  assert.equal(received.executable, "copilot-test");
  assert.deepEqual(result, { exitCode: 0, domain: { repository: "example/domain" } });
  assert.deepEqual(JSON.parse(stdout.value), result);
});

test("reports the foreground session exit", async () => {
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
    sessionFactory: async () => ({ exitCode: 0 }),
  });

  assert.equal(stdout.value, "PAN session exited with code 0.\n");
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

test("does not expose task helper commands", async () => {
  for (const args of [
    ["inbox", "--config", "domain.json"],
    ["answer", "42", "Use option A.", "--config", "domain.json"],
    ["add", "Implement it", "--config", "domain.json"],
  ]) {
    await assert.rejects(
      runPanCli(args, {
        domainConfigLoader: async () => assert.fail("config loader was called"),
      }),
      /Usage:/,
    );
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
