import assert from "node:assert/strict";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  configurePushRejection,
  createWorkstreamDeliveryService,
  createWorkstreamGitFixture,
  git,
} from "./git-fixture.js";

test("prepares from the freshly fetched remote branch while preserving a dirty checkout", async (t) => {
  const fixture = await createWorkstreamGitFixture(t);
  await writeFile(
    path.join(fixture.seed, "workstreams", "existing", "README.md"),
    "# Existing\n\nRemote advance.\n",
  );
  await git(fixture.seed, ["add", "workstreams/existing/README.md"]);
  await git(fixture.seed, ["commit", "-m", "Remote advance"]);
  await git(fixture.seed, ["push", "origin", "main"]);

  const staged = path.join(fixture.domain, "staged.txt");
  const modified = path.join(fixture.domain, "unrelated.txt");
  const untracked = path.join(fixture.domain, "untracked.txt");
  await writeFile(staged, "staged\n");
  await git(fixture.domain, ["add", "staged.txt"]);
  await writeFile(modified, "modified\n");
  await writeFile(untracked, "untracked\n");
  const before = {
    cached: await git(fixture.domain, ["diff", "--cached", "--binary"]),
    unstaged: await git(fixture.domain, ["diff", "--binary"]),
    status: await git(fixture.domain, ["status", "--porcelain=v2"]),
    files: await Promise.all([readFile(staged), readFile(modified), readFile(untracked)]),
  };

  const result = await createWorkstreamDeliveryService(fixture).prepare({
    workstream: "existing",
    sessionId: "session-1",
    rationale: "Refresh current status.",
    sourceTurn: "turn-1",
  });

  assert.equal(result.status, "confirmed");
  assert.equal(
    result.receipt.target.baseCommit,
    await git(fixture.domain, ["rev-parse", "origin/main"]),
  );
  assert.match(await readFile(result.receipt.filePath, "utf8"), /Remote advance/);
  assert.equal(await git(result.receipt.workspace, ["branch", "--show-current"]), "");
  assert.deepEqual(
    {
      cached: await git(fixture.domain, ["diff", "--cached", "--binary"]),
      unstaged: await git(fixture.domain, ["diff", "--binary"]),
      status: await git(fixture.domain, ["status", "--porcelain=v2"]),
      files: await Promise.all([readFile(staged), readFile(modified), readFile(untracked)]),
    },
    before,
  );
});

test("publishes exactly one attributable commit to the default branch without a side branch", async (t) => {
  const fixture = await createWorkstreamGitFixture(t);
  const service = createWorkstreamDeliveryService(fixture);
  const prepared = await service.prepare({
    workstream: "existing",
    sessionId: "session-1",
    rationale: "Record the durable delivery outcome.",
    sourceTurn: "turn-1",
  });
  await writeFile(prepared.receipt.filePath, "# Existing\n\nPublished.\n");

  const published = await service.publish({
    operationId: prepared.receipt.operationId,
    sessionId: "session-1",
  });

  assert.equal(published.status, "confirmed", JSON.stringify(published));
  assert.equal(published.commitCreated.sha, published.pushConfirmed.sha);
  assert.equal(
    await git(fixture.root, [
      "--git-dir",
      fixture.remote,
      "show",
      "main:workstreams/existing/README.md",
    ]),
    "# Existing\n\nPublished.",
  );
  assert.equal(
    await git(fixture.root, [
      "--git-dir",
      fixture.remote,
      "show",
      "-s",
      "--format=%P",
      published.pushConfirmed.sha,
    ]),
    prepared.receipt.target.baseCommit,
  );
  assert.deepEqual(
    (await git(fixture.root, [
      "--git-dir",
      fixture.remote,
      "show",
      "--format=",
      "--name-only",
      published.pushConfirmed.sha,
    ])).split(/\r?\n/).filter(Boolean),
    ["workstreams/existing/README.md"],
  );
  assert.match(
    await git(fixture.root, [
      "--git-dir",
      fixture.remote,
      "show",
      "-s",
      "--format=%B",
      published.pushConfirmed.sha,
    ]),
    /PAN-Workstream-Operation: operation-1/,
  );
  assert.deepEqual(
    (await git(fixture.root, [
      "--git-dir",
      fixture.remote,
      "for-each-ref",
      "--format=%(refname:short)",
      "refs/heads",
    ])).split(/\r?\n/).filter(Boolean),
    ["main"],
  );
  await assert.rejects(access(prepared.receipt.workspace));

  const retried = await service.publish({
    operationId: prepared.receipt.operationId,
    sessionId: "session-1",
  });
  assert.equal(retried.status, "confirmed");
  assert.equal(retried.commitCreated.sha, published.commitCreated.sha);
  assert.equal(
    await git(fixture.root, ["--git-dir", fixture.remote, "rev-list", "--count", "main"]),
    "2",
  );
});

test("creates a new workstream README as the only file in its direct delivery", async (t) => {
  const fixture = await createWorkstreamGitFixture(t);
  const service = createWorkstreamDeliveryService(fixture);
  const prepared = await service.prepare({
    workstream: "new/child",
    sessionId: "session-1",
  });

  assert.equal(prepared.receipt.workstream.expectedAbsent, true);
  await writeFile(prepared.receipt.filePath, "# New child\n");
  const published = await service.publish({
    operationId: prepared.receipt.operationId,
    sessionId: "session-1",
  });

  assert.equal(published.status, "confirmed", JSON.stringify(published));
  assert.equal(
    await git(fixture.root, [
      "--git-dir",
      fixture.remote,
      "show",
      "main:workstreams/new/child/README.md",
    ]),
    "# New child",
  );
  assert.deepEqual(
    (await git(fixture.root, [
      "--git-dir",
      fixture.remote,
      "show",
      "--format=",
      "--name-only",
      published.pushConfirmed.sha,
    ])).split(/\r?\n/).filter(Boolean),
    ["workstreams/new/child/README.md"],
  );
});

test("confirms a no-op workspace without creating a commit", async (t) => {
  const fixture = await createWorkstreamGitFixture(t);
  const service = createWorkstreamDeliveryService(fixture);
  const prepared = await service.prepare({
    workstream: "existing",
    sessionId: "session-1",
  });

  const result = await service.publish({
    operationId: prepared.receipt.operationId,
    sessionId: "session-1",
  });

  assert.equal(result.status, "confirmed");
  assert.equal(result.noChange, true);
  assert.equal(result.commitCreated, undefined);
  await assert.rejects(access(prepared.receipt.workspace));
  assert.equal(
    await git(fixture.root, ["--git-dir", fixture.remote, "rev-list", "--count", "main"]),
    "1",
  );
});

test("rejects unrelated and ignored generated workspace changes before committing", async (t) => {
  const fixture = await createWorkstreamGitFixture(t);
  const service = createWorkstreamDeliveryService(fixture);
  const prepared = await service.prepare({
    workstream: "existing",
    sessionId: "session-1",
  });
  await writeFile(prepared.receipt.filePath, "# Existing\n\nChanged.\n");
  await writeFile(path.join(prepared.receipt.workspace, "unrelated.txt"), "changed\n");

  const unrelated = await service.publish({
    operationId: prepared.receipt.operationId,
    sessionId: "session-1",
  });
  assert.equal(unrelated.status, "rejected");
  assert.match(unrelated.diagnostics[0], /outside the intended/i);

  await rm(path.join(prepared.receipt.workspace, "unrelated.txt"));
  await mkdir(path.join(prepared.receipt.workspace, "generated"));
  await writeFile(path.join(prepared.receipt.workspace, "generated", "output.txt"), "output\n");

  const generated = await service.publish({
    operationId: prepared.receipt.operationId,
    sessionId: "session-1",
  });
  assert.equal(generated.status, "rejected");
  assert.match(generated.diagnostics[0], /outside the intended/i);
});

test("does not overwrite a remote advance and retains a local commit after leadership loss", async (t) => {
  const fixture = await createWorkstreamGitFixture(t);
  const service = createWorkstreamDeliveryService(fixture);
  const prepared = await service.prepare({
    workstream: "existing",
    sessionId: "session-1",
  });
  await writeFile(prepared.receipt.filePath, "# Existing\n\nChanged.\n");
  await writeFile(
    path.join(fixture.seed, "workstreams", "existing", "README.md"),
    "# Existing\n\nConcurrent update.\n",
  );
  await git(fixture.seed, ["add", "workstreams/existing/README.md"]);
  await git(fixture.seed, ["commit", "-m", "Concurrent workstream update"]);
  await git(fixture.seed, ["push", "origin", "main"]);

  const advanced = await service.publish({
    operationId: prepared.receipt.operationId,
    sessionId: "session-1",
  });
  assert.equal(advanced.status, "rejected");
  assert.match(advanced.diagnostics[0], /advanced/i);

  const second = await createWorkstreamDeliveryService(fixture, {
    operationIdFactory: () => "operation-2",
  }).prepare({ workstream: "existing", sessionId: "session-1" });
  await writeFile(second.receipt.filePath, "# Existing\n\nLocal commit only.\n");
  let assertions = 0;
  const leadershipLost = createWorkstreamDeliveryService(fixture, {
    assertLeadership: async () => ({
      asserted: ++assertions < 3,
      reason: "leadership replaced",
    }),
  });
  const incomplete = await leadershipLost.publish({
    operationId: second.receipt.operationId,
    sessionId: "session-1",
  });

  assert.equal(incomplete.status, "incomplete");
  assert.match(incomplete.diagnostics[0], /leadership/i);
  assert.match(incomplete.commitCreated.sha, /^[0-9a-f]{40}$/);
  await access(second.receipt.workspace);
  assert.equal(
    await git(fixture.domain, ["rev-parse", "origin/main"]),
    second.receipt.target.baseCommit,
  );

  const retried = await createWorkstreamDeliveryService(fixture, {
    operationIdFactory: () => "operation-2",
  }).publish({ operationId: second.receipt.operationId, sessionId: "session-1" });
  assert.equal(retried.status, "confirmed");
  assert.equal(retried.pushConfirmed.sha, incomplete.commitCreated.sha);
});

test("reports a rejected direct push as incomplete and safely retries the retained commit", async (t) => {
  const fixture = await createWorkstreamGitFixture(t);
  const service = createWorkstreamDeliveryService(fixture);
  const prepared = await service.prepare({
    workstream: "existing",
    sessionId: "session-1",
  });
  await writeFile(prepared.receipt.filePath, "# Existing\n\nRetry after rejection.\n");
  const hook = await configurePushRejection(fixture);

  const rejectedPush = await service.publish({
    operationId: prepared.receipt.operationId,
    sessionId: "session-1",
  });

  assert.equal(rejectedPush.status, "incomplete");
  assert.match(rejectedPush.diagnostics[0], /Push was not confirmed/);
  await access(prepared.receipt.workspace);
  assert.equal(
    await git(fixture.root, ["--git-dir", fixture.remote, "rev-parse", "main"]),
    prepared.receipt.target.baseCommit,
  );

  await rm(hook);
  const retried = await service.publish({
    operationId: prepared.receipt.operationId,
    sessionId: "session-1",
  });
  assert.equal(retried.status, "confirmed");
  assert.equal(retried.pushConfirmed.sha, rejectedPush.commitCreated.sha);
});
