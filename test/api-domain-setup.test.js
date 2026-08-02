import assert from "node:assert/strict";
import { readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { setupPanDomain } from "../src/index.js";

async function readWrittenRunnerProfile(root) {
  const runnersDirectory = path.join(root, "runners");
  const [entry] = await readdir(runnersDirectory);
  return JSON.parse(
    await readFile(path.join(runnersDirectory, entry), "utf8"),
  );
}

test("writes a macOS terminal-app runner profile on darwin", async (t) => {
  const root = path.resolve(`.api-domain-darwin-${Date.now()}`);
  t.after(() => rm(root, { recursive: true, force: true }));

  await setupPanDomain(
    {
      repository: "example/domain",
      projectOwner: "example",
      localConfigPath: path.join(root, "pan-local.json"),
      approvalMode: "prompt",
    },
    {
      gh: new SetupGh(),
      hostname: "Machine A",
      env: { LOCALAPPDATA: path.join(root, "local") },
      platform: "darwin",
    },
  );

  const runner = await readWrittenRunnerProfile(root);
  assert.equal(runner.terminal.type, "terminal-app");
});

test("writes a Windows Terminal runner profile on win32", async (t) => {
  const root = path.resolve(`.api-domain-win32-${Date.now()}`);
  t.after(() => rm(root, { recursive: true, force: true }));

  await setupPanDomain(
    {
      repository: "example/domain",
      projectOwner: "example",
      localConfigPath: path.join(root, "pan-local.json"),
      approvalMode: "prompt",
    },
    {
      gh: new SetupGh(),
      hostname: "Machine A",
      env: { LOCALAPPDATA: path.join(root, "local") },
      platform: "win32",
    },
  );

  const runner = await readWrittenRunnerProfile(root);
  assert.equal(runner.terminal.type, "windows-terminal");
});

test("sets up a domain through GitHub APIs without cloning it", async (t) => {
  const root = path.resolve(`.api-domain-setup-${Date.now()}`);
  const configPath = path.join(root, "pan-local.json");
  const gh = new SetupGh();
  t.after(() => rm(root, { recursive: true, force: true }));

  const result = await setupPanDomain(
    {
      repository: "example/domain",
      projectOwner: "example",
      projectTitle: "Personal Pan",
      localConfigPath: configPath,
      approvalMode: "prompt",
    },
    {
      gh,
      hostname: "Machine A",
      env: { LOCALAPPDATA: path.join(root, "local") },
    },
  );

  assert.equal(result.apiOnly, true);
  assert.equal(result.sharedConfigSha, "config-sha");
  assert.equal(
    gh.calls.some(
      (args) => args[0] === "repo" && args[1] === "clone",
    ),
    false,
  );
  assert.equal(
    gh.calls.some(
      (args) => args[0] === "label" && args[1] === "create",
    ),
    false,
  );
  const local = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(local.kind, "pan-machine");
  assert.equal(local.domain.repository, "example/domain");
  const shared = JSON.parse(
    Buffer.from(valueAfter(gh.putArgs, "content"), "base64").toString("utf8"),
  );
  assert.equal(shared.version, 3);
  assert.equal(shared.domain.projectNumber, 7);

  const second = await setupPanDomain(
    {
      repository: "example/domain",
      projectOwner: "example",
      localConfigPath: configPath,
      approvalMode: "prompt",
    },
    {
      gh,
      hostname: "Machine A",
      env: { LOCALAPPDATA: path.join(root, "local") },
    },
  );
  assert.equal(second.projectMode, "connect");
  assert.equal(
    gh.calls.filter(
      (args) => args[0] === "repo" && args[1] === "create",
    ).length,
    1,
  );
  assert.equal(
    gh.calls.filter(
      (args) => args[0] === "project" && args[1] === "create",
    ).length,
    1,
  );
  assert.equal(
    gh.calls.filter(
      (args) => args[0] === "label" && args[1] === "create",
    ).length,
    0,
  );
});

test("treats gh GraphQL 'Could not resolve' as repository-not-found and creates it", async (t) => {
  const root = path.resolve(`.api-domain-notfound-${Date.now()}`);
  t.after(() => rm(root, { recursive: true, force: true }));
  const gh = new SetupGh();
  // Real gh emits this for a missing repo instead of an HTTP 404 string.
  gh.repoNotFoundError =
    "GraphQL: Could not resolve to a Repository with the name 'example/domain'. (repository)";

  await setupPanDomain(
    {
      repository: "example/domain",
      projectOwner: "example",
      localConfigPath: path.join(root, "pan-local.json"),
      approvalMode: "prompt",
    },
    { gh, hostname: "Machine A", env: { LOCALAPPDATA: path.join(root, "local") } },
  );

  assert.ok(
    gh.calls.some(
      (args) =>
        args[0] === "repo" && args[1] === "create" && args.includes("--private"),
    ),
    "expected the repository to be created after a GraphQL not-found",
  );
});

test("replaces the built-in Status field options instead of deleting it", async (t) => {
  const root = path.resolve(`.api-domain-status-${Date.now()}`);
  t.after(() => rm(root, { recursive: true, force: true }));
  const gh = new SetupGh();

  await setupPanDomain(
    {
      repository: "example/domain",
      projectOwner: "example",
      localConfigPath: path.join(root, "pan-local.json"),
      approvalMode: "prompt",
    },
    { gh, hostname: "Machine A", env: { LOCALAPPDATA: path.join(root, "local") } },
  );

  // The built-in Status field cannot be deleted; it must be updated in place.
  assert.equal(
    gh.calls.some((args) => args[0] === "project" && args[1] === "field-delete"),
    false,
    "must not attempt to delete the built-in Status field",
  );
  assert.ok(
    gh.calls.some(
      (args) =>
        args[0] === "api" &&
        args[1] === "graphql" &&
        args.some(
          (arg) => typeof arg === "string" && arg.includes("updateProjectV2Field"),
        ),
    ),
    "expected an updateProjectV2Field mutation to replace the Status options",
  );
});

test("rejects a shared config for a different repository before mutation", async () => {
  const gh = new SetupGh();
  gh.repositoryExists = true;
  gh.configDocument = {
    version: 3,
    domain: {
      repository: "other/domain",
      projectOwner: "example",
      projectNumber: 7,
    },
    agent: { name: "pan" },
    scheduling: {
      enabled: false,
      startup: "immediate",
      reviewIntervalSeconds: 86400,
      retrySeconds: 60,
      rateLimitRetrySeconds: 900,
    },
    policy: { triageAuthority: "report" },
  };

  await assert.rejects(
    setupPanDomain(
      { repository: "example/domain" },
      { gh, hostname: "Machine A" },
    ),
    /conflicts with requested repository/,
  );
  assert.equal(
    gh.calls.some(
      (args) =>
        (args[0] === "project" && args[1] === "link") ||
        (args[0] === "label" && args[1] === "create"),
    ),
    false,
  );
});

test("cleans up a newly created Project when initial config persistence fails", async (t) => {
  const root = path.resolve(`.api-domain-cleanup-${Date.now()}`);
  t.after(() => rm(root, { recursive: true, force: true }));
  const gh = new SetupGh();
  gh.failConfigWrite = true;

  await assert.rejects(
    setupPanDomain(
      {
        repository: "example/domain",
        localConfigPath: path.join(root, "pan-local.json"),
      },
      { gh, hostname: "Machine A" },
    ),
    /config write failed/,
  );

  assert.ok(
    gh.calls.some(
      (args) =>
        args[0] === "project" &&
        args[1] === "delete" &&
        args.includes("--confirm"),
    ),
  );
});

test("requires Project write access during setup", async () => {
  const gh = new SetupGh();
  gh.oauthScopes = "repo, read:project";

  await assert.rejects(
    setupPanDomain(
      { repository: "example/domain" },
      { gh, hostname: "Machine A" },
    ),
    /Projects read\/write access/,
  );
});

class SetupGh {
  constructor() {
    this.calls = [];
  }

  async run(args) {
    this.calls.push(args);
    if (args[0] === "api" && args[1] === "user") {
      return `HTTP/2 200\nx-oauth-scopes: ${this.oauthScopes ?? "repo, project"}\n\n{}`;
    }
    if (args[0] === "repo" && args[1] === "create") {
      this.repositoryExists = true;
    }
    return "";
  }

  async runJson(args) {
    this.calls.push(args);
    if (args[0] === "repo" && args[1] === "view") {
      if (!this.repositoryExists) {
        throw new Error(this.repoNotFoundError ?? "HTTP 404: not found");
      }
      return { nameWithOwner: "example/domain", isPrivate: true };
    }
    const endpoint = args.find((arg) => arg.startsWith("repos/"));
    if (endpoint === "repos/example/domain/contents/pan.json") {
      if (args.includes("PUT")) {
        if (this.failConfigWrite) {
          throw new Error("config write failed");
        }
        this.putArgs = args;
        this.configDocument = JSON.parse(
          Buffer.from(valueAfter(args, "content"), "base64").toString("utf8"),
        );
        return {
          content: { sha: "config-sha" },
          commit: { sha: "commit-sha" },
        };
      }
      if (this.configDocument) {
        return {
          sha: "config-sha",
          content: Buffer.from(
            `${JSON.stringify(this.configDocument, null, 2)}\n`,
          ).toString("base64"),
        };
      }
      throw new Error("HTTP 404: not found");
    }
    if (args[0] === "project" && args[1] === "create") {
      return {
        id: "project-id",
        number: 7,
        url: "https://github.com/users/example/projects/7",
      };
    }
    if (args[0] === "project" && args[1] === "view") {
      return {
        id: "project-id",
        number: 7,
        url: "https://github.com/users/example/projects/7",
      };
    }
    if (args[0] === "api" && args[1] === "graphql") {
      if (this.configDocument) {
        return {
          data: {
            node: {
              fields: {
                nodes: projectFields(),
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        };
      }
      return {
        data: {
          node: {
            fields: {
              nodes: [
                {
                  __typename: "ProjectV2SingleSelectField",
                  id: "status-id",
                  name: "Status",
                  options: [{ name: "Todo" }],
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      };
    }

    function projectFields() {
      const selects = {
        owner: ["unassigned", "human", "agent"],
        Status: [
          "untriaged",
          "needs-detail",
          "ready",
          "in-progress",
          "in-review",
          "done",
          "blocked",
        ],
        priority: ["urgent", "high", "normal", "low"],
      };
      return [
        ...Object.entries(selects).map(([name, options]) => ({
          __typename: "ProjectV2SingleSelectField",
          id: `field-${name}`,
          name,
          options: options.map((option) => ({ name: option })),
        })),
        ...[
          "requirements",
          "needs-human-since",
          "lease-until",
          "claimed-by",
          "workstream",
        ].map((name) => ({
          __typename: "ProjectV2Field",
          id: `field-${name}`,
          name,
          dataType: "TEXT",
        })),
      ];
    }
    throw new Error(`Unexpected gh JSON call: ${args.join(" ")}`);
  }
}

function valueAfter(args, prefix) {
  const entry = args.find((value) => value.startsWith(`${prefix}=`));
  return entry?.slice(prefix.length + 1);
}
