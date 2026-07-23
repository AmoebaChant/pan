import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { setupPanDomain } from "../src/index.js";

test("creates and bootstraps a private PAN domain with safe approvals", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pan-setup-"));
  const directory = path.join(root, "domain");
  const gh = new FakeGh();
  const commands = new FakeCommands();

  try {
    const result = await setupPanDomain(
      {
        repository: "example/domain",
        path: directory,
        projectOwner: "example",
        projectTitle: "Personal PAN",
        approvalMode: "prompt",
      },
      {
        gh,
        commands,
        hostname: "Machine A",
        env: { LOCALAPPDATA: path.join(root, "local") },
        now: () => new Date("2026-07-21T00:00:00.000Z"),
        ask: assert.fail,
      },
    );

    assert.ok(
      gh.calls.some(
        (args) =>
          args[0] === "repo" &&
          args[1] === "create" &&
          args.includes("--private"),
      ),
    );
    assert.ok(
      gh.calls.some(
        (args) =>
          args[0] === "project" &&
          args[1] === "field-delete" &&
          args.includes("status-id"),
      ),
    );
    assert.equal(
      gh.calls.filter(
        (args) => args[0] === "project" && args[1] === "field-create",
      ).length,
      8,
    );

    const config = JSON.parse(await readFile(result.configPath, "utf8"));
    assert.equal(config.version, 2);
    assert.equal(config.domain.path, path.resolve(directory));
    assert.equal(config.domain.projectNumber, 7);
    assert.deepEqual(config.scheduling, { enabled: false });

    const runner = JSON.parse(
      await readFile(result.runnerProfilePath, "utf8"),
    );
    assert.equal(runner.online, false);
    assert.deepEqual(runner.repositories, {});
    assert.equal(runner.copilot.approvalMode, "prompt");
    assert.equal(runner.store.path, path.resolve(directory));
    assert.equal(runner.domainConfigPath, result.configPath);

    const workstream = await readFile(
      path.join(
        directory,
        "workstreams",
        "getting-started",
        "README.md",
      ),
      "utf8",
    );
    assert.match(workstream, /state: Active/);
    assert.match(workstream, /updated: 2026-07-21/);
    assert.deepEqual(
      commands.calls.map(({ executable, args }) => [executable, args[2]]),
      [
        ["git", "add"],
        ["git", "diff"],
        ["git", "commit"],
        ["git", "push"],
      ],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("connects an existing private repository and compatible Project without replacing its README", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pan-setup-connect-"));
  const directory = path.join(root, "domain");
  const gh = new ConnectGh();
  try {
    const result = await setupPanDomain(
      {
        repository: "example/domain",
        repositoryMode: "connect",
        path: directory,
        projectOwner: "example",
        projectMode: "connect",
        projectNumber: 9,
        approvalMode: "prompt",
      },
      {
        gh,
        commands: new FakeCommands(),
        hostname: "machine",
        ask: assert.fail,
      },
    );

    assert.equal(result.repositoryMode, "connect");
    assert.equal(result.projectMode, "connect");
    assert.equal(result.projectNumber, 9);
    assert.equal(await readFile(path.join(directory, "README.md"), "utf8"), "# Existing\n");
    assert.equal(
      gh.calls.some((args) => args[0] === "project" && args[1] === "field-delete"),
      false,
    );
    assert.equal(
      gh.calls.some((args) => args[0] === "project" && args[1] === "field-create"),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("adopts an existing local PAN domain and resumes without replacing its data", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pan-setup-existing-domain-"));
  const directory = path.join(root, "domain");
  const runnerPath = path.join(directory, "runners", "machine.json");
  const gh = new ConnectGh();
  const commands = new ExistingDomainCommands(directory);
  try {
    await mkdir(path.dirname(runnerPath), { recursive: true });
    await writeFile(path.join(directory, "README.md"), "# Existing domain\n");
    const existingRunner = {
      version: 1,
      id: "machine",
      machine: "Machine",
      online: false,
      maxConcurrentDaemons: 2,
      capabilities: ["env:local"],
      store: {
        repository: "example/domain",
        projectOwner: "example",
        projectNumber: 9,
      },
      repositories: {},
      workspaceRoot: path.join(root, "worktrees"),
      stateDirectory: path.join(root, "state"),
      terminal: { type: "windows-terminal" },
      copilot: { approvalMode: "allow-all" },
      preservedSetting: "keep-me",
    };
    const existingRunnerSource = `${JSON.stringify(existingRunner, null, 4)}\n`;
    await writeFile(
      runnerPath,
      existingRunnerSource,
    );

    const options = {
      repository: "example/domain",
      repositoryMode: "connect",
      path: directory,
      projectOwner: "example",
      projectMode: "connect",
      projectNumber: 9,
      approvalMode: "allow-all",
    };
    const dependencies = {
      gh,
      commands,
      hostname: "Machine",
      ask: assert.fail,
    };
    const first = await setupPanDomain(options, dependencies);
    const commitCount = commands.calls.filter(
      ({ args }) => args[2] === "commit",
    ).length;
    const resumed = await setupPanDomain(options, dependencies);

    assert.equal(first.configPath, path.join(directory, "pan.json"));
    assert.equal(resumed.configPath, first.configPath);
    assert.equal(
      gh.calls.some(
        (args) => args[0] === "repo" && args[1] === "clone",
      ),
      false,
    );
    assert.equal(
      await readFile(path.join(directory, "README.md"), "utf8"),
      "# Existing domain\n",
    );
    const runnerSource = await readFile(runnerPath, "utf8");
    const runner = JSON.parse(runnerSource);
    assert.equal(runnerSource, existingRunnerSource);
    assert.equal(runner.preservedSetting, "keep-me");
    assert.equal(runner.maxConcurrentDaemons, 2);
    assert.equal(runner.store.path, undefined);
    assert.equal(runner.domainConfigPath, undefined);
    assert.equal(runner.copilot.approvalMode, "allow-all");
    assert.equal(resumed.runnerOnline, false);
    assert.equal(
      commands.calls.filter(({ args }) => args[2] === "commit").length,
      commitCount,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects modified setup files in an existing domain before Project mutation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pan-setup-dirty-domain-"));
  const directory = path.join(root, "domain");
  const gh = new ConnectGh();
  const commands = new ExistingDomainCommands(directory, {
    dirty: " M runners/machine.json\n",
  });
  try {
    await mkdir(directory, { recursive: true });
    await assert.rejects(
      setupPanDomain(
        {
          repository: "example/domain",
          repositoryMode: "connect",
          path: directory,
          projectOwner: "example",
          projectMode: "connect",
          projectNumber: 9,
          approvalMode: "prompt",
        },
        {
          gh,
          commands,
          hostname: "Machine",
          ask: assert.fail,
        },
      ),
      /setup-managed files have uncommitted changes/,
    );
    assert.equal(
      gh.calls.some(
        (args) =>
          args[0] === "project" &&
          ["link", "field-create", "field-delete"].includes(args[1]),
      ),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resumes by pushing a bootstrap commit after the first push fails", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pan-setup-push-resume-"));
  const directory = path.join(root, "domain");
  const gh = new ConnectGh();
  const commands = new ExistingDomainCommands(directory, {
    failPushOnce: true,
  });
  const options = {
    repository: "example/domain",
    repositoryMode: "connect",
    path: directory,
    projectOwner: "example",
    projectMode: "connect",
    projectNumber: 9,
    approvalMode: "prompt",
  };
  const dependencies = {
    gh,
    commands,
    hostname: "Machine",
    ask: assert.fail,
  };
  try {
    await mkdir(directory, { recursive: true });
    await assert.rejects(
      setupPanDomain(options, dependencies),
      /push failed/,
    );

    const resumed = await setupPanDomain(options, dependencies);

    assert.equal(resumed.configPath, path.join(directory, "pan.json"));
    assert.equal(
      commands.calls.filter(({ args }) => args[2] === "commit").length,
      1,
    );
    assert.equal(
      commands.calls.filter(({ args }) => args[2] === "push").length,
      2,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("preflights all connected Project fields before mutating the Project", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pan-setup-incompatible-"));
  const gh = new IncompatibleConnectGh();
  try {
    await assert.rejects(
      setupPanDomain(
        {
          repository: "example/domain",
          repositoryMode: "create",
          path: path.join(root, "domain"),
          projectOwner: "example",
          projectMode: "connect",
          projectNumber: 9,
          approvalMode: "prompt",
        },
        {
          gh,
          commands: new FakeCommands(),
          hostname: "machine",
          ask: assert.fail,
        },
      ),
      /requirements has an incompatible type/,
    );
    assert.equal(
      gh.calls.some(
        (args) =>
          args[0] === "project" &&
          ["link", "field-create", "field-delete"].includes(args[1]),
      ),
      false,
    );
    assert.equal(
      gh.calls.some(
        (args) =>
          args[0] === "repo" && ["create", "clone"].includes(args[1]),
      ),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a required field name implemented as an iteration field", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pan-setup-iteration-"));
  const gh = new IterationConnectGh();
  try {
    await assert.rejects(
      setupPanDomain(
        {
          repository: "example/domain",
          repositoryMode: "create",
          path: path.join(root, "domain"),
          projectOwner: "example",
          projectMode: "connect",
          projectNumber: 9,
          approvalMode: "prompt",
        },
        {
          gh,
          commands: new FakeCommands(),
          hostname: "machine",
          ask: assert.fail,
        },
      ),
      /requirements has an incompatible type/,
    );
    assert.equal(
      gh.calls.some(
        (args) =>
          args[0] === "repo" && ["create", "clone"].includes(args[1]),
      ),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("preflights every page of connected Project fields", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pan-setup-paged-"));
  const gh = new PagedConnectGh();
  try {
    const result = await setupPanDomain(
      {
        repository: "example/domain",
        repositoryMode: "connect",
        path: path.join(root, "domain"),
        projectOwner: "example",
        projectMode: "connect",
        projectNumber: 9,
        approvalMode: "prompt",
      },
      {
        gh,
        commands: new FakeCommands(),
        hostname: "machine",
        ask: assert.fail,
      },
    );

    assert.equal(result.projectNumber, 9);
    assert.equal(
      gh.calls.filter((args) => args[0] === "api" && args[1] === "graphql").length,
      2,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refuses to overwrite an existing local path before remote mutation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pan-setup-existing-"));
  const gh = new FakeGh();
  try {
    await assert.rejects(
      setupPanDomain(
        {
          repository: "example/domain",
          path: root,
          projectOwner: "example",
          projectTitle: "PAN",
          approvalMode: "prompt",
        },
        {
          gh,
          commands: new FakeCommands(),
          hostname: "machine",
          ask: assert.fail,
        },
      ),
      /Local clone path already exists/,
    );
    assert.deepEqual(gh.calls, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reports asset installation failure after preserving the bootstrapped domain", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pan-setup-assets-"));
  const directory = path.join(root, "domain");
  const gh = new FakeGh();
  const commands = new FakeCommands();
  try {
    const result = await setupPanDomain(
      {
        repository: "example/domain",
        path: directory,
        projectOwner: "example",
        projectTitle: "PAN",
        approvalMode: "prompt",
        installAssets: true,
      },
      {
        gh,
        commands,
        hostname: "machine",
        ask: assert.fail,
        assetServiceFactory: () => ({
          install: async () => {
            throw new Error("asset conflict");
          },
        }),
      },
    );

    assert.equal(result.assets.status, "failed");
    assert.match(result.assets.diagnostics[0], /asset conflict/);
    assert.equal((await readFile(result.configPath, "utf8")).length > 0, true);
    assert.ok(commands.calls.some(({ args }) => args[2] === "push"));
    assert.ok(gh.calls.some((args) => args[0] === "repo" && args[1] === "create"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

class FakeGh {
  constructor() {
    this.calls = [];
  }

  async run(args) {
    this.calls.push(args);
    if (args[0] === "repo" && args[1] === "clone") {
      await mkdir(args[3], { recursive: true });
    }
    return "";
  }

  async runJson(args) {
    this.calls.push(args);
    if (args[0] === "project" && args[1] === "create") {
      return {
        id: "project-7",
        number: 7,
        url: "https://github.com/users/example/projects/7",
      };
    }
    if (args[0] === "api" && args[1] === "graphql") {
      return projectFieldsPage([
        {
          __typename: "ProjectV2SingleSelectField",
          id: "status-id",
          name: "Status",
          options: [],
        },
      ]);
    }
    assert.fail(`Unexpected gh JSON call: ${args.join(" ")}`);
  }
}

class FakeCommands {
  constructor() {
    this.calls = [];
  }

  async run(executable, args) {
    this.calls.push({ executable, args });
    return "";
  }
}

class ExistingDomainCommands extends FakeCommands {
  constructor(directory, { dirty = "", failPushOnce = false } = {}) {
    super();
    this.directory = directory;
    this.dirty = dirty;
    this.failPushOnce = failPushOnce;
    this.pendingPush = false;
  }

  async run(executable, args) {
    this.calls.push({ executable, args });
    if (args[2] === "rev-parse") {
      return `${this.directory}\n`;
    }
    if (args[2] === "remote") {
      return "https://github.com/example/domain.git\n";
    }
    if (args[2] === "status") {
      if (args.includes("--porcelain=v2")) {
        return this.pendingPush
          ? "# branch.upstream origin/main\n# branch.ab +1 -0\n"
          : "# branch.upstream origin/main\n# branch.ab +0 -0\n";
      }
      return this.dirty;
    }
    if (args[2] === "log") {
      return this.pendingPush ? "Bootstrap PAN domain\n" : "";
    }
    if (args[2] === "commit") {
      this.pendingPush = true;
    }
    if (args[2] === "push") {
      if (this.failPushOnce) {
        this.failPushOnce = false;
        throw new Error("push failed");
      }
      this.pendingPush = false;
    }
    return "";
  }
}

class ConnectGh extends FakeGh {
  async run(args) {
    this.calls.push(args);
    if (args[0] === "repo" && args[1] === "clone") {
      await mkdir(args[3], { recursive: true });
      await writeFile(path.join(args[3], "README.md"), "# Existing\n");
    }
    return "";
  }

  async runJson(args) {
    this.calls.push(args);
    if (args[0] === "repo" && args[1] === "view") {
      return { nameWithOwner: "example/domain", isPrivate: true };
    }
    if (args[0] === "project" && args[1] === "view") {
      return {
        id: "project-9",
        number: 9,
        url: "https://github.com/users/example/projects/9",
      };
    }
    if (args[0] === "api" && args[1] === "graphql") {
      const manifest = JSON.parse(
        await readFile(
          new URL("../schema/project-fields.json", import.meta.url),
          "utf8",
        ),
      );
      return projectFieldsPage(
        manifest.fields.map((field) => ({
          __typename:
            field.type === "single_select"
              ? "ProjectV2SingleSelectField"
              : "ProjectV2Field",
          id: `field-${field.key}`,
          name: field.name,
          dataType: field.type === "text" ? "TEXT" : undefined,
          options: (field.options ?? []).map((name) => ({ name })),
        })),
      );
    }
    assert.fail(`Unexpected gh JSON call: ${args.join(" ")}`);
  }
}

class IncompatibleConnectGh extends ConnectGh {
  async runJson(args) {
    const result = await super.runJson(args);
    if (args[0] === "api" && args[1] === "graphql") {
      const requirements = result.data.node.fields.nodes.find(
        (field) => field.name === "requirements",
      );
      requirements.dataType = "NUMBER";
    }
    return result;
  }
}

class PagedConnectGh extends ConnectGh {
  async runJson(args) {
    const result = await super.runJson(args);
    if (args[0] !== "api" || args[1] !== "graphql") {
      return result;
    }
    const nodes = result.data.node.fields.nodes;
    const secondPage = args.includes("cursor=page-2");
    return {
      data: {
        node: {
          fields: {
            nodes: secondPage ? nodes.slice(4) : nodes.slice(0, 4),
            pageInfo: {
              hasNextPage: !secondPage,
              endCursor: secondPage ? null : "page-2",
            },
          },
        },
      },
    };
  }
}

class IterationConnectGh extends ConnectGh {
  async runJson(args) {
    const result = await super.runJson(args);
    if (args[0] === "api" && args[1] === "graphql") {
      const requirements = result.data.node.fields.nodes.find(
        (field) => field.name === "requirements",
      );
      requirements.__typename = "ProjectV2IterationField";
      requirements.dataType = "ITERATION";
    }
    return result;
  }
}

function projectFieldsPage(nodes) {
  return {
    data: {
      node: {
        fields: {
          nodes,
          pageInfo: {
            hasNextPage: false,
            endCursor: null,
          },
        },
      },
    },
  };
}
