import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(`.stateless-helper-integration-${randomUUID()}`);
const fixturePath = fileURLToPath(new URL("./fixtures/fake-gh.js", import.meta.url));
const cliPath = path.resolve("bin/pan.js");

test.after(async () => {
  await rm(root, { recursive: true, force: true });
});

test("configuration helpers reload and migrate the configured file in separate processes", async () => {
  const fixture = await createFixture({ version: 1 });

  const read = fixture.run(["config", "read"]);
  assertEnvelope(read, 0, "confirmed", "config.read");
  assert.equal(read.result.data.config.version, 2);

  const validated = fixture.run(["config", "validate"]);
  assertEnvelope(validated, 0, "confirmed", "config.validate");

  const migrated = fixture.run(["config", "migrate"]);
  assertEnvelope(migrated, 0, "confirmed", "config.migrate");
  assert.equal(JSON.parse(await readFile(fixture.configPath, "utf8")).version, 2);
});

test("evidence helpers exclude pull requests and surface incomplete pagination from fresh state", async () => {
  const fixture = await createFixture();

  const complete = fixture.run(["evidence", "issues"]);
  assertEnvelope(complete, 0, "confirmed", "evidence.issues");
  assert.equal(complete.result.snapshot.excludedPullRequests, 2);

  await fixture.updateState((state) => {
    state.failPagination = true;
  });
  const incomplete = fixture.run(["evidence", "issues"]);
  assertEnvelope(incomplete, 1, "incomplete", "evidence.issues");
  assert.match(incomplete.result.diagnostics.join("\n"), /pagination failure/i);
});

test("leadership helpers reject contention and stale generations across independent processes", async () => {
  const fixture = await createFixture();
  const leader = leadershipEnvironment("session-a", "generation-a");
  const replacement = leadershipEnvironment("session-b", "generation-b");

  assertEnvelope(fixture.run(["leadership", "acquire"], leader), 0, "confirmed", "leadership.acquire");
  assertEnvelope(fixture.run(["leadership", "assert"], leader), 0, "confirmed", "leadership.assert");
  assert.equal(typeof (await fixture.readState()).leader.content, "string");
  const contended = fixture.run(["leadership", "acquire"], replacement);
  assertEnvelope(contended, 1, "rejected", "leadership.acquire");

  assertEnvelope(fixture.run(["leadership", "release"], leader), 0, "confirmed", "leadership.release");
  assertEnvelope(fixture.run(["leadership", "acquire"], replacement), 0, "confirmed", "leadership.acquire");
  assertEnvelope(fixture.run(["leadership", "assert"], leader), 1, "rejected", "leadership.assert");
});

test("mutation helpers fail safely without a session identity and create no host artifact", async () => {
  const fixture = await createFixture();
  const cases = [
    [["action", "apply", "--action-file", fixture.actionPath], "action.apply"],
    [["attention", "add", "Synthetic attention"], "attention.add"],
    [["reconcile", "missing-issues", "--apply"], "reconcile.missing-issues"],
    [["reconcile", "merged-prs", "--apply"], "reconcile.merged-prs"],
    [["workstream", "prepare", "synthetic"], "workstream.prepare"],
  ];

  for (const [command, operation] of cases) {
    assertEnvelope(fixture.run(command), 1, "failed", operation);
  }
  assert.deepEqual((await fixture.entries()).sort(), ["action.json", "domain", "gh-state.json", "pan.json"]);
});

async function createFixture({ version = 2 } = {}) {
  const directory = path.join(root, randomUUID());
  const domainPath = path.join(directory, "domain");
  const configPath = path.join(directory, "pan.json");
  const statePath = path.join(directory, "gh-state.json");
  const actionPath = path.join(directory, "action.json");
  await mkdir(domainPath, { recursive: true });
  await writeFile(configPath, JSON.stringify(domainConfig({ version, domainPath })));
  await writeFile(actionPath, "{}");
  await writeFile(statePath, JSON.stringify({
    issues: [],
  }));
  return {
    actionPath,
    configPath,
    async updateState(update) {
      const state = JSON.parse(await readFile(statePath, "utf8"));
      update(state);
      await writeFile(statePath, JSON.stringify(state));
    },
    async readState() {
      return JSON.parse(await readFile(statePath, "utf8"));
    },
    async entries() {
      return readdir(directory);
    },
    run(command, environment = {}) {
      const invocation = spawnSync(
        process.execPath,
        [
          cliPath,
          ...command,
          "--schema-version",
          "1",
          "--config",
          configPath,
          "--json",
        ],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          env: {
            ...process.env,
            ...environment,
            PAN_FAKE_GH_STATE: statePath,
            PAN_FAKE_OPERATION: command.slice(0, 2).join("."),
            PAN_FAKE_RUN_ID: randomUUID(),
            PAN_GH_EXECUTABLE: process.execPath,
            PAN_GH_EXECUTABLE_ARGS: JSON.stringify([fixturePath]),
          },
        },
      );
      assert.equal(invocation.error, undefined);
      assert.notEqual(invocation.stdout.trim(), "", invocation.stderr);
      assert.equal(invocation.stdout.trim().split(/\r?\n/).length, 1);
      return {
        status: invocation.status,
        result: JSON.parse(invocation.stdout),
        stderr: invocation.stderr,
      };
    },
  };
}

function domainConfig({ version, domainPath }) {
  const shared = {
    domain: {
      repository: "example/domain",
      projectOwner: "example",
      projectNumber: 1,
      path: domainPath,
    },
    state: { branch: "pan-state", path: ".pan" },
  };
  return version === 1
    ? {
        ...shared,
        version,
        agent: { name: "pan" },
      }
    : {
        ...shared,
        version,
        session: { agent: { name: "pan" } },
      };
}

function leadershipEnvironment(sessionId, generation) {
  return {
    PAN_SESSION_ID: sessionId,
    PAN_LEADERSHIP_HOLDER: sessionId,
    PAN_LEADERSHIP_GENERATION: generation,
  };
}

function assertEnvelope(actual, status, resultStatus, operation) {
  assert.equal(
    actual.status,
    status,
    `${actual.stderr}\n${JSON.stringify(actual.result)}`,
  );
  assert.equal(actual.result.status, resultStatus, JSON.stringify(actual.result));
  assert.equal(actual.result.operation, operation);
  assert.equal(actual.result.version, 1);
  assert.deepEqual(actual.result.domain, {
    repository: "example/domain",
    projectOwner: "example",
    projectNumber: 1,
  });
}
