import assert from "node:assert/strict";
import test from "node:test";

import { DomainIdentity } from "../src/index.js";

test("validates the configured domain, GitHub identity, and Project schema", async () => {
  const commands = {
    async run(executable, args) {
      assert.equal(executable, "git");
      if (args.includes("rev-parse")) {
        return "C:\\domains\\example";
      }
      if (args.includes("remote")) {
        return "git@github.com:example/domain.git";
      }
      if (args.includes("ls-remote")) {
        return "ref: refs/heads/main\tHEAD\n012345\tHEAD";
      }
      assert.fail(`Unexpected git command: ${args.join(" ")}`);
    },
  };
  const gh = {
    async run(args) {
      if (args[0] === "auth") {
        return "Logged in to github.com";
      }
      assert.deepEqual(args, ["api", "repos/example/domain", "--jq", ".default_branch"]);
      return "main";
    },
  };
  let schemaOptions;
  const identity = new DomainIdentity({
    commands,
    gh,
    statImpl: async () => ({ isDirectory: () => true }),
    realpathImpl: async (value) => value,
    storeFactory: (options) => {
      schemaOptions = options;
      return { getSchema: async () => ({ projectId: "PVT_test" }) };
    },
  });

  const result = await identity.validate(config());

  assert.equal(result.domain.defaultBranch, "main");
  assert.equal(result.project.id, "PVT_test");
  assert.deepEqual(schemaOptions, {
    repository: "example/domain",
    projectOwner: "example",
    projectNumber: 12,
    gh,
  });
});

test("rejects a clone whose origin identifies another GitHub repository", async () => {
  const identity = new DomainIdentity({
    commands: {
      async run(_executable, args) {
        if (args.includes("rev-parse")) {
          return "C:\\domains\\example";
        }
        return "https://github.com/example/other.git";
      },
    },
    gh: { run: async () => assert.fail("GitHub must not be contacted") },
    statImpl: async () => ({ isDirectory: () => true }),
    realpathImpl: async (value) => value,
  });

  await assert.rejects(identity.validate(config()), /origin is example\/other, expected example\/domain/);
});

test("rejects a remote whose advertised default branch conflicts with GitHub", async () => {
  const identity = new DomainIdentity({
    commands: {
      async run(_executable, args) {
        if (args.includes("rev-parse")) {
          return "C:\\domains\\example";
        }
        if (args.includes("remote")) {
          return "git@github.com:example/domain.git";
        }
        return "ref: refs/heads/master\tHEAD";
      },
    },
    gh: {
      async run(args) {
        return args[0] === "auth" ? "ok" : "main";
      },
    },
    statImpl: async () => ({ isDirectory: () => true }),
    realpathImpl: async (value) => value,
    storeFactory: () => ({ getSchema: async () => ({ projectId: "PVT_test" }) }),
  });

  await assert.rejects(identity.validate(config()), /default branch is master, expected main/);
});

function config() {
  return {
    domain: {
      repository: "example/domain",
      projectOwner: "example",
      projectNumber: 12,
      path: "C:\\domains\\example",
    },
    session: {
      agent: { name: "pan", executable: "copilot" },
      productContextRoots: [],
    },
  };
}
