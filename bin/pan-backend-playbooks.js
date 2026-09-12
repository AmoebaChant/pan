import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { parseWorkspaceSlots } from './pan-runner-slots.js';

const execFileAsync = promisify(execFile);

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
  let pendingMap = null;
  for (const line of match[1].split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parsed = /^\s*([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!parsed) throw new Error(`unsupported front matter line: ${line}`);
    const indented = /^\s/.test(line);
    const rawValue = stripInlineComment(parsed[2]).trim();
    const value = rawValue === '' || rawValue === 'null'
      ? null
      : rawValue.replace(/^["']|["']$/g, '');
    if (indented && pendingMap) {
      if (!Array.isArray(front[pendingMap])) front[pendingMap] = [];
      front[pendingMap].push([parsed[1], value]);
    } else {
      front[parsed[1]] = value;
      pendingMap = value === null ? parsed[1] : null;
    }
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
  const capacity = Number(front.capacity);
  if (!Number.isInteger(capacity) || capacity < 0) {
    throw new Error(`${filename} capacity must be a non-negative integer`);
  }
  const workingDirectory = front.workingDirectory == null
    ? null
    : String(front.workingDirectory);
  if (workingDirectory !== null && !path.isAbsolute(workingDirectory)) {
    throw new Error(`${filename} workingDirectory must be absolute`);
  }
  let slots = null;
  if (Object.hasOwn(front, 'workspaceSlots')) {
    if (workingDirectory !== null) {
      throw new Error(`${filename} cannot set workingDirectory and workspaceSlots`);
    }
    slots = parseWorkspaceSlots(front.workspaceSlots);
    if (capacity > slots.length) {
      throw new Error(`${filename} capacity exceeds workspaceSlots`);
    }
  }
  return {
    name,
    description: String(front.description).trim(),
    capacity,
    workingDirectory,
    slots,
    text,
    body,
  };
}

async function ghJson(args, dependencies) {
  if (dependencies.ghJson) return dependencies.ghJson(args);
  const { stdout } = await execFileAsync('gh', ['api', ...args], {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

async function readDomainFile(domainRepo, repoPath, revision, dependencies) {
  const args = [`repos/${domainRepo}/contents/${repoPath}`];
  if (revision) args.push('-f', `ref=${revision}`);
  const result = await ghJson(args, dependencies);
  if (result.type !== 'file' || typeof result.content !== 'string') {
    throw new Error(`Domain path is not a file: ${repoPath}`);
  }
  return {
    text: Buffer.from(result.content.replace(/\n/g, ''), 'base64').toString('utf8'),
    sha: result.sha,
  };
}

export async function loadBackendPlaybooks(config, dependencies = {}) {
  const domainRepo = String(config.domainRepo || '').trim();
  if (!/^[^/\s]+\/[^/\s]+$/.test(domainRepo)) {
    throw new Error('domainRepo must be owner/repo');
  }
  const machine = String(config.machine || '').trim();
  const directory = `playbooks/${machine}`;
  const args = [`repos/${domainRepo}/contents/${directory}`];
  if (config.domainRevision) args.push('-f', `ref=${config.domainRevision}`);
  const entries = await ghJson(args, dependencies);
  if (!Array.isArray(entries)) throw new Error(`${directory} is not a directory`);
  const files = entries
    .filter((entry) => entry.type === 'file' && entry.name.endsWith('.md'))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (!files.length) throw new Error(`${directory} contains no playbooks`);
  const playbooks = new Map();
  for (const file of files) {
    const loaded = await readDomainFile(
      domainRepo,
      `${directory}/${file.name}`,
      config.domainRevision,
      dependencies,
    );
    const playbook = validateBackendPlaybook(file.name, loaded.text);
    playbooks.set(playbook.name, { ...playbook, sha: loaded.sha });
  }
  const domain = await readDomainFile(
    domainRepo,
    config.domainInstructionsFile || 'pan.md',
    config.domainRevision,
    dependencies,
  );
  return { playbooks, domainInstructions: domain.text, domainSha: domain.sha };
}

export function resolvePlaybookWorkspace(playbook, taskId, state) {
  if (playbook.workingDirectory) {
    return { workingDirectory: path.resolve(playbook.workingDirectory), workspaceSlot: null };
  }
  if (playbook.slots) {
    const occupied = new Set(state.occupiedSlots.get(playbook.name) || []);
    const slot = playbook.slots.find((candidate) => !occupied.has(candidate.id));
    return slot
      ? { workingDirectory: path.resolve(slot.dir), workspaceSlot: slot.id }
      : null;
  }
  if (!state.workspaceRoot) return null;
  return {
    workingDirectory: path.join(path.resolve(state.workspaceRoot), encodeURIComponent(taskId)),
    workspaceSlot: null,
  };
}
