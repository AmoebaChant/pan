import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  GitHubDomainConfigStore,
  loadDomainConfig,
  writeMachineDomainConfig,
} from "../src/index.js";

test("reads and updates shared pan.json with the current blob SHA", async () => {
  const document = sharedConfig();
  const gh = new ConfigGh(document);
  const store = new GitHubDomainConfigStore({
    repository: "example/domain",
    gh,
  });

  const current = await store.read();
  const updated = await store.write(
    {
      ...current.document,
      scheduling: {
        ...current.document.scheduling,
        enabled: true,
      },
    },
    { expectedSha: current.sha },
  );

  assert.equal(current.sha, "sha-1");
  assert.equal(updated.sha, "sha-2");
  assert.ok(gh.putArgs.includes("sha=sha-1"));
  assert.equal(
    JSON.parse(
      Buffer.from(valueAfter(gh.putArgs, "content"), "base64").toString("utf8"),
    ).scheduling.enabled,
    true,
  );
});

test("loads shared configuration through a machine-local repository locator", async (t) => {
  const root = path.resolve(`.machine-domain-${Date.now()}`);
  const configPath = path.join(root, "pan-local.json");
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(root);
  await writeMachineDomainConfig(configPath, {
    version: 1,
    kind: "pan-machine",
    domain: { repository: "example/domain" },
    session: {
      agent: { executable: "custom-copilot" },
      productContextRoots: [
        { label: "product", path: path.resolve("product") },
      ],
    },
  });

  const config = await loadDomainConfig(configPath, {
    gh: new ConfigGh(sharedConfig()),
  });

  assert.equal(config.version, 3);
  assert.equal(config.domain.projectNumber, 12);
  assert.equal(config.domain.path, root);
  assert.equal(config.session.agent.executable, "custom-copilot");
  assert.equal(config.scheduling.triageAuthority, "report");
  assert.equal(config.sharedConfigSha, "sha-1");
});

test("normalizes legacy checkout configuration for an API-only upgrade", async () => {
  const legacy = {
    version: 2,
    domain: {
      repository: "example/domain",
      projectOwner: "example",
      projectNumber: 12,
    },
    session: {
      agent: { name: "pan", executable: "custom-copilot" },
      productContextRoots: [
        { label: "product", path: path.resolve("product") },
      ],
    },
    scheduling: { enabled: false, triageAuthority: "triage-fields" },
  };

  const result = await new GitHubDomainConfigStore({
    repository: "example/domain",
    gh: new ConfigGh(legacy),
  }).read();

  assert.equal(result.requiresUpgrade, true);
  assert.equal(result.document.version, 3);
  assert.equal(result.document.policy.triageAuthority, "triage-fields");
  assert.equal(result.machineDefaults.agent.executable, "custom-copilot");
  assert.equal(result.machineDefaults.productContextRoots.length, 1);
});

test("rejects writing shared config to a different repository", async () => {
  const store = new GitHubDomainConfigStore({
    repository: "example/domain",
    gh: new ConfigGh(sharedConfig()),
  });

  await assert.rejects(
    store.write({
      ...sharedConfig(),
      domain: {
        ...sharedConfig().domain,
        repository: "other/domain",
      },
    }),
    /identifies other\/domain/,
  );
});

function sharedConfig() {
  return {
    version: 3,
    domain: {
      repository: "example/domain",
      projectOwner: "example",
      projectNumber: 12,
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
}

class ConfigGh {
  constructor(document) {
    this.document = document;
  }

  async runJson(args) {
    if (args.includes("--method") && args.includes("PUT")) {
      this.putArgs = args;
      return { content: { sha: "sha-2" }, commit: { sha: "commit-2" } };
    }
    return {
      sha: "sha-1",
      path: "pan.json",
      content: Buffer.from(
        `${JSON.stringify(this.document, null, 2)}\n`,
      ).toString("base64"),
    };
  }
}

function valueAfter(args, prefix) {
  const entry = args.find((value) => value.startsWith(`${prefix}=`));
  return entry?.slice(prefix.length + 1);
}
