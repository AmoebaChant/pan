import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MODULE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RECEIPT_NAME = "pan-assets.json";
const RECEIPT_VERSION = 1;

export class PanAssetError extends Error {
  constructor(message, { status, cause } = {}) {
    super(message, { cause });
    this.name = "PanAssetError";
    this.status = status;
  }
}

export class PanAssetService {
  constructor({
    assetRoot = path.join(MODULE_ROOT, "assets", "copilot"),
    packageRoot = MODULE_ROOT,
    packageVersion,
    userScope,
    env = process.env,
    platform = process.platform,
    homedir = os.homedir,
    now = () => new Date(),
    writeFileAtomic = writeAtomic,
  } = {}) {
    this.assetRoot = path.resolve(assetRoot);
    this.packageRoot = path.resolve(packageRoot);
    this.packageVersion = packageVersion;
    this.userScope =
      userScope ?? discoverCopilotUserScope({ env, platform, homedir });
    this.now = now;
    this.writeFileAtomic = writeFileAtomic;
  }

  async status() {
    let bundle;
    try {
      bundle = await this.#loadBundle();
    } catch (error) {
      return malformedStatus(error, this.userScope);
    }

    const receipt = await readReceipt(this.userScope.receiptPath);
    const assets = await Promise.all(
      bundle.assets.map((asset) => this.#assetStatus(asset, receipt.value)),
    );
    const shadows = await findShadows(bundle.assets, this.userScope.shadowRoots);
    const receiptMalformed =
      Boolean(receipt.error) ||
      (receipt.value !== undefined && !isValidReceipt(receipt.value, bundle));
    const receiptStale =
      receipt.value !== undefined &&
      !receiptMalformed &&
      !isCurrentReceipt(receipt.value, bundle);
    const statuses = [
      ...(receiptMalformed ? ["malformed"] : []),
      ...(receiptStale ? ["stale"] : []),
      ...assets.map((asset) => asset.status),
      ...shadows.map(() => "shadowed"),
    ];
    return {
      status:
        receiptMalformed ||
        (receipt.value === undefined && assets.every((asset) => asset.status === "current"))
          ? "malformed"
          : summarizeStatus(statuses),
      package: {
        name: bundle.packageName,
        version: bundle.packageVersion,
        manifestVersion: bundle.manifest.version,
      },
      scope: publicScope(this.userScope),
      receipt: receipt.error
        ? { status: "malformed", path: this.userScope.receiptPath, error: receipt.error.message }
        : {
              status: receipt.value
                ? receiptMalformed
                  ? "malformed"
                  : receiptStale
                    ? "stale"
                    : "current"
                : "missing",
            path: this.userScope.receiptPath,
          },
      assets,
      shadows,
    };
  }

  async install() {
    const bundle = await this.#loadBundle();
    const before = await this.status();
    ensureInstallable(before, "install");
    const targets = before.assets.filter((asset) =>
      ["missing", "stale"].includes(asset.status),
    );
    await this.#writeAssets(bundle, targets);
    await this.writeFileAtomic(
      this.userScope.receiptPath,
      `${JSON.stringify(receiptFor(bundle), null, 2)}\n`,
    );
    return this.#requireCurrent();
  }

  async repair({ force = false } = {}) {
    const bundle = await this.#loadBundle();
    const before = await this.status();
    if (before.status === "malformed" && before.package?.version === undefined) {
      throw new PanAssetError("PAN asset package is malformed", { status: before });
    }
    if (before.shadows.length > 0) {
      throw new PanAssetError(
        "PAN asset installation is shadowed by another supported user scope",
        { status: before },
      );
    }
    const conflicts = before.assets.filter((asset) => asset.status === "conflicting");
    if (conflicts.length > 0 && !force) {
      throw new PanAssetError(
        "PAN asset repair refuses to replace locally modified files; rerun with --force after reviewing status",
        { status: before },
      );
    }
    const targets = before.assets.filter((asset) =>
      force
        ? asset.status !== "current"
        : ["missing", "stale", "malformed"].includes(asset.status),
    );
    await this.#backupExisting(targets);
    await this.#writeAssets(bundle, targets);
    await this.writeFileAtomic(
      this.userScope.receiptPath,
      `${JSON.stringify(receiptFor(bundle), null, 2)}\n`,
    );
    return this.#requireCurrent();
  }

  async #requireCurrent() {
    const result = await this.status();
    if (result.status !== "current") {
      throw new PanAssetError("PAN asset installation did not verify as current", {
        status: result,
      });
    }
    return result;
  }

  async #loadBundle() {
    const [manifestSource, packageSource] = await Promise.all([
      readFile(path.join(this.assetRoot, "manifest.json"), "utf8"),
      this.packageVersion === undefined
        ? readFile(path.join(this.packageRoot, "package.json"), "utf8")
        : undefined,
    ]);
    let manifest;
    let packageMetadata;
    try {
      manifest = JSON.parse(manifestSource);
      packageMetadata = packageSource ? JSON.parse(packageSource) : {};
    } catch (error) {
      throw new PanAssetError("PAN asset manifest or package metadata is invalid JSON", {
        cause: error,
      });
    }
    if (!Number.isInteger(manifest.version) || !Array.isArray(manifest.assets)) {
      throw new PanAssetError("PAN asset manifest has an invalid shape");
    }
    const packageVersion = this.packageVersion ?? packageMetadata.version;
    const packageName = packageMetadata.name ?? "pan";
    if (typeof packageVersion !== "string" || !packageVersion) {
      throw new PanAssetError("PAN package version is required for asset installation");
    }
    const destinations = new Set();
    const assets = await Promise.all(
      manifest.assets.map(async (entry) => {
        validateManifestEntry(entry, destinations);
        const sourcePath = confinedPath(this.assetRoot, entry.source);
        const content = await readFile(sourcePath);
        if (hash(content) !== entry.sha256) {
          throw new PanAssetError(`PAN asset hash does not match manifest: ${entry.source}`);
        }
        validateAssetContent(entry.destination, content.toString("utf8"));
        return {
          ...entry,
          sourcePath,
          content,
          path: assetDestinationPath(entry.destination, this.userScope),
        };
      }),
    );
    return { manifest, assets, packageName, packageVersion };
  }

  async #assetStatus(asset, receipt) {
    let content;
    try {
      content = await readFile(asset.path);
    } catch (error) {
      if (error.code === "ENOENT") {
        return assetResult(asset, "missing");
      }
      return assetResult(asset, "malformed", { error: error.message });
    }
    const actualHash = hash(content);
    if (actualHash === asset.sha256) {
      return assetResult(asset, "current", { actualHash });
    }
    const priorHash = receipt?.assets?.[asset.destination]?.sha256;
    return assetResult(
      asset,
      priorHash && priorHash === actualHash ? "stale" : "conflicting",
      { actualHash, priorHash },
    );
  }

  async #writeAssets(bundle, targets) {
    for (const target of targets) {
      const source = bundle.assets.find(
        (asset) => asset.destination === target.destination,
      );
      await this.writeFileAtomic(source.path, source.content);
    }
  }

  async #backupExisting(targets) {
    const existing = [];
    for (const target of targets) {
      try {
        await readFile(target.path);
        existing.push(target);
      } catch (error) {
        if (error.code !== "ENOENT") {
          throw error;
        }
      }
    }
    if (existing.length === 0) {
      return;
    }
    const backupRoot = path.join(
      this.userScope.root,
      "pan-assets-backups",
      this.now().toISOString().replace(/[:.]/g, "-"),
    );
    for (const target of existing) {
      const backupPath = confinedPath(backupRoot, target.destination);
      await mkdir(path.dirname(backupPath), { recursive: true });
      await copyFile(target.path, backupPath);
    }
  }
}

export function discoverCopilotUserScope({
  env = process.env,
  platform = process.platform,
  homedir = os.homedir,
} = {}) {
  const home = homedir();
  const root = path.resolve(
    env.COPILOT_HOME ??
      env.PAN_COPILOT_HOME ??
      (platform === "win32"
        ? path.join(env.USERPROFILE ?? home, ".copilot")
        : path.join(home, ".copilot")),
  );
  return {
    root,
    agents: path.resolve(env.COPILOT_AGENT_DIR ?? path.join(root, "agents")),
    instructions: path.resolve(
      env.COPILOT_INSTRUCTIONS_DIR ?? path.join(root, "instructions"),
    ),
    skills: path.resolve(env.COPILOT_SKILLS_DIR ?? path.join(root, "skills")),
    receiptPath: path.resolve(path.join(root, RECEIPT_NAME)),
    shadowRoots: [],
  };
}

export function isCurrentPanAssets(status) {
  return status?.status === "current";
}

function receiptFor(bundle) {
  return {
    version: RECEIPT_VERSION,
    package: { name: bundle.packageName, version: bundle.packageVersion },
    manifest: { version: bundle.manifest.version },
    assets: Object.fromEntries(
      bundle.assets.map((asset) => [
        asset.destination,
        { sha256: asset.sha256 },
      ]),
    ),
  };
}

function isValidReceipt(receipt, bundle) {
  if (!receipt) {
    return false;
  }
  if (
    receipt.version !== RECEIPT_VERSION ||
    receipt.package?.name !== bundle.packageName ||
    typeof receipt.package?.version !== "string" ||
    !Number.isInteger(receipt.manifest?.version) ||
    !receipt.assets ||
    typeof receipt.assets !== "object"
  ) {
    return false;
  }
  return bundle.assets.every(
    (asset) =>
      typeof receipt.assets[asset.destination]?.sha256 === "string",
  );
}

function isCurrentReceipt(receipt, bundle) {
  return (
    receipt.package.version === bundle.packageVersion &&
    receipt.manifest.version === bundle.manifest.version
  );
}

async function readReceipt(receiptPath) {
  try {
    return { value: JSON.parse(await readFile(receiptPath, "utf8")) };
  } catch (error) {
    if (error.code === "ENOENT") {
      return { value: undefined };
    }
    return { error };
  }
}

async function findShadows(assets, roots = []) {
  const shadows = [];
  for (const root of roots) {
    for (const asset of assets) {
      const candidate = path.join(root, asset.destination);
      try {
        await readFile(candidate);
        shadows.push({ path: candidate, destination: asset.destination });
      } catch (error) {
        if (error.code !== "ENOENT") {
          throw error;
        }
      }
    }
  }
  return shadows;
}

function ensureInstallable(status, operation) {
  if (status.status === "malformed" && status.package?.version === undefined) {
    throw new PanAssetError("PAN asset package is malformed", { status });
  }
  if (status.shadows.length > 0) {
    throw new PanAssetError(
      "PAN asset installation is shadowed by another supported user scope",
      { status },
    );
  }
  if (status.assets.some((asset) => asset.status === "conflicting")) {
    throw new PanAssetError(
      `PAN asset ${operation} refuses to overwrite locally modified files; use pan assets repair --force after reviewing status`,
      { status },
    );
  }
}

function malformedStatus(error, scope) {
  return {
    status: "malformed",
    package: undefined,
    scope: publicScope(scope),
    receipt: { status: "unknown", path: scope.receiptPath },
    assets: [],
    shadows: [],
    diagnostics: [error.message],
  };
}

function assetResult(asset, status, extra = {}) {
  return {
    source: asset.source,
    destination: asset.destination,
    path: asset.path,
    status,
    expectedHash: asset.sha256,
    ...extra,
  };
}

function summarizeStatus(statuses) {
  for (const status of [
    "malformed",
    "conflicting",
    "shadowed",
    "missing",
    "stale",
  ]) {
    if (statuses.includes(status)) {
      return status;
    }
  }
  return "current";
}

function publicScope(scope) {
  return {
    root: scope.root,
    agents: scope.agents,
    instructions: scope.instructions,
    skills: scope.skills,
  };
}

function validateManifestEntry(entry, destinations) {
  if (
    !entry ||
    typeof entry.source !== "string" ||
    typeof entry.destination !== "string" ||
    !/^[a-f0-9]{64}$/.test(entry.sha256 ?? "") ||
    !isSafeRelativePath(entry.source) ||
    !isSafeRelativePath(entry.destination) ||
    destinations.has(entry.destination)
  ) {
    throw new PanAssetError("PAN asset manifest contains an invalid entry");
  }
  destinations.add(entry.destination);
}

function assetDestinationPath(destination, scope) {
  const [kind, ...rest] = destination.split("/");
  const directory = scope[kind];
  if (!directory || rest.length === 0) {
    throw new PanAssetError(`PAN asset destination is unsupported: ${destination}`);
  }
  return confinedPath(directory, rest.join("/"));
}

function validateAssetContent(destination, content) {
  if (destination.startsWith("agents/") || destination.includes("/SKILL.md")) {
    if (!/^---\r?\n[\s\S]*?\r?\n---\r?\n/.test(content)) {
      throw new PanAssetError(`PAN asset is not parseable frontmatter: ${destination}`);
    }
  }
  if (!content.trim()) {
    throw new PanAssetError(`PAN asset is empty: ${destination}`);
  }
}

function confinedPath(root, relative) {
  const resolved = path.resolve(root, relative);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new PanAssetError("PAN asset path escapes its configured scope");
  }
  return resolved;
}

function isSafeRelativePath(value) {
  return (
    value.length > 0 &&
    !path.isAbsolute(value) &&
    !value.split(/[\\/]/).includes("..")
  );
}

function hash(content) {
  return createHash("sha256").update(content).digest("hex");
}

async function writeAtomic(destination, content) {
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    await writeFile(temporary, content);
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
}
