import { execFile } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const DEFAULT_PLAYBOOK_FILE = fileURLToPath(
  new URL('../system/default-playbook.md', import.meta.url),
);

function stripInlineComment(raw) {
  let quote = null;
  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index];
    if (quote) {
      if (character === quote) quote = null;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '#' && (index === 0 || /\s/.test(raw[index - 1]))) {
      return raw.slice(0, index);
    }
  }
  return raw;
}

export function splitPlaybookFrontMatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!match) throw new Error('playbook must start with YAML front matter');
  const front = {};
  for (const line of match[1].split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parsed = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!parsed) throw new Error(`unsupported playbook front matter line: ${line}`);
    const raw = stripInlineComment(parsed[2]).trim();
    front[parsed[1]] = raw === '' || raw === 'null'
      ? null
      : raw.replace(/^["']|["']$/g, '');
  }
  return { front, body: match[2] };
}

export function validateBackendPlaybook(filename, text) {
  const name = path.basename(filename, '.md');
  const { front, body } = splitPlaybookFrontMatter(text);
  if (front.name !== name) throw new Error(`${filename} name must be ${name}`);
  if (!String(front.description || '').trim()) {
    throw new Error(`${filename} description is required`);
  }
  const workingDirectory = front.workingDirectory == null
    ? null
    : String(front.workingDirectory);
  if (workingDirectory !== null && !path.isAbsolute(workingDirectory)) {
    throw new Error(`${filename} workingDirectory must be absolute`);
  }
  return {
    name,
    description: String(front.description).trim(),
    workingDirectory,
    text,
    body,
  };
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

async function readRemoteDomainFile(config, repoPath, dependencies) {
  if (!String(config.domainRevision || '').trim()) {
    throw new Error('domainRevision is required when domainRepo is used');
  }
  const result = await ghJson([
    `repos/${config.domainRepo}/contents/${repoPath}`,
    '-f',
    `ref=${config.domainRevision}`,
  ], dependencies);
  if (result.type !== 'file' || typeof result.content !== 'string') {
    throw new Error(`Domain path is not a file: ${repoPath}`);
  }
  return {
    text: Buffer.from(result.content.replace(/\n/g, ''), 'base64').toString('utf8'),
    revision: result.sha,
  };
}

async function loadDefaultPlaybook(dependencies) {
  const text = dependencies.readFile
    ? await dependencies.readFile(DEFAULT_PLAYBOOK_FILE, 'utf8')
    : await readFile(DEFAULT_PLAYBOOK_FILE, 'utf8');
  return validateBackendPlaybook('default-playbook.md', text);
}

async function loadLocalDomain(config, dependencies) {
  const root = path.resolve(config.domainPath);
  const directory = path.join(root, 'playbooks', config.machine);
  const readDirectory = dependencies.readdir ?? readdir;
  const readText = dependencies.readFile ?? readFile;
  const names = (await readDirectory(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => entry.name)
    .sort();
  if (!names.length) throw new Error(`${directory} contains no playbooks`);
  const playbooks = new Map();
  for (const name of names) {
    const text = await readText(path.join(directory, name), 'utf8');
    playbooks.set(path.basename(name, '.md'), validateBackendPlaybook(name, text));
  }
  return {
    playbooks,
    domainInstructions: await readText(
      path.join(root, config.domainInstructionsFile || 'pan.md'),
      'utf8',
    ),
    domainRevision: config.domainRevision || 'local',
  };
}

async function loadRemoteDomain(config, dependencies) {
  if (!String(config.domainRevision || '').trim()) {
    throw new Error('domainRevision is required when domainRepo is used');
  }
  const directory = `playbooks/${config.machine}`;
  const entries = await ghJson([
    `repos/${config.domainRepo}/contents/${directory}`,
    '-f',
    `ref=${config.domainRevision}`,
  ], dependencies);
  if (!Array.isArray(entries)) throw new Error(`${directory} is not a directory`);
  const files = entries
    .filter((entry) => entry.type === 'file' && entry.name.endsWith('.md'))
    .sort((left, right) => left.name.localeCompare(right.name));
  if (!files.length) throw new Error(`${directory} contains no playbooks`);
  const playbooks = new Map();
  for (const file of files) {
    const loaded = await readRemoteDomainFile(
      config,
      `${directory}/${file.name}`,
      dependencies,
    );
    playbooks.set(file.name.slice(0, -3), {
      ...validateBackendPlaybook(file.name, loaded.text),
      revision: loaded.revision,
    });
  }
  const domain = await readRemoteDomainFile(
    config,
    config.domainInstructionsFile || 'pan.md',
    dependencies,
  );
  return {
    playbooks,
    domainInstructions: domain.text,
    domainRevision: domain.revision,
  };
}

export async function loadBackendPlaybooks(config, dependencies = {}) {
  if (!String(config.machine || '').trim()) throw new Error('machine is required');
  if (config.domainPath) {
    if (!path.isAbsolute(config.domainPath)) throw new Error('domainPath must be absolute');
  } else if (!/^[^/\s]+\/[^/\s]+$/.test(String(config.domainRepo || ''))) {
    throw new Error('domainRepo must be owner/repo when domainPath is not set');
  }
  const loaded = config.domainPath
    ? await loadLocalDomain(config, dependencies)
    : await loadRemoteDomain(config, dependencies);
  return {
    ...loaded,
    defaultPlaybook: await loadDefaultPlaybook(dependencies),
  };
}

export function resolvePlaybookWorkingDirectory(playbook, config) {
  const value = playbook.workingDirectory || config.workingDirectory;
  if (!value || !path.isAbsolute(value)) {
    throw new Error(
      `playbook ${playbook.name} needs workingDirectory or runner workingDirectory`,
    );
  }
  return path.resolve(value);
}

function normalizeWorkstreamPath(value) {
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

export async function loadBackendWorkstream(
  config,
  workstream,
  dependencies = {},
) {
  const normalized = normalizeWorkstreamPath(workstream);
  if (!normalized) return { path: '', text: '', revision: null };
  const repoPath = `workstreams/${normalized}/README.md`;
  if (config.domainPath) {
    const filename = path.join(path.resolve(config.domainPath), ...repoPath.split('/'));
    const readText = dependencies.readFile ?? readFile;
    return {
      path: repoPath,
      text: await readText(filename, 'utf8'),
      revision: config.domainRevision || 'local',
    };
  }
  const loaded = await readRemoteDomainFile(config, repoPath, dependencies);
  return { path: repoPath, ...loaded };
}
