#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { isCliEntry } from './pan-task-backend.js';

const execFileAsync = promisify(execFile);
const CATALOG_PATH = 'workstreams/README.md';
const REGISTRY_PATH = 'workstream-stores.json';
const CATALOG_MARKER = '<!-- pan-workstream-catalog:v1 -->';
const CATALOG_HEADER = '| Path | Name | Description |';
const CATALOG_SEPARATOR = '| --- | --- | --- |';

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireRepository(value, label) {
  const repository = String(value || '').trim();
  if (!/^[^/\s]+\/[^/\s]+$/.test(repository)) {
    throw new Error(`${label} must be owner/repo`);
  }
  return repository;
}

export function normalizeWorkstreamPath(value) {
  const normalized = String(value || '').trim().replaceAll('\\', '/');
  if (!normalized) return '';
  if (
    path.posix.isAbsolute(normalized)
    || normalized.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    throw new Error(`invalid workstream path: ${JSON.stringify(value)}`);
  }
  return normalized;
}

export function parseWorkstreamStoreRegistry(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`workstream store registry is not valid JSON: ${error.message}`);
  }
  if (!isRecord(parsed)) throw new Error('workstream store registry must be an object');
  if (parsed.version !== 1) throw new Error('workstream store registry version must be 1');
  if (!Array.isArray(parsed.stores)) {
    throw new Error('workstream store registry stores must be an array');
  }
  const stores = parsed.stores.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new Error(`workstream store registry stores[${index}] must be an object`);
    }
    const id = String(entry.id || '').trim();
    if (!/^[a-z][a-z0-9-]*$/.test(id) || id === 'domain') {
      throw new Error(
        `workstream store registry stores[${index}].id must be a lowercase id other than domain`,
      );
    }
    return {
      id,
      repository: requireRepository(
        entry.repository,
        `workstream store registry stores[${index}].repository`,
      ),
    };
  });
  const ids = new Set(['domain']);
  for (const store of stores) {
    if (ids.has(store.id)) throw new Error(`duplicate workstream store id: ${store.id}`);
    ids.add(store.id);
  }
  const defaultStore = String(parsed.defaultStore || '').trim();
  if (!ids.has(defaultStore)) {
    throw new Error(`workstream store registry defaultStore is unknown: ${defaultStore}`);
  }
  return { version: 1, defaultStore, stores };
}

export function parseWorkstreamDigest(text, source = CATALOG_PATH) {
  const lines = text.replaceAll('\r\n', '\n').split('\n');
  if (
    lines[0] !== '# Workstreams'
    || lines[1] !== ''
    || lines[2] !== CATALOG_MARKER
    || lines[3] !== ''
    || lines[4] !== CATALOG_HEADER
    || lines[5] !== CATALOG_SEPARATOR
  ) {
    throw new Error(`${source} must use the Pan workstream catalog v1 format`);
  }
  const entries = [];
  const paths = new Set();
  for (let index = 6; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line && index === lines.length - 1) continue;
    const columns = line.split('|');
    if (
      columns.length !== 5
      || columns[0] !== ''
      || columns[4] !== ''
    ) {
      throw new Error(`${source}:${index + 1} is not a valid catalog row`);
    }
    const pathCell = columns[1].trim();
    const name = columns[2].trim();
    const description = columns[3].trim();
    const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(pathCell);
    if (!link) throw new Error(`${source}:${index + 1} has an invalid path link`);
    const workstreamPath = normalizeWorkstreamPath(link[1]);
    if (link[2] !== `${workstreamPath}/README.md`) {
      throw new Error(`${source}:${index + 1} link must target ${workstreamPath}/README.md`);
    }
    if (!name) throw new Error(`${source}:${index + 1} name is required`);
    if (!description) throw new Error(`${source}:${index + 1} description is required`);
    if (paths.has(workstreamPath)) {
      throw new Error(`${source} contains duplicate workstream path: ${workstreamPath}`);
    }
    paths.add(workstreamPath);
    entries.push({
      path: workstreamPath,
      name,
      description,
      documentPath: `workstreams/${workstreamPath}/README.md`,
    });
  }
  return entries;
}

async function ghJson(args, dependencies) {
  if (dependencies.ghJson) return dependencies.ghJson(args);
  const { stdout } = await execFileAsync('gh', ['api', ...args], {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    windowsHide: true,
  });
  return JSON.parse(stdout);
}

function isNotFound(error) {
  return error?.code === 'ENOENT'
    || error?.status === 404
    || /\b404\b|not found/i.test(String(error?.stderr || error?.message || ''));
}

async function readGitHubFile(repository, repoPath, revision, dependencies) {
  const args = [
    '--method',
    'GET',
    `repos/${repository}/contents/${repoPath}`,
  ];
  if (revision) args.push('-f', `ref=${revision}`);
  const result = await ghJson(args, dependencies);
  if (result.type !== 'file' || typeof result.content !== 'string' || !result.sha) {
    throw new Error(`${repository}:${repoPath} is not a file`);
  }
  return {
    text: Buffer.from(result.content.replace(/\n/g, ''), 'base64').toString('utf8'),
    revision: result.sha,
  };
}

async function canonicalGitHubRepository(repository, dependencies) {
  const result = await ghJson([
    '--method',
    'GET',
    `repos/${repository}`,
  ], dependencies);
  const nameWithOwner = String(result.full_name || '').trim();
  if (
    !/^[^/\s]+\/[^/\s]+$/.test(nameWithOwner)
    || nameWithOwner.toLowerCase() !== repository.toLowerCase()
  ) {
    throw new Error(`GitHub returned invalid repository identity for ${repository}`);
  }
  return nameWithOwner;
}

async function readDomainFile(config, repoPath, dependencies, optional = false) {
  try {
    if (config.domainPath) {
      const readText = dependencies.readFile ?? readFile;
      return {
        text: await readText(
          path.join(path.resolve(config.domainPath), ...repoPath.split('/')),
          'utf8',
        ),
        revision: 'local-working-tree',
      };
    }
    const repository = requireRepository(config.domainRepo, 'domainRepo');
    return await readGitHubFile(
      repository,
      repoPath,
      String(config.domainRevision || '').trim(),
      dependencies,
    );
  } catch (error) {
    if (optional && isNotFound(error)) return null;
    throw error;
  }
}

async function readStoreFile(config, store, repoPath, dependencies) {
  if (store.id === 'domain') {
    return readDomainFile(config, repoPath, dependencies);
  }
  return readGitHubFile(store.repository, repoPath, '', dependencies);
}

function domainRepository(config) {
  if (String(config.domainRepo || '').trim()) {
    return requireRepository(config.domainRepo, 'domainRepo');
  }
  if (config.domainPath) return `local:${path.resolve(config.domainPath)}`;
  throw new Error('domainRepo or domainPath is required');
}

export async function loadWorkstreamCatalog(config, dependencies = {}) {
  if (!config.domainPath && !String(config.domainRepo || '').trim()) {
    return {
      version: 1,
      defaultStore: 'domain',
      stores: [{
        id: 'domain',
        repository: 'domain',
        catalogPath: CATALOG_PATH,
        catalogRevision: null,
      }],
      workstreams: [],
    };
  }
  const registryFile = await readDomainFile(
    config,
    REGISTRY_PATH,
    dependencies,
    true,
  );
  const registry = registryFile
    ? parseWorkstreamStoreRegistry(registryFile.text)
    : { version: 1, defaultStore: 'domain', stores: [] };
  const additionalStores = await Promise.all(registry.stores.map(async (store) => {
    try {
      return {
        ...store,
        repository: await canonicalGitHubRepository(
          store.repository,
          dependencies,
        ),
      };
    } catch (error) {
      throw new Error(
        `cannot load workstream store ${store.id} (${store.repository}): ${error.message}`,
      );
    }
  }));
  const configuredStores = [
    { id: 'domain', repository: domainRepository(config) },
    ...additionalStores,
  ];
  const loadedStores = await Promise.all(configuredStores.map(async (store) => {
    let digest;
    try {
      digest = await readStoreFile(config, store, CATALOG_PATH, dependencies);
    } catch (error) {
      throw new Error(
        `cannot load workstream store ${store.id} (${store.repository}): ${error.message}`,
      );
    }
    let entries;
    try {
      entries = parseWorkstreamDigest(
        digest.text,
        `${store.repository}:${CATALOG_PATH}`,
      );
    } catch (error) {
      throw new Error(
        `invalid workstream store ${store.id} (${store.repository}): ${error.message}`,
      );
    }
    return {
      store: {
        id: store.id,
        repository: store.repository,
        catalogPath: CATALOG_PATH,
        catalogRevision: digest.revision,
      },
      entries,
    };
  }));
  const owners = new Map();
  const workstreams = [];
  for (const loaded of loadedStores) {
    for (const entry of loaded.entries) {
      const existing = owners.get(entry.path);
      if (existing) {
        throw new Error(
          `duplicate workstream path ${JSON.stringify(entry.path)} in stores `
          + `${existing.id} (${existing.repository}) and `
          + `${loaded.store.id} (${loaded.store.repository})`,
        );
      }
      owners.set(entry.path, loaded.store);
      workstreams.push({
        ...entry,
        store: loaded.store.id,
        repository: loaded.store.repository,
        catalogPath: loaded.store.catalogPath,
        catalogRevision: loaded.store.catalogRevision,
      });
    }
  }
  workstreams.sort((left, right) => left.path.localeCompare(right.path));
  return {
    version: 1,
    defaultStore: registry.defaultStore,
    stores: loadedStores.map(({ store }) => store),
    workstreams,
  };
}

export function resolveCatalogWorkstream(catalog, workstreamPath) {
  const normalized = normalizeWorkstreamPath(workstreamPath);
  if (!normalized) return null;
  const match = catalog.workstreams.find((entry) => entry.path === normalized);
  if (!match) throw new Error(`workstream is not present in the catalog: ${normalized}`);
  return match;
}

export async function loadCatalogWorkstream(
  config,
  catalog,
  workstreamPath,
  dependencies = {},
) {
  const entry = resolveCatalogWorkstream(catalog, workstreamPath);
  if (!entry) return null;
  const store = catalog.stores.find((candidate) => candidate.id === entry.store);
  if (!store) throw new Error(`catalog store is missing: ${entry.store}`);
  let loaded;
  try {
    loaded = await readStoreFile(config, store, entry.documentPath, dependencies);
  } catch (error) {
    throw new Error(
      `cannot load workstream ${entry.path} from store ${store.id} `
      + `(${store.repository}): ${error.message}`,
    );
  }
  return {
    ...entry,
    text: loaded.text,
    revision: loaded.revision,
  };
}

export async function runWorkstreamsCli(argv, dependencies = {}) {
  const command = argv[0]?.startsWith('-') ? 'list' : (argv[0] || 'list');
  const { values, positionals } = parseArgs({
    args: argv.slice(argv[0]?.startsWith('-') ? 0 : 1),
    options: {
      config: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
    strict: true,
  });
  if (values.help) return { help: true };
  if (!values.config) throw new Error('--config is required');
  const readText = dependencies.readFile ?? readFile;
  const config = JSON.parse(await readText(path.resolve(values.config), 'utf8'));
  const catalog = await loadWorkstreamCatalog(config, dependencies);
  if (command === 'list') return catalog;
  if (command === 'resolve') {
    if (positionals.length !== 1) throw new Error('resolve requires one workstream path');
    return loadCatalogWorkstream(config, catalog, positionals[0], dependencies);
  }
  throw new Error('command must be list or resolve');
}

if (isCliEntry(import.meta.url)) {
  runWorkstreamsCli(process.argv.slice(2))
    .then((result) => {
      if (result?.help) {
        process.stdout.write(
          'Usage: pan-workstreams <list|resolve PATH> --config <domain-or-runner.json>\n',
        );
      } else {
        process.stdout.write(`${JSON.stringify({ ok: true, result })}\n`);
      }
    })
    .catch((error) => {
      process.stderr.write(
        `${JSON.stringify({ ok: false, error: { message: error.message } })}\n`,
      );
      process.exitCode = 1;
    });
}
