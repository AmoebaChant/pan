import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { ProcessClient } from "../src/process-client.js";
import { WorkstreamDeliveryService } from "../src/workstream-delivery.js";

const run = promisify(execFile);

export const TEST_REPOSITORY = "example/domain";

export async function createWorkstreamGitFixture(t) {
  const root = await mkdtemp(path.join(process.cwd(), "workstream-delivery-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const seed = path.join(root, "seed");
  const remote = path.join(root, "remote.git");
  const domain = path.join(root, "domain");
  await git(root, ["init", "--bare", "--initial-branch=main", remote]);
  await git(root, ["init", "-b", "main", seed]);
  await configureIdentity(seed);
  await mkdir(path.join(seed, "workstreams", "existing"), { recursive: true });
  await writeFile(
    path.join(seed, "workstreams", "existing", "README.md"),
    "# Existing\n\nInitial.\n",
  );
  await writeFile(path.join(seed, ".gitignore"), "generated/\n");
  await writeFile(path.join(seed, "unrelated.txt"), "original\n");
  await git(seed, ["add", "."]);
  await git(seed, ["commit", "-m", "Initial workstream"]);
  await git(seed, ["remote", "add", "origin", remote]);
  await git(seed, ["push", "-u", "origin", "main"]);
  await git(root, ["clone", remote, domain]);
  await configureIdentity(domain);

  return {
    root,
    seed,
    remote,
    domain,
    operations: path.join(root, "operations"),
    commands: {
      async run(executable, args, options) {
        if (args.at(-2) === "get-url" && args.at(-1) === "origin") {
          return "https://github.com/example/domain.git";
        }
        return new ProcessClient().run(executable, args, options);
      },
    },
  };
}

export function createWorkstreamDeliveryService(fixture, options = {}) {
  return new WorkstreamDeliveryService({
    repositoryPath: fixture.domain,
    repository: TEST_REPOSITORY,
    commands: fixture.commands,
    operationDirectory: fixture.operations,
    operationIdFactory: () => "operation-1",
    now: () => new Date("2026-07-22T16:00:00.000Z"),
    ...options,
  });
}

export async function configurePushRejection(fixture) {
  const hook = path.join(fixture.remote, "hooks", "pre-receive");
  await writeFile(hook, "#!/bin/sh\necho PAN test rejection >&2\nexit 1\n");
  await chmod(hook, 0o755);
  return hook;
}

export async function configureIdentity(directory) {
  await git(directory, ["config", "user.name", "PAN Test"]);
  await git(directory, ["config", "user.email", "pan@example.invalid"]);
}

export async function git(cwd, args) {
  const { stdout } = await run("git", args, { cwd, windowsHide: true });
  return stdout.trim();
}
