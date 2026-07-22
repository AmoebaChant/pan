import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  loadDomainConfig,
  migrateDomainConfig,
  validateDomainConfig,
} from "./domain-config.js";

export async function replaceDomainConfigFile(configPath, document) {
  validateDomainConfig(document, { configPath });
  const target = path.resolve(configPath);
  const temporary = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    await rename(temporary, target);
  } catch (error) {
    await cleanupTemporaryFile(temporary);
    throw error;
  }
}

export async function migrateDomainConfigFile(configPath) {
  const loaded = await loadDomainConfig(configPath);
  const source = await importConfigDocument(configPath);
  const migration = migrateDomainConfig(source);
  await replaceDomainConfigFile(configPath, migration.document);
  return { ...migration, config: loaded };
}

async function importConfigDocument(configPath) {
  return JSON.parse(await readFile(configPath, "utf8"));
}

async function cleanupTemporaryFile(temporary) {
  await rm(temporary, { force: true });
}
