import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { PanAssetService } from "../src/index.js";

test("installs and verifies user-scoped assets idempotently", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pan-assets-install-"));
  try {
    const fixture = await createFixture(root, "1.0.0");
    const service = new PanAssetService(fixture);

    const before = await service.status();
    assert.equal(before.status, "missing");
    const installed = await service.install();
    assert.equal(installed.status, "current");
    assert.ok(installed.assets.every((asset) => asset.status === "current"));

    const repeated = await service.install();
    assert.equal(repeated.status, "current");
    const receipt = JSON.parse(await readFile(fixture.userScope.receiptPath, "utf8"));
    assert.equal(receipt.package.version, "1.0.0");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("identifies a PAN-owned package upgrade as stale and installs it", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pan-assets-upgrade-"));
  try {
    const fixture = await createFixture(root, "1.0.0");
    await new PanAssetService(fixture).install();
    const upgrade = await createFixture(root, "2.0.0", {
      "instructions/pan.instructions.md": "# PAN instructions\n\nUpdated.\n",
    });
    const service = new PanAssetService(upgrade);

    const before = await service.status();
    assert.equal(before.status, "stale");
    assert.equal(
      before.assets.find(
        (asset) => asset.destination === "instructions/pan.instructions.md",
      ).status,
      "stale",
    );
    assert.equal((await service.install()).status, "current");
    assert.match(
      await readFile(
        path.join(upgrade.userScope.instructions, "pan.instructions.md"),
        "utf8",
      ),
      /Updated/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("does not replace local modifications without forced repair and preserves a backup", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pan-assets-conflict-"));
  try {
    const fixture = await createFixture(root, "1.0.0");
    const service = new PanAssetService({ ...fixture, now: fixedNow });
    await service.install();
    const target = path.join(fixture.userScope.agents, "pan.agent.md");
    await writeFile(target, "---\nname: pan\n---\nLocal customization.\n");

    assert.equal((await service.status()).status, "conflicting");
    await assert.rejects(service.install(), /refuses to overwrite/);
    await assert.rejects(service.repair(), /refuses to replace/);
    assert.equal((await service.repair({ force: true })).status, "current");
    assert.match(await readFile(target, "utf8"), /PAN agent/);
    const backup = path.join(
      fixture.userScope.root,
      "pan-assets-backups",
      "2026-07-22T00-00-00-000Z",
      "agents",
      "pan.agent.md",
    );
    assert.match(await readFile(backup, "utf8"), /Local customization/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reports missing and malformed installations without touching unrelated files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pan-assets-status-"));
  try {
    const fixture = await createFixture(root, "1.0.0");
    const service = new PanAssetService(fixture);
    await service.install();
    const unrelated = path.join(fixture.userScope.skills, "personal", "SKILL.md");
    await mkdir(path.dirname(unrelated), { recursive: true });
    await writeFile(unrelated, "---\nname: personal\n---\nPersonal.\n");
    await unlink(path.join(fixture.userScope.skills, "pan-attention", "SKILL.md"));
    assert.equal((await service.status()).status, "missing");

    await service.repair();
    await writeFile(fixture.userScope.receiptPath, "{ not JSON");
    const malformed = await service.status();
    assert.equal(malformed.status, "malformed");
    assert.equal(malformed.receipt.status, "malformed");
    await access(unrelated);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reports a supported competing user scope as shadowed", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pan-assets-shadow-"));
  try {
    const fixture = await createFixture(root, "1.0.0");
    await new PanAssetService(fixture).install();
    const shadowRoot = path.join(root, "shadow");
    const shadow = path.join(shadowRoot, "agents", "pan.agent.md");
    await mkdir(path.dirname(shadow), { recursive: true });
    await writeFile(shadow, "---\nname: pan\n---\n# Shadow\n");
    const service = new PanAssetService({
      ...fixture,
      userScope: { ...fixture.userScope, shadowRoots: [shadowRoot] },
    });

    const status = await service.status();
    assert.equal(status.status, "shadowed");
    assert.equal(status.shadows[0].destination, "agents/pan.agent.md");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("leaves the existing asset intact when an atomic replacement fails", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pan-assets-atomic-"));
  try {
    const fixture = await createFixture(root, "1.0.0");
    await new PanAssetService(fixture).install();
    const upgrade = await createFixture(root, "2.0.0", {
      "instructions/pan.instructions.md": "# PAN instructions\n\nUpdated.\n",
    });
    const target = path.join(upgrade.userScope.instructions, "pan.instructions.md");
    const original = await readFile(target, "utf8");
    const service = new PanAssetService({
      ...upgrade,
      writeFileAtomic: async (destination, content) => {
        if (destination === target) {
          throw new Error("simulated replacement failure");
        }
        await writeFile(destination, content);
      },
    });

    await assert.rejects(service.install(), /simulated replacement failure/);
    assert.equal(await readFile(target, "utf8"), original);
    assert.equal((await service.status()).status, "stale");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function createFixture(root, version, changes = {}) {
  const assetRoot = path.join(root, "package", version, "assets", "copilot");
  const packageRoot = path.join(root, "package", version);
  const contents = {
    "agents/pan.agent.md": "---\nname: pan\n---\n# PAN agent\n",
    "instructions/pan.instructions.md": "# PAN instructions\n\nBase.\n",
    "skills/pan-attention/SKILL.md": "---\nname: pan-attention\n---\n# Attention\n",
    ...changes,
  };
  for (const [relative, content] of Object.entries(contents)) {
    const file = path.join(assetRoot, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  }
  await writeFile(
    path.join(assetRoot, "manifest.json"),
    `${JSON.stringify({
      version: 1,
      assets: Object.entries(contents).map(([source, content]) => ({
        source,
        destination: source,
        sha256: createHash("sha256").update(content).digest("hex"),
      })),
    })}\n`,
  );
  await writeFile(
    path.join(packageRoot, "package.json"),
    `${JSON.stringify({ name: "@test/pan", version })}\n`,
  );
  const userRoot = path.join(root, "user");
  return {
    assetRoot,
    packageRoot,
    userScope: {
      root: userRoot,
      agents: path.join(userRoot, "agents"),
      instructions: path.join(userRoot, "instructions"),
      skills: path.join(userRoot, "skills"),
      receiptPath: path.join(userRoot, "pan-assets.json"),
      shadowRoots: [],
    },
  };
}

function fixedNow() {
  return new Date("2026-07-22T00:00:00.000Z");
}
