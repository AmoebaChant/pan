#!/usr/bin/env node
/*
 * pan-runner — the single program in the Pan system.
 *
 * One instance per machine. It polls the Domain GitHub Project for ready agent
 * work matching the playbooks this machine runs, claims it with a lease, and
 * launches a headed `copilot` worker session in a visible terminal window to do
 * it. It implements no task logic and verifies no deliverables; the playbook
 * instructions and the Issue do that. See system/runner.md for the contract.
 *
 * Node 22+ built-ins only. ESM. No external dependencies. All GitHub access is
 * through the `gh` CLI (spawned with argv arrays — never shell strings).
 *
 * ---------------------------------------------------------------------------
 * LOCAL CONFIG FILE (JSON), passed with --config <path>. Shape:
 *
 * {
 *   // REQUIRED
 *   "domainRepo": "AmoebaChant/pan-domain",   // Domain repo as owner/name
 *   "project":    "AmoebaChant/7",            // Project as <owner>/<number>
 *   "machine":    "kevins-macbook",           // reads playbooks/<machine>/*.md
 *   "identity":   "kevins-macbook-runner-1",  // stable string for claimed-by
 *   "panCheckout":"/Users/kevin/Repos/pan",   // path to this Pan checkout
 *
 *   // OPTIONAL
 *   "terminal": {                             // headed-window launcher
 *     "kind": "macos-terminal" | "windows-terminal"  // auto-detected if omitted
 *   },
 *   "copilotBin":  "copilot",                 // command that starts a worker
 *   "workerPermissions": "yolo",              // "yolo" (default) | "standard".
 *                                             // "yolo" launches workers with
 *                                             // --allow-all (auto-approves every
 *                                             // tool, path, and URL, and clears
 *                                             // the folder-trust prompt) so they
 *                                             // run unattended. "standard" adds
 *                                             // no auto-approve flags and needs a
 *                                             // human at the terminal.
 *   "copilotArgs": [],                        // extra args before the prompt,
 *                                             // appended after any permission
 *                                             // flags derived from
 *                                             // workerPermissions
 *   "nodeBin":     "node",                    // node used to run .pan/launch.mjs
 *   "pollIntervalSeconds": 30,                // idle poll cadence (default 30)
 *   "leaseMinutes": 15,                       // lease duration (default 15)
 *   "maxConcurrent": null,                    // optional global capacity cap
 *   "workspaceRoot": "/tmp/pan-workspaces"    // isolated worker workspaces;
 *                                             // default os.tmpdir()/pan-workspaces
 * }
 *
 * The worker's isolated workspaces under workspaceRoot are a product feature and
 * are the ONLY place under a temp directory this program writes. The runner
 * keeps no scratch/state files of its own on disk.
 * ---------------------------------------------------------------------------
 */

import { parseArgs } from 'node:util';
import { spawn } from 'node:child_process';
import { readFile, mkdir, writeFile, readdir, stat, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FIELD = {
  status: 'Status',            // built-in Projects status field (capitalized)
  owner: 'owner',
  priority: 'priority',
  playbook: 'playbook',
  workstream: 'workstream',
  needsHumanSince: 'needs-human-since',
  leaseUntil: 'lease-until',
  claimedBy: 'claimed-by',
};

const PRIORITY_RANK = { urgent: 0, high: 1, normal: 2, low: 3 };
const DEFAULTS = {
  pollIntervalSeconds: 30,
  leaseMinutes: 15,
  idleBackoffMaxSeconds: 120,
  superviseTickSeconds: 3,
  workerStartGraceSeconds: 20, // grace before we expect .pan/worker.running
  ghMaxRetries: 5,
};

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `pan-runner — poll a Pan Domain Project and launch worker sessions.

Usage:
  pan-runner --config <path> [--once] [--validate-config]
  pan-runner --help

Options:
  --config <path>       Path to the local JSON config (required). See bin/README.md.
  --once                Run a single poll cycle, then supervise what it launched.
  --validate-config     Validate config and Domain access, then exit. No polling.
  --help                Show this help and exit.
`;

function parseCli(argv) {
  try {
    const { values } = parseArgs({
      args: argv,
      options: {
        config: { type: 'string' },
        once: { type: 'boolean', default: false },
        'validate-config': { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
      },
      allowPositionals: false,
    });
    return values;
  } catch (err) {
    throw new UserError(err.message);
  }
}

/** Error type for expected, user-facing failures (printed without a stack). */
class UserError extends Error {}

// ---------------------------------------------------------------------------
// gh wrapper
// ---------------------------------------------------------------------------

function isRateLimited(stderr) {
  const s = (stderr || '').toLowerCase();
  return (
    s.includes('rate limit') ||
    s.includes('secondary rate limit') ||
    s.includes('was submitted too quickly') ||
    s.includes('abuse detection')
  );
}

/** Spawn `gh` with an argv array. Returns stdout on success; throws on failure.
 *  Retries with backoff on GitHub rate-limit errors. */
async function gh(args, { input } = {}) {
  let attempt = 0;
  for (;;) {
    const result = await new Promise((resolve) => {
      const child = spawn('gh', args, { stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (err += d));
      child.on('error', (e) => resolve({ code: -1, out, err: String(e.message || e) }));
      child.on('close', (code) => resolve({ code, out, err }));
      if (input != null) child.stdin.end(input);
      else child.stdin.end();
    });

    if (result.code === 0) return result.out;

    if (isRateLimited(result.err) && attempt < DEFAULTS.ghMaxRetries) {
      const wait = Math.min(2 ** attempt, 30) * 1000;
      log(`gh rate limited; retrying in ${wait / 1000}s`);
      await sleep(wait);
      attempt += 1;
      continue;
    }
    throw new Error(`gh ${args.join(' ')} failed (exit ${result.code}): ${result.err.trim() || result.out.trim()}`);
  }
}

async function ghJson(args) {
  return JSON.parse(await gh(args));
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function parseOwnerName(s, label) {
  const m = /^([^/\s]+)\/([^/\s]+)$/.exec(String(s || '').trim());
  if (!m) throw new UserError(`${label} must be "owner/name", got: ${JSON.stringify(s)}`);
  return { owner: m[1], name: m[2] };
}

function parseProject(s) {
  const m = /^([^/\s]+)\/(\d+)$/.exec(String(s || '').trim());
  if (!m) throw new UserError(`project must be "<owner>/<number>", got: ${JSON.stringify(s)}`);
  return { owner: m[1], number: Number(m[2]) };
}

function detectTerminalKind() {
  if (process.platform === 'darwin') return 'macos-terminal';
  if (process.platform === 'win32') return 'windows-terminal';
  return null;
}

async function loadConfig(configPath) {
  if (!configPath) throw new UserError('--config <path> is required.');
  let raw;
  try {
    raw = await readFile(configPath, 'utf8');
  } catch {
    throw new UserError(`Cannot read config file: ${configPath}`);
  }
  let json;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    throw new UserError(`Config is not valid JSON (${configPath}): ${e.message}`);
  }

  for (const key of ['domainRepo', 'project', 'machine', 'identity', 'panCheckout']) {
    if (!json[key] || typeof json[key] !== 'string') {
      throw new UserError(`Config field "${key}" is required and must be a string.`);
    }
  }

  const domain = parseOwnerName(json.domainRepo, 'domainRepo');
  const project = parseProject(json.project);

  const terminalKind = json.terminal?.kind || detectTerminalKind();
  if (!terminalKind) {
    throw new UserError(
      `Cannot auto-detect a terminal for platform "${process.platform}". Set terminal.kind ` +
        `to "macos-terminal" or "windows-terminal" in the config.`,
    );
  }
  if (!['macos-terminal', 'windows-terminal'].includes(terminalKind)) {
    throw new UserError(`Unsupported terminal.kind: ${terminalKind}`);
  }

  if (!existsSync(json.panCheckout)) {
    throw new UserError(`panCheckout path does not exist: ${json.panCheckout}`);
  }

  const posNumber = (value, field) => {
    // Absent (undefined) means "use the default". An explicit null — or any
    // non-number / non-finite / non-positive value — is a configuration error.
    if (value === undefined) return null;
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      throw new UserError(`Config field "${field}" must be a number greater than 0.`);
    }
    return value;
  };
  const pollIntervalSeconds = posNumber(json.pollIntervalSeconds, 'pollIntervalSeconds') ?? DEFAULTS.pollIntervalSeconds;
  const leaseMinutes = posNumber(json.leaseMinutes, 'leaseMinutes') ?? DEFAULTS.leaseMinutes;

  let maxConcurrent;
  if (json.maxConcurrent == null) {
    maxConcurrent = Infinity;
  } else if (Number.isInteger(json.maxConcurrent) && json.maxConcurrent >= 1) {
    maxConcurrent = json.maxConcurrent;
  } else {
    throw new UserError('Config field "maxConcurrent" must be an integer >= 1 (or null for unlimited).');
  }

  // Default worker permissions. Maps a friendly level onto copilot launch flags
  // so onboarding and config can express intent without knowing CLI flags.
  // Defaults to "yolo": runner-launched workers are unattended, so they must
  // clear copilot's folder-trust gate and tool/path/URL confirmations without a
  // human present. Set "standard" to launch with no auto-approve flags (a human
  // must be at the terminal to confirm folder trust and every tool).
  const workerPermissions = json.workerPermissions ?? 'yolo';
  if (!['standard', 'yolo'].includes(workerPermissions)) {
    throw new UserError('Config field "workerPermissions" must be "standard" or "yolo".');
  }
  const permissionArgs = workerPermissions === 'yolo' ? ['--allow-all'] : [];

  return {
    domain,
    domainRepoSlug: `${domain.owner}/${domain.name}`,
    project,
    machine: json.machine,
    identity: json.identity,
    panCheckout: path.resolve(json.panCheckout),
    terminalKind,
    copilotBin: json.copilotBin || 'copilot',
    workerPermissions,
    permissionArgs,
    copilotArgs: Array.isArray(json.copilotArgs) ? json.copilotArgs : [],
    nodeBin: json.nodeBin || 'node',
    pollIntervalSeconds,
    leaseMinutes,
    maxConcurrent,
    workspaceRoot: json.workspaceRoot || path.join(os.tmpdir(), 'pan-workspaces'),
  };
}

// ---------------------------------------------------------------------------
// Domain reads (GitHub Contents API): per-machine playbooks
// ---------------------------------------------------------------------------

/** Read a file from the Domain repo as raw text. Throws UserError on 404. */
async function readDomainFile(cfg, repoPath) {
  try {
    return await gh([
      'api',
      '-H',
      'Accept: application/vnd.github.raw',
      `/repos/${cfg.domainRepoSlug}/contents/${repoPath}`,
    ]);
  } catch (e) {
    if (/404|Not Found/i.test(e.message)) {
      throw new UserError(`Domain file not found: ${cfg.domainRepoSlug}:${repoPath}`);
    }
    throw e;
  }
}

/** Split YAML front matter from a markdown document. */
function splitFrontMatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { front: {}, body: text };
  const front = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^\s*([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    let v = stripInlineComment(kv[2]).trim();
    if (v === 'null' || v === '') v = null;
    else v = v.replace(/^["']|["']$/g, '');
    front[kv[1]] = v;
  }
  return { front, body: m[2] };
}

/** Strip an inline YAML `#` comment from a scalar value, honoring quotes.
 *  A `#` begins a comment only when unquoted and either at the start of the
 *  value or preceded by whitespace. A `#` inside quotes is preserved. */
function stripInlineComment(raw) {
  let quote = null;
  for (let i = 0; i < raw.length; i += 1) {
    const c = raw[i];
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (c === '#' && (i === 0 || /\s/.test(raw[i - 1]))) {
      return raw.slice(0, i);
    }
  }
  return raw;
}

/** List a directory in the Domain repo via the Contents API. Returns the raw
 *  entry array ([{ name, type, ... }]). Throws UserError on 404. */
async function listDomainDir(cfg, repoPath) {
  let raw;
  try {
    raw = await gh(['api', `/repos/${cfg.domainRepoSlug}/contents/${repoPath}`]);
  } catch (e) {
    if (/404|Not Found/i.test(e.message)) {
      throw new UserError(`Domain directory not found: ${cfg.domainRepoSlug}:${repoPath}`);
    }
    throw e;
  }
  const entries = JSON.parse(raw);
  if (!Array.isArray(entries)) {
    throw new UserError(`Domain path is not a directory: ${cfg.domainRepoSlug}:${repoPath}`);
  }
  return entries;
}

/** Read every playbook this machine runs from playbooks/<machine>/*.md.
 *  A machine runs exactly the playbooks present in its folder; each file
 *  self-describes its concurrency (`capacity`) and optional `workingDirectory`
 *  in its front matter. Fails loudly (UserError) on a malformed definition
 *  rather than silently dropping it. */
async function loadPlaybooks(cfg) {
  const dir = `playbooks/${cfg.machine}`;
  const entries = await listDomainDir(cfg, dir);
  const files = entries
    .filter((e) => e.type === 'file' && /\.md$/i.test(e.name))
    .map((e) => e.name)
    .sort();
  if (files.length === 0) {
    throw new UserError(`${dir}/ contains no playbooks (expected one or more <name>.md files).`);
  }

  const playbooks = new Map(); // name -> { name, description, workingDirectory, capacity, body }
  for (const file of files) {
    const name = file.replace(/\.md$/i, '');
    const pbText = await readDomainFile(cfg, `${dir}/${file}`);
    const { front, body } = splitFrontMatter(pbText);
    if (!front.name || front.name !== name) {
      throw new UserError(
        `${dir}/${file} front matter must have name equal to "${name}" (got ${JSON.stringify(front.name ?? null)}).`,
      );
    }
    if (!front.description || String(front.description).trim().length === 0) {
      throw new UserError(`${dir}/${file} is missing a non-empty "description" in its front matter.`);
    }
    // Concurrency lives in the playbook front matter: a non-negative integer
    // (`0` disables the playbook on this machine without removing its file).
    const capStr = String(front.capacity ?? '').trim();
    const cap = Number(capStr);
    if (capStr === '' || !Number.isFinite(cap) || !Number.isInteger(cap) || cap < 0) {
      throw new UserError(
        `${dir}/${file} has invalid capacity ${JSON.stringify(front.capacity ?? null)}; must be a non-negative integer (0 disables it).`,
      );
    }
    const workingDirectory = front.workingDirectory ?? null;
    if (workingDirectory !== null && !path.isAbsolute(workingDirectory)) {
      throw new UserError(
        `${dir}/${file} workingDirectory must be an absolute path, got: ${workingDirectory}`,
      );
    }
    playbooks.set(name, {
      name,
      description: String(front.description).trim(),
      workingDirectory,
      capacity: cap,
      body,
    });
  }
  return playbooks;
}

// ---------------------------------------------------------------------------
// Project (GraphQL): owner type, metadata, field/option ids, item reads
// ---------------------------------------------------------------------------

async function resolveOwnerType(login) {
  const out = await gh([
    'api',
    'graphql',
    '-f',
    'query=query($l:String!){repositoryOwner(login:$l){__typename}}',
    '-f',
    `l=${login}`,
    '--jq',
    '.data.repositoryOwner.__typename',
  ]);
  const t = out.trim();
  if (t === 'User') return 'user';
  if (t === 'Organization') return 'organization';
  throw new UserError(`Cannot resolve project owner "${login}" (got __typename=${t || 'none'}).`);
}

/** Resolve and cache project id, field ids, and single-select option ids. */
async function loadProjectMeta(cfg) {
  const ownerType = await resolveOwnerType(cfg.project.owner);
  const query = `query($login:String!,$number:Int!){
    ${ownerType}(login:$login){
      projectV2(number:$number){
        id
        fields(first:50){ nodes{
          __typename
          ... on ProjectV2FieldCommon { id name }
          ... on ProjectV2SingleSelectField { id name options{ id name } }
        } }
      }
    }
  }`;
  const data = await ghJson([
    'api',
    'graphql',
    '-f',
    `query=${query}`,
    '-f',
    `login=${cfg.project.owner}`,
    '-F',
    `number=${cfg.project.number}`,
  ]);
  const project = data.data[ownerType]?.projectV2;
  if (!project) throw new UserError(`Project ${cfg.project.owner}/${cfg.project.number} not found.`);

  const fields = new Map(); // name -> { id, options: Map(optName->optId)|null }
  for (const f of project.fields.nodes) {
    if (!f?.name) continue;
    const options = f.options ? new Map(f.options.map((o) => [o.name, o.id])) : null;
    fields.set(f.name, { id: f.id, options });
  }
  return { ownerType, projectId: project.id, fields };
}

/** Validate the resolved Project has the 8 canonical fields with correct types
 *  (see system/project-schema.md). Single-select fields must expose an options
 *  Map; text fields must have null options. Throws a single UserError naming
 *  ALL missing or wrong-typed fields. */
function validateProjectSchema(meta) {
  const singleSelects = ['Status', 'owner', 'priority'];
  const textFields = ['playbook', 'workstream', 'needs-human-since', 'lease-until', 'claimed-by'];
  const problems = [];
  for (const name of singleSelects) {
    const f = meta.fields.get(name);
    if (!f) problems.push(`missing single-select field "${name}"`);
    else if (!(f.options instanceof Map)) problems.push(`field "${name}" must be a single-select (found a non-select field)`);
  }
  for (const name of textFields) {
    const f = meta.fields.get(name);
    if (!f) problems.push(`missing text field "${name}"`);
    else if (f.options !== null) problems.push(`field "${name}" must be a text field (found a single-select field)`);
  }
  if (problems.length > 0) {
    throw new UserError(`Project schema is invalid:\n  - ${problems.join('\n  - ')}`);
  }
}

const ITEM_FRAGMENT = `
  id
  content{ __typename ... on Issue { number title body url repository { nameWithOwner } } }
  fieldValues(first:50){ nodes{
    __typename
    ... on ProjectV2ItemFieldTextValue { text field{ ... on ProjectV2FieldCommon { name } } }
    ... on ProjectV2ItemFieldSingleSelectValue { name field{ ... on ProjectV2FieldCommon { name } } }
  } }`;

function parseItemNode(node) {
  const fields = {};
  for (const fv of node.fieldValues?.nodes || []) {
    const name = fv.field?.name;
    if (!name) continue;
    if (typeof fv.text === 'string') fields[name] = fv.text;
    else if (typeof fv.name === 'string') fields[name] = fv.name;
  }
  const issue = node.content?.__typename === 'Issue'
    ? {
        number: node.content.number,
        title: node.content.title,
        body: node.content.body,
        url: node.content.url,
        // The repository the Issue physically lives in. For external-backlog
        // items this differs from the Domain repo, so all issue writes MUST
        // target this slug rather than cfg.domainRepoSlug.
        repo: node.content.repository?.nameWithOwner || null,
      }
    : null;
  return { itemId: node.id, issue, fields };
}

/** Read the FULL set of Project items via cursor pagination. */
async function readAllItems(cfg, meta) {
  const query = `query($login:String!,$number:Int!,$cursor:String){
    ${meta.ownerType}(login:$login){
      projectV2(number:$number){
        items(first:100, after:$cursor){
          pageInfo{ hasNextPage endCursor }
          nodes{ ${ITEM_FRAGMENT} }
        }
      }
    }
  }`;
  const items = [];
  let cursor = null;
  for (;;) {
    const args = [
      'api', 'graphql', '-f', `query=${query}`,
      '-f', `login=${cfg.project.owner}`, '-F', `number=${cfg.project.number}`,
    ];
    if (cursor) args.push('-f', `cursor=${cursor}`);
    const data = await ghJson(args);
    const conn = data.data[meta.ownerType].projectV2.items;
    for (const node of conn.nodes) items.push(parseItemNode(node));
    if (!conn.pageInfo.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
  }
  return items;
}

/** Re-read a single item by node id (used to confirm a claim without a race). */
async function readItemById(itemId) {
  const query = `query($id:ID!){ node(id:$id){ ... on ProjectV2Item { ${ITEM_FRAGMENT} } } }`;
  const data = await ghJson(['api', 'graphql', '-f', `query=${query}`, '-f', `id=${itemId}`]);
  const node = data.data.node;
  return node ? parseItemNode(node) : null;
}

// ---------------------------------------------------------------------------
// Project writes (gh project item-edit)
// ---------------------------------------------------------------------------

async function setTextField(cfg, meta, itemId, fieldName, value) {
  const field = meta.fields.get(fieldName);
  if (!field) throw new Error(`Project has no field named "${fieldName}".`);
  const base = [
    'project', 'item-edit',
    '--id', itemId,
    '--field-id', field.id,
    '--project-id', meta.projectId,
  ];
  if (value === '' || value == null) base.push('--clear');
  else base.push('--text', String(value));
  await gh(base);
}

async function setSelectField(cfg, meta, itemId, fieldName, optionName) {
  const field = meta.fields.get(fieldName);
  if (!field || !field.options) throw new Error(`Project has no single-select field "${fieldName}".`);
  const optId = field.options.get(optionName);
  if (!optId) throw new Error(`Field "${fieldName}" has no option "${optionName}".`);
  await gh([
    'project', 'item-edit',
    '--id', itemId,
    '--field-id', field.id,
    '--project-id', meta.projectId,
    '--single-select-option-id', optId,
  ]);
}

// ---------------------------------------------------------------------------
// Issue writes
// ---------------------------------------------------------------------------

/** Derive an "owner/name" repo slug from a GitHub Issue/PR URL, else null.
 *  Used as a fallback when a worker's stored content repo is unavailable
 *  (e.g. a task.json written before repo tracking existed). */
function repoFromUrl(url) {
  const m = /github\.com\/([^/\s]+)\/([^/\s]+)\/(?:issues|pull)\//.exec(String(url || ''));
  return m ? `${m[1]}/${m[2]}` : null;
}

async function issueComment(repoSlug, number, bodyText) {
  await gh(['issue', 'comment', String(number), '--repo', repoSlug, '--body', bodyText]);
}

// ---------------------------------------------------------------------------
// Field-value helpers with documented defaults
// ---------------------------------------------------------------------------

const val = (item, name, dflt = '') => (item.fields[name] ?? dflt);
const ownerOf = (item) => val(item, FIELD.owner, 'unassigned') || 'unassigned';
const statusOf = (item) => val(item, FIELD.status, 'untriaged') || 'untriaged';
const priorityOf = (item) => val(item, FIELD.priority, 'normal') || 'normal';

function leaseIsFree(item, identity) {
  const until = val(item, FIELD.leaseUntil, '');
  const claimedBy = val(item, FIELD.claimedBy, '');
  if (claimedBy === identity) return true;
  if (!until) return true;
  const t = Date.parse(until);
  // A non-empty lease-until that fails to parse is a corrupt value; per the
  // schema a lease is free only when empty, in the past, or claimed by this
  // runner. Treat an unparseable timestamp as OCCUPIED rather than free so a
  // corrupt value can't hand the item to a second runner, and surface it.
  if (Number.isNaN(t)) {
    logErr(`warning: unparseable ${FIELD.leaseUntil} value "${until}" on item; treating lease as occupied`);
    return false;
  }
  return t < Date.now();
}

/** Corroborate a `.pan/worker.running` marker by checking the recorded PID in
 *  `.pan/worker.pid` is actually a live process. Returns true only when the PID
 *  file is present, parseable, and `process.kill(pid, 0)` confirms the process
 *  exists. A missing/unparseable pid file or an ESRCH (dead/gone) process reads
 *  as not alive; EPERM means the process exists but is owned by another user, so
 *  it counts as alive. */
async function workerPidAlive(panDir) {
  let raw;
  try {
    raw = (await readFile(path.join(panDir, 'worker.pid'), 'utf8')).trim();
  } catch {
    return false;
  }
  // Require the entire trimmed file to be a clean positive integer. A missing,
  // empty, or malformed value (e.g. "14605junk") reads as a vanished worker.
  if (!/^\d+$/.test(raw)) return false;
  const pid = Number(raw);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === 'EPERM';
  }
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(msg) {
  process.stdout.write(`[pan-runner ${new Date().toISOString()}] ${msg}\n`);
}
function logErr(msg) {
  process.stderr.write(`[pan-runner ${new Date().toISOString()}] ${msg}\n`);
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

class Runner {
  constructor(cfg, meta, playbooks) {
    this.cfg = cfg;
    this.meta = meta;
    this.playbooks = playbooks;
    this.active = new Map();      // issueNumber -> worker state
    this.failCounts = new Map();  // issueNumber -> consecutive operational failures
    this.draining = false;
    this.hardStop = false;
    this.wakeController = null; // aborts an in-progress idle/backoff sleep on drain
  }

  activeCount() {
    return this.active.size;
  }
  activeForPlaybook(name) {
    let n = 0;
    for (const w of this.active.values()) if (w.playbook === name) n += 1;
    return n;
  }

  leaseTimestamp() {
    return new Date(Date.now() + this.cfg.leaseMinutes * 60000).toISOString();
  }

  // ---- Poll + claim -------------------------------------------------------

  async pollAndClaim() {
    const items = await readAllItems(this.cfg, this.meta);

    const candidates = items.filter((it) => {
      if (ownerOf(it) !== 'agent') return false;
      if (statusOf(it) !== 'ready') return false;
      const pb = val(it, FIELD.playbook, '');
      if (!pb || !this.playbooks.has(pb)) return false;
      if (this.playbooks.get(pb).capacity <= 0) return false;
      if (!leaseIsFree(it, this.cfg.identity)) return false;
      if (it.issue && this.active.has(it.issue.number)) return false;
      return true;
    });

    // Sort by priority, preserving Project order (items array order) among ties.
    candidates.sort((a, b) => {
      const pa = PRIORITY_RANK[priorityOf(a)] ?? 2;
      const pb = PRIORITY_RANK[priorityOf(b)] ?? 2;
      if (pa !== pb) return pa - pb;
      return items.indexOf(a) - items.indexOf(b);
    });

    let claimed = 0;
    for (const it of candidates) {
      if (this.draining) break;
      if (this.activeCount() >= this.cfg.maxConcurrent) break;
      const pb = val(it, FIELD.playbook, '');
      if (this.activeForPlaybook(pb) >= this.playbooks.get(pb).capacity) continue;

      const ok = await this.claimAndLaunch(it);
      if (ok) claimed += 1;
    }
    return { candidates: candidates.length, claimed };
  }

  /** Claim one item (re-read to avoid races), then launch its worker. */
  async claimAndLaunch(item) {
    const number = item.issue?.number;
    if (!number) return false;

    // Re-read and re-confirm dispatchable + unleased.
    const fresh = await readItemById(item.itemId);
    if (!fresh || !fresh.issue) return false;
    if (ownerOf(fresh) !== 'agent' || statusOf(fresh) !== 'ready') return false;
    if (!leaseIsFree(fresh, this.cfg.identity)) return false; // claim race — skip
    const pb = val(fresh, FIELD.playbook, '');
    if (!this.playbooks.has(pb)) return false;

    // The playbook may have changed between poll and this re-read; revalidate
    // capacity against the freshly-read playbook before claiming.
    const cap = this.playbooks.get(pb).capacity;
    if (cap <= 0) {
      log(`#${number} playbook changed to "${pb}" which is disabled on re-read; skipping`);
      return false;
    }
    if (this.activeCount() >= this.cfg.maxConcurrent) {
      log(`#${number} at global capacity on re-read (playbook "${pb}"); skipping`);
      return false;
    }
    if (this.activeForPlaybook(pb) >= cap) {
      log(`#${number} playbook "${pb}" at capacity on re-read; skipping`);
      return false;
    }

    // Record the claim: claimed-by, lease-until, Status=in-progress.
    const leaseWritten = this.leaseTimestamp();
    try {
      await setTextField(this.cfg, this.meta, item.itemId, FIELD.claimedBy, this.cfg.identity);
      await setTextField(this.cfg, this.meta, item.itemId, FIELD.leaseUntil, leaseWritten);
      await setSelectField(this.cfg, this.meta, item.itemId, FIELD.status, 'in-progress');
    } catch (e) {
      logErr(`claim write failed for #${number}: ${e.message}`);
      return false;
    }

    log(`claimed #${number} (${pb})`);

    // Confirming re-read (best-effort optimistic concurrency — GitHub has no
    // atomic CAS). Another runner may have written its own claim between our
    // re-read above and our writes. Re-read now and verify we still own the
    // item: claimed-by must still be us AND lease-until must be the exact value
    // we wrote. If either changed, a foreign claim won — ABANDON without writing
    // anything (do not stomp the winner's fields) and skip this item this cycle.
    let confirm;
    try {
      confirm = await readItemById(item.itemId);
    } catch (e) {
      // Unlike a foreign-claim loss (where the read SUCCEEDS and shows we lost),
      // a THROW here leaves the item in-progress with our lease but no worker,
      // supervision, or local state — stranded forever, since polling only
      // considers Status=ready. Treat it as an operational failure so the item
      // is requeued to ready (best-effort writes) and counts toward the
      // consecutive-failure tally for 3-strikes escalation. The item was never
      // added to this.active, so handleOperationalFailure's active.delete is a
      // harmless no-op. Do NOT launch a worker.
      await this.handleOperationalFailure(
        { itemId: item.itemId, issueNumber: number, url: item.issue?.url, repo: item.issue?.repo },
        `claim confirm re-read failed: ${e.message}`,
      );
      return false;
    }
    const confirmClaimed = confirm ? val(confirm, FIELD.claimedBy, '') : '';
    const confirmLease = confirm ? val(confirm, FIELD.leaseUntil, '') : '';
    if (!confirm || confirmClaimed !== this.cfg.identity || confirmLease !== leaseWritten) {
      log(`#${number} claim lost to another runner (claimed-by=${JSON.stringify(confirmClaimed)}); abandoning without writing`);
      return false;
    }

    // Guard against concurrent use of a shared FIXED workingDirectory. Two
    // workers sharing one `.pan/` would clobber each other's signals and task
    // context (the pre-launch stale-signal cleanup wipes the other's marker),
    // so a worker could finalize the wrong task. Isolated workspaces are
    // per-task unique and never collide. This is a benign capacity collision,
    // not an operational failure: revert the just-written claim to `ready` and
    // do NOT count a strike. We only reach here still owning the claim, so the
    // revert cannot stomp another runner's winning claim.
    const pbObj = this.playbooks.get(pb);
    if (pbObj?.workingDirectory) {
      const resolvedDir = path.resolve(pbObj.workingDirectory);
      let collision = false;
      for (const w of this.active.values()) {
        if (w.workingDir && path.resolve(w.workingDir) === resolvedDir) {
          collision = true;
          break;
        }
      }
      if (collision) {
        try {
          await setTextField(this.cfg, this.meta, item.itemId, FIELD.claimedBy, '');
          await setTextField(this.cfg, this.meta, item.itemId, FIELD.leaseUntil, '');
          await setSelectField(this.cfg, this.meta, item.itemId, FIELD.status, 'ready');
        } catch (e) {
          logErr(`revert-to-ready writes failed for #${number}: ${e.message}`);
        }
        log(
          `#${number} skipped: fixed workingDirectory ${resolvedDir} already in use by an active worker; returned to ready`,
        );
        return false;
      }
    }

    try {
      await this.launchWorker(fresh, pb);
      return true;
    } catch (e) {
      logErr(`launch failed for #${number}: ${e.message}`);
      await this.handleOperationalFailure(
        { itemId: item.itemId, issueNumber: number, url: item.issue?.url, repo: item.issue?.repo },
        `launch failed: ${e.message}`,
      );
      return false;
    }
  }

  // ---- Launch -------------------------------------------------------------

  async launchWorker(item, playbookName) {
    const pb = this.playbooks.get(playbookName);
    const number = item.issue.number;

    // 1. Working directory: fixed workingDirectory, else isolated workspace.
    let workingDir;
    let isolated = false;
    if (pb.workingDirectory) {
      workingDir = pb.workingDirectory;
      await mkdir(workingDir, { recursive: true });
    } else {
      isolated = true;
      workingDir = path.join(this.cfg.workspaceRoot, `pan-${number}-${Date.now()}`);
      await mkdir(workingDir, { recursive: true });
    }

    const panDir = path.join(workingDir, '.pan');
    await mkdir(panDir, { recursive: true });

    // Clear any stale signal files from a previous task. This matters for a
    // fixed workingDirectory whose `.pan/` is reused; an isolated workspace is
    // already fresh, but clearing unconditionally is simplest and harmless.
    await Promise.all(
      ['result.json', 'needs-human.json', 'worker.running', 'worker.pid', 'pan.md'].map((f) =>
        rm(path.join(panDir, f), { force: true }),
      ),
    );

    // 2. Task context files.
    const task = {
      number,
      title: item.issue.title,
      body: item.issue.body,
      url: item.issue.url,
      repo: item.issue.repo || repoFromUrl(item.issue.url),
      playbook: playbookName,
      workstream: val(item, FIELD.workstream, '') || null,
      // No durable answer store exists yet; answers arrive live in the terminal.
      // TODO: seed prior recorded answers here when a store is introduced.
      answers: [],
    };
    await writeFile(path.join(panDir, 'task.json'), JSON.stringify(task, null, 2));
    await writeFile(path.join(panDir, 'playbook.md'), pb.body);

    // Domain-specific instructions live in the Domain repo's pan.md and must
    // reach the worker (playbooks and worker-base-instructions alone don't
    // carry them). Fetch it live, best-effort: a Domain without a pan.md simply
    // gets no file, and a transient read failure must not block the launch.
    let hasDomainPan = false;
    try {
      const domainPan = await readDomainFile(this.cfg, 'pan.md');
      await writeFile(path.join(panDir, 'pan.md'), domainPan);
      hasDomainPan = true;
    } catch (e) {
      logErr(`could not fetch Domain pan.md for #${number} (continuing without it): ${e.message}`);
    }

    const systemDir = path.join(this.cfg.panCheckout, 'system');
    const prompt = this.buildPrompt(systemDir, playbookName, hasDomainPan);
    await writeFile(path.join(panDir, 'launch-prompt.txt'), prompt);

    // Generate the Node launcher. It runs with its CWD set to workingDir and
    // passes the prompt to copilot as a single argv element, so no shell ever
    // re-parses the (domain-controlled) prompt text on any platform.
    await writeFile(path.join(panDir, 'launch.mjs'), this.buildLauncherSource());

    // 3. Launch a headed copilot session in a visible terminal window.
    await this.spawnTerminal(workingDir, panDir);

    // 4. Register supervision state.
    this.active.set(number, {
      itemId: item.itemId,
      issueNumber: number,
      title: item.issue.title,
      url: item.issue.url,
      repo: item.issue.repo || repoFromUrl(item.issue.url),
      playbook: playbookName,
      workingDir,
      panDir,
      isolated,
      startedAt: Date.now(),
      lastRenew: Date.now(),
      hadNeedsHuman: !!val(item, FIELD.needsHumanSince, ''),
      needsHumanRelayed: false,
      warnedPartialNeedsHuman: false,
      lastBadOutcome: null,
      finished: false,
    });
    log(`launched worker for #${number} in ${workingDir}`);
  }

  buildPrompt(systemDir, playbookName, hasDomainPan = false) {
    // Single line: some terminal launchers only read the first line of the file.
    return [
      `You are a Pan worker doing exactly one task.`,
      `Read and follow ${path.join(systemDir, 'worker-base-instructions.md')}.`,
      `The Pan system documents are in ${systemDir}.`,
      hasDomainPan
        ? `Read .pan/pan.md in this working directory for Domain-specific instructions and apply them.`
        : ``,
      `Your task is in .pan/task.json and your playbook "${playbookName}" is in .pan/playbook.md, both in this working directory.`,
      `Signal that you need the user by writing .pan/needs-human.json (delete it once resolved), and write .pan/result.json exactly once when finished.`,
      `Do not edit any GitHub Project field yourself. Begin.`,
    ].filter(Boolean).join(' ');
  }

  async spawnTerminal(workingDir, panDir) {
    if (this.cfg.terminalKind === 'macos-terminal') {
      return this.spawnMacTerminal(workingDir, panDir);
    }
    if (this.cfg.terminalKind === 'windows-terminal') {
      return this.spawnWindowsTerminal(workingDir, panDir);
    }
    throw new Error(`Unsupported terminalKind: ${this.cfg.terminalKind}`);
  }

  /**
   * Source for the generated `.pan/launch.mjs`. Run with CWD = the worker
   * working directory, it maintains the liveness marker and pid, then spawns
   * copilot with the prompt as a single argv element (never re-parsed by any
   * shell). copilotBin/copilotArgs are baked in as JSON literals so the
   * launcher reads no config at runtime. Permission flags derived from
   * workerPermissions are prepended to copilotArgs.
   */
  buildLauncherSource() {
    const copilotBin = JSON.stringify(this.cfg.copilotBin);
    const copilotArgs = JSON.stringify([...this.cfg.permissionArgs, ...this.cfg.copilotArgs]);
    return `import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';

// Baked in by the runner; the launcher reads no config at runtime.
const copilotBin = ${copilotBin};
const copilotArgs = ${copilotArgs};

const marker = '.pan/worker.running';
let cleaned = false;
function cleanup() {
  if (cleaned) return;
  cleaned = true;
  try { rmSync(marker, { force: true }); } catch {}
}

try { writeFileSync('.pan/worker.pid', String(process.pid)); } catch {}
try { writeFileSync(marker, ''); } catch {}

// Remove the marker on normal exit and on window-close signals, mirroring the
// old bash \`trap\`. A hard kill (SIGKILL) cannot run handlers; the runner's
// rehydration requeue and liveness grace still recover a truly-gone worker.
process.on('exit', cleanup);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => { cleanup(); process.exit(130); });
}

const promptText = readFileSync('.pan/launch-prompt.txt', 'utf8');
const child = spawn(copilotBin, [...copilotArgs, promptText], { stdio: 'inherit' });
child.on('error', (e) => { cleanup(); console.error(e.message); process.exit(1); });
child.on('exit', (code, signal) => {
  cleanup();
  process.exit(code == null ? (signal ? 1 : 0) : code);
});
`;
  }

  async spawnMacTerminal(workingDir, panDir) {
    // The Node launcher (.pan/launch.mjs) owns the liveness marker and pid; we
    // only cd into the working dir and run it. No prompt text flows through the
    // shell — the sole shell-quoted values are the controlled working-dir path
    // and nodeBin.
    void panDir;
    const nodeBin = this.cfg.nodeBin;
    const doScript = `cd ${shQuote(workingDir)} && ${shQuote(nodeBin)} .pan/launch.mjs`;
    await spawnOk('osascript', [
      '-e', 'tell application "Terminal" to activate',
      '-e', `tell application "Terminal" to do script "${appleScriptEscape(doScript)}"`,
    ]);
  }

  async spawnWindowsTerminal(workingDir, panDir) {
    // Launch the Node launcher (.pan/launch.mjs) via an argv array with no cmd
    // prompt expansion. `-d workingDir` sets the CWD so the launcher's relative
    // `.pan/...` paths resolve. The launcher maintains the liveness marker
    // (including on window-close signals), so no batch file is needed.
    void panDir;
    await spawnOk(
      'wt.exe',
      ['-w', '0', 'nt', '-d', workingDir, this.cfg.nodeBin, path.join('.pan', 'launch.mjs')],
      { detached: true },
    );
  }

  // ---- Supervision --------------------------------------------------------

  async superviseTick() {
    for (const [number, w] of [...this.active.entries()]) {
      if (w.finished) {
        this.active.delete(number);
        continue;
      }
      try {
        await this.superviseWorker(w);
      } catch (e) {
        logErr(`supervise error for #${number}: ${e.message}`);
      }
    }
  }

  async superviseWorker(w) {
    const resultPath = path.join(w.panDir, 'result.json');
    const needsHumanPath = path.join(w.panDir, 'needs-human.json');
    const markerPath = path.join(w.panDir, 'worker.running');

    // Ownership gate FIRST. At the renewal cadence we re-read the item and
    // confirm we still hold the claim BEFORE performing any Project-mutating
    // supervision (completion, needs-human relay, liveness). If another runner
    // took the claim while we weren't looking, this prevents us from stomping
    // the new owner's item: we detect the lost lease here and bail without
    // writing. When the cadence is not due we skip the re-read (as before) and
    // proceed straight to supervision.
    const renewDue = Date.now() - w.lastRenew >= (this.cfg.leaseMinutes * 60000) / 3;
    if (renewDue) {
      let fresh;
      try {
        fresh = await readItemById(w.itemId);
      } catch (e) {
        logErr(`lease re-read failed for #${w.issueNumber}: ${e.message}`);
        return; // transient; retry next tick without mutating blindly
      }
      const claimedBy = fresh ? val(fresh, FIELD.claimedBy, '') : '';
      if (!fresh || claimedBy !== this.cfg.identity || statusOf(fresh) !== 'in-progress') {
        // The lease is no longer ours (or the item vanished / moved on). Stop
        // supervising without writing any of its fields — another runner may
        // hold a valid claim we must not stomp. releaseFields:false keeps this
        // the non-writing lease-lost path.
        await this.handleOperationalFailure(w, 'lease lost', { releaseFields: false });
        return;
      }
      // We still own the item: renew the lease now, then fall through to the
      // normal completion / needs-human / liveness handling below.
      try {
        await setTextField(this.cfg, this.meta, w.itemId, FIELD.leaseUntil, this.leaseTimestamp());
        w.lastRenew = Date.now();
      } catch (e) {
        logErr(`lease renew failed for #${w.issueNumber}: ${e.message}`);
      }
    }

    // Completion first. finalize() returns true only when it actually
    // transitioned the item; a bad/unreadable result.json returns false, and we
    // fall through to keep supervising (needs-human relay, liveness) this tick
    // rather than stalling with a lingering bad file.
    if (existsSync(resultPath)) {
      const finalized = await this.finalize(w, resultPath);
      if (finalized) return;
    }

    // Human-attention relay. On a partial/unreadable write (present file that
    // fails to parse, or no usable question), do NOT set needs-human-since,
    // post a comment, or mark hadNeedsHuman — leave the signal unhandled and
    // retry parsing next tick. Only act once we have a valid parsed question.
    const needsHuman = existsSync(needsHumanPath);
    if (needsHuman) {
      if (!w.needsHumanRelayed) {
        let parsed = null;
        try {
          parsed = JSON.parse(await readFile(needsHumanPath, 'utf8'));
        } catch {
          parsed = null;
        }
        const question = parsed && typeof parsed.question === 'string' && parsed.question.trim()
          ? parsed.question.trim()
          : null;
        if (!question) {
          // File present but not yet fully written (or missing a question).
          if (!w.warnedPartialNeedsHuman) {
            log(`#${w.issueNumber} needs-human.json present but not yet complete; waiting for a full write`);
            w.warnedPartialNeedsHuman = true;
          }
        } else {
          const since = parsed.since || new Date().toISOString();
          await setTextField(this.cfg, this.meta, w.itemId, FIELD.needsHumanSince, since);
          await issueComment(this.issueRepoOf(w), w.issueNumber, `⏳ Worker needs the user:\n\n> ${question}`);
          w.hadNeedsHuman = true;
          w.needsHumanRelayed = true;
          w.warnedPartialNeedsHuman = false;
          log(`#${w.issueNumber} needs human`);
        }
      }
    } else {
      // File absent: clear a lingering/stale field exactly once, and reset
      // latches so a future file relays.
      if (w.hadNeedsHuman) {
        await setTextField(this.cfg, this.meta, w.itemId, FIELD.needsHumanSince, '');
        w.hadNeedsHuman = false;
        log(`#${w.issueNumber} human question cleared`);
      }
      w.needsHumanRelayed = false;
      w.warnedPartialNeedsHuman = false;
    }

    // Liveness: after a startup grace, a worker is "gone" when it has NOT
    // written a result.json AND is not alive. Alive means the marker file is
    // present AND the recorded PID is a live process. A hard-killed worker
    // (SIGKILL) leaves the marker file behind but its launcher process dead, so
    // a marker-only check would renew the lease forever; incorporating PID
    // liveness catches that. The startup grace prevents a false positive before
    // the launcher has written its pid, and we only vanish when result.json is
    // absent (a finished worker that wrote result.json is finalized above, not
    // requeued).
    //
    // On macOS the terminal is launched via `open`/`osascript` and on Windows
    // via `wt.exe`, but the generated `.pan/launch.mjs` writes its OWN pid to
    // `.pan/worker.pid`, so the tracked PID is the real local launcher node
    // process and `process.kill(pid, 0)` is reliable for BOTH terminal kinds.
    // If a future terminal kind cannot yield a trackable local PID, the
    // marker-only presence check remains the fallback.
    const age = Date.now() - w.startedAt;
    if (
      age > DEFAULTS.workerStartGraceSeconds * 1000 &&
      !existsSync(resultPath) &&
      !(existsSync(markerPath) && (await workerPidAlive(w.panDir)))
    ) {
      await this.handleOperationalFailure(w, 'worker vanished (marker gone or PID dead)');
      return;
    }
  }

  /** Resolve the repo slug for a worker's Issue writes. Prefers the repository
   *  captured from the Project item, falls back to the Issue URL, and finally
   *  to the Domain repo. External-backlog Issues live in their own repo, so
   *  this must never be assumed to be cfg.domainRepoSlug. */
  issueRepoOf(w) {
    return w.repo || repoFromUrl(w.url) || this.cfg.domainRepoSlug;
  }

  async finalize(w, resultPath) {
    let result;
    try {
      result = JSON.parse(await readFile(resultPath, 'utf8'));
    } catch (e) {
      // Result file present but unreadable/partial; try again next tick.
      logErr(`result.json unreadable for #${w.issueNumber}: ${e.message}`);
      return false;
    }
    const outcome = result.outcome;
    if (outcome !== 'done' && outcome !== 'needs-review') {
      // Invalid/missing outcome: do not default to done. Leave the worker
      // active so it can be corrected (retried next tick). Log once per value.
      if (w.lastBadOutcome !== String(outcome)) {
        logErr(
          `result.json for #${w.issueNumber} has invalid outcome ${JSON.stringify(outcome)}; ` +
            `expected "done" or "needs-review". Leaving worker active.`,
        );
        w.lastBadOutcome = String(outcome);
      }
      return false;
    }
    const summary = result.summary || '(no summary)';
    const details = result.details || '';

    const status = outcome === 'needs-review' ? 'in-review' : 'done';
    // TODO (best-effort v1): for pull-request work, confirm the PR merged on
    // GitHub before setting `done`. Not yet implemented; see bin/README.md.
    let comment = `✅ Worker finished (${outcome}): ${summary}`;
    if (details) comment += `\n\n${details}`;
    if (outcome === 'done') {
      comment += `\n\n_Note: runner did not independently confirm any pull-request merge (v1 limitation)._`;
    }

    try {
      await issueComment(this.issueRepoOf(w), w.issueNumber, comment);
      // Clear any lingering human-attention signal on completion (idempotent).
      await setTextField(this.cfg, this.meta, w.itemId, FIELD.needsHumanSince, '');
      await setSelectField(this.cfg, this.meta, w.itemId, FIELD.status, status);
      await setTextField(this.cfg, this.meta, w.itemId, FIELD.leaseUntil, '');
      await setTextField(this.cfg, this.meta, w.itemId, FIELD.claimedBy, '');
    } catch (e) {
      logErr(`finalize writes failed for #${w.issueNumber}: ${e.message}`);
      return false; // retry next tick
    }

    w.finished = true;
    this.failCounts.delete(w.issueNumber);
    this.active.delete(w.issueNumber);
    log(`#${w.issueNumber} → ${status}`);
    return true;
  }

  /** Operational failure: return the task to `ready`; escalate after 3 in a row.
   *  When `releaseFields` is false (e.g. a lost lease we no longer own), still
   *  count the failure and stop supervising, but never write the item's fields —
   *  another runner may now hold a valid claim we must not overwrite.
   *  When `releaseFields` is true, the item's ownership is re-read best-effort
   *  before any field writes: if the re-read positively shows a foreign runner
   *  now holds the claim, all field writes are skipped to avoid stomping that
   *  owner (the strike is still counted). Absent positive evidence of a foreign
   *  owner (re-read shows our identity, an empty claim, or fails/returns null),
   *  the writes proceed as before. */
  async handleOperationalFailure(w, reason, { releaseFields = true } = {}) {
    const number = w.issueNumber;
    const count = (this.failCounts.get(number) || 0) + 1;
    this.failCounts.set(number, count);
    this.active.delete(number);
    logErr(`operational failure #${number} (${count}/3): ${reason}`);

    if (!releaseFields) {
      // We do not own the item; do not touch any of its fields.
      if (count >= 3) {
        logErr(`#${number} reached 3 consecutive failures via lease loss; not writing fields (not owned)`);
      }
      return;
    }

    // Best-effort confirming re-read before any writes: never stomp a foreign
    // runner that may have claimed the item during a race window.
    try {
      const fresh = await readItemById(w.itemId);
      if (fresh) {
        const claimedBy = val(fresh, FIELD.claimedBy, '');
        if (claimedBy && claimedBy !== this.cfg.identity) {
          logErr(`#${number} now claimed by "${claimedBy}"; skipping field release to avoid stomping the current owner`);
          return;
        }
      }
    } catch (e) {
      // Re-read failed: fall through and release best-effort (we most likely
      // still own the item; leaving it stranded would be worse).
    }

    try {
      if (count >= 3) {
        // Raise human attention so an unattended runner can't retry forever.
        await setTextField(this.cfg, this.meta, w.itemId, FIELD.leaseUntil, '');
        await setTextField(this.cfg, this.meta, w.itemId, FIELD.claimedBy, '');
        await setTextField(this.cfg, this.meta, w.itemId, FIELD.needsHumanSince, new Date().toISOString());
        await setSelectField(this.cfg, this.meta, w.itemId, FIELD.status, 'blocked');
        await issueComment(
          this.issueRepoOf(w),
          number,
          `⚠️ Pan runner hit 3 consecutive operational failures on this task and stopped retrying.\n\nLast reason: ${reason}`,
        );
        log(`#${number} escalated to human attention after 3 failures`);
      } else {
        // Return to ready with state intact.
        await setTextField(this.cfg, this.meta, w.itemId, FIELD.claimedBy, '');
        await setTextField(this.cfg, this.meta, w.itemId, FIELD.leaseUntil, '');
        await setSelectField(this.cfg, this.meta, w.itemId, FIELD.status, 'ready');
        log(`#${number} returned to ready`);
      }
    } catch (e) {
      logErr(`failure-handling writes failed for #${number}: ${e.message}`);
    }
  }

  // ---- Rehydration (best-effort) -----------------------------------------

  /**
   * Best-effort restart adoption: scan workspaceRoot for isolated workspaces.
   *
   * - A workspace with a pending `.pan/result.json` (produced while the runner
   *   was down) whose item is still claimed by us is finalized through the
   *   normal result path, so a completed task is not left stuck in-progress.
   * - A workspace whose worker is still alive (marker present AND its recorded
   *   PID is a live process) and not finished, whose item is still claimed by
   *   us, is re-adopted for supervision.
   * - A workspace whose marker is gone — OR whose marker is present but whose
   *   recorded PID is dead/missing (a vanished worker) — with the item still
   *   ours and `in-progress`, is requeued to `ready` as bounded, safe cleanup.
   *
   * LIMITATION: playbooks with a fixed workingDirectory are not discovered here
   * (there is no persisted registry of launched handles), and a worker's exact
   * child process cannot be re-attached. See bin/README.md.
   */
  async rehydrate() {
    if (!existsSync(this.cfg.workspaceRoot)) return;
    let entries;
    try {
      entries = await readdir(this.cfg.workspaceRoot);
    } catch {
      return;
    }
    // Read the Project once, up front, with the same bounded retry/backoff the
    // gh wrapper uses. rehydrate runs once at startup: a transient read failure
    // must not silently abandon live workers, so fail startup instead.
    let items;
    let attempt = 0;
    for (;;) {
      try {
        items = await readAllItems(this.cfg, this.meta);
        break;
      } catch (e) {
        if (attempt < DEFAULTS.ghMaxRetries) {
          const wait = Math.min(2 ** attempt, 30) * 1000;
          logErr(`rehydrate: reading Project failed (${e.message}); retrying in ${wait / 1000}s`);
          await sleep(wait);
          attempt += 1;
          continue;
        }
        logErr(`rehydrate: could not read Project after ${DEFAULTS.ghMaxRetries} retries; aborting startup`);
        throw e;
      }
    }
    for (const entry of entries) {
      const workingDir = path.join(this.cfg.workspaceRoot, entry);
      const panDir = path.join(workingDir, '.pan');
      const taskPath = path.join(panDir, 'task.json');
      const markerPath = path.join(panDir, 'worker.running');
      const resultPath = path.join(panDir, 'result.json');
      const needsHumanPath = path.join(panDir, 'needs-human.json');
      try {
        const st = await stat(workingDir);
        if (!st.isDirectory()) continue;
      } catch {
        continue;
      }
      // Only skip when the task context is missing; a present result.json must
      // be adopted and finalized, not dropped.
      if (!existsSync(taskPath)) continue;

      let task;
      try {
        task = JSON.parse(await readFile(taskPath, 'utf8'));
      } catch {
        continue;
      }
      const number = task.number;
      if (!number || this.active.has(number)) continue;

      // Confirm the Project still shows this task claimed by us.
      const match = items.find((it) => it.issue?.number === number);
      if (!match) continue;
      if (val(match, FIELD.claimedBy, '') !== this.cfg.identity) {
        log(
          `#${number} no longer owned by this runner ` +
            `(claimed-by=${JSON.stringify(val(match, FIELD.claimedBy, ''))}); ` +
            `skipping adoption/finalization (rehydrate)`,
        );
        continue;
      }

      const w = {
        itemId: match.itemId,
        issueNumber: number,
        title: task.title,
        url: task.url,
        repo: task.repo || repoFromUrl(task.url),
        playbook: task.playbook,
        workingDir,
        panDir,
        isolated: true,
        startedAt: Date.now(),
        lastRenew: 0, // force an immediate lease renewal
        hadNeedsHuman: !!val(match, FIELD.needsHumanSince, ''),
        needsHumanRelayed: false,
        warnedPartialNeedsHuman: false,
        lastBadOutcome: null,
        finished: false,
      };

      // Pending result produced while we were down: finalize it now, but only
      // if the Project still shows this task as ours AND in-progress. The
      // claimed-by == identity guard above already ran; additionally requiring
      // Status == in-progress prevents clobbering a manual transition the user
      // made while the runner was offline. If it was externally transitioned,
      // skip finalization (do not write any Project fields; leave local .pan
      // state as-is) and move on. If the result is bad/unreadable, finalize
      // returns false and we fall through to liveness handling rather than
      // dropping the workspace.
      if (existsSync(resultPath)) {
        if (statusOf(match) !== 'in-progress') {
          log(
            `#${number} has a pending result but was externally transitioned ` +
              `(status=${statusOf(match)}); skipping finalization (rehydrate)`,
          );
          continue;
        }
        const finalized = await this.finalize(w, resultPath);
        if (finalized) continue;
      }

      // Liveness: the marker must be present AND its recorded PID must be a live
      // process. A missing marker, or a marker whose PID is dead/gone, is a
      // vanished worker: if the item is still ours and in-progress, requeue it
      // to `ready` rather than adopting a corpse and renewing its lease forever.
      const alive = existsSync(markerPath) && (await workerPidAlive(panDir));
      if (!alive) {
        if (statusOf(match) !== 'in-progress') continue;
        // Route through the same operational-failure path used elsewhere rather
        // than releasing fields directly: it re-reads ownership first (so it
        // won't stomp a claim a DIFFERENT runner has since taken), counts a
        // consecutive-operational-failure strike, and applies 3-strikes
        // escalation. This worker was never added to this.active, so the
        // internal active.delete is a harmless no-op (no double-release).
        await this.handleOperationalFailure(
          { itemId: match.itemId, issueNumber: number, url: task.url, repo: task.repo || repoFromUrl(task.url) },
          'worker vanished during downtime (marker gone or PID dead) (rehydrate)',
        );
        continue;
      }

      this.active.set(number, w);
      log(`rehydrated worker for #${number} from ${workingDir}`);
    }
  }

  // ---- Main loop ----------------------------------------------------------

  requestDrain() {
    if (this.draining) {
      this.hardStop = true;
      logErr('second interrupt — exiting now');
    } else {
      this.draining = true;
      logErr('draining: no new claims; supervising active workers until they finish');
    }
    // Wake any in-progress idle/backoff sleep so shutdown is prompt.
    this.wakeController?.abort();
  }

  /** Sleep that can be aborted by requestDrain() so SIGINT/SIGTERM promptly
   *  wakes the runner from an idle/backoff wait. A fresh controller is created
   *  per sleep (an aborted controller stays aborted); AbortError just ends the
   *  wait early rather than crashing. */
  async abortableSleep(ms) {
    this.wakeController = new AbortController();
    try {
      await sleep(ms, undefined, { signal: this.wakeController.signal });
    } catch (e) {
      if (e?.name !== 'AbortError') throw e;
    } finally {
      this.wakeController = null;
    }
  }

  async loop({ once }) {
    await this.rehydrate();

    let firstCycleDone = false;
    let idleSeconds = this.cfg.pollIntervalSeconds;

    for (;;) {
      if (this.hardStop) break;

      if (!this.draining && !(once && firstCycleDone)) {
        try {
          const { candidates, claimed } = await this.pollAndClaim();
          idleSeconds = claimed > 0 || candidates > 0
            ? this.cfg.pollIntervalSeconds
            : Math.min(idleSeconds * 1.5, DEFAULTS.idleBackoffMaxSeconds);
        } catch (e) {
          logErr(`poll cycle error: ${e.message}`);
          idleSeconds = Math.min(idleSeconds * 1.5, DEFAULTS.idleBackoffMaxSeconds);
        }
      }
      firstCycleDone = true;

      await this.superviseTick();

      // Exit conditions.
      if (once && this.activeCount() === 0) break;
      if (this.draining && this.activeCount() === 0) break;

      // Adaptive sleep: tick fast while supervising, back off when idle. The
      // sleep is abortable so a drain/shutdown signal wakes it promptly; the
      // loop top re-checks this.hardStop on the next iteration.
      const sleepSeconds = this.activeCount() > 0
        ? Math.min(DEFAULTS.superviseTickSeconds, idleSeconds)
        : idleSeconds;
      await this.abortableSleep(sleepSeconds * 1000);
    }

    if (this.activeCount() > 0) {
      log(`exiting with ${this.activeCount()} worker(s) still running in their terminals; they will be rehydrated on restart`);
    } else {
      log('exiting; no active workers');
    }
  }
}

// ---------------------------------------------------------------------------
// Small process/quoting helpers
// ---------------------------------------------------------------------------

/** Spawn a command with an argv array; resolve on exit 0, reject otherwise. */
function spawnOk(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'ignore', ...opts });
    child.on('error', (e) => reject(new Error(`${cmd} failed to start: ${e.message}`)));
    if (opts.detached) {
      child.unref();
      resolve();
      return;
    }
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`)),
    );
  });
}

/** POSIX single-quote a string for embedding in a /bin/bash script. */
function shQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}
/** Escape for an AppleScript double-quoted string literal. */
function appleScriptEscape(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main() {
  const args = parseCli(process.argv.slice(2));

  if (args.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  const cfg = await loadConfig(args.config);
  const meta = await loadProjectMeta(cfg);
  const playbooks = await loadPlaybooks(cfg);

  if (args['validate-config']) {
    validateProjectSchema(meta);
    log(`config OK: domain=${cfg.domainRepoSlug} project=${cfg.project.owner}/${cfg.project.number} machine=${cfg.machine}`);
    log(`worker permissions: ${cfg.workerPermissions}${cfg.workerPermissions === 'yolo' ? ' (workers launch with --allow-all)' : ''}`);
    log(`project schema OK: all 8 canonical fields present with correct types`);
    log(`playbooks this machine runs: ${[...playbooks.keys()].join(', ')}`);
    return 0;
  }

  const runner = new Runner(cfg, meta, playbooks);
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => runner.requestDrain());
  }

  log(`starting: identity=${cfg.identity} terminal=${cfg.terminalKind} once=${!!args.once}`);
  await runner.loop({ once: !!args.once });
  return 0;
}

main()
  .then((code) => process.exit(code ?? 0))
  .catch((err) => {
    if (err instanceof UserError) {
      logErr(err.message);
      process.stderr.write('\n' + USAGE);
      process.exit(2);
    }
    logErr(`fatal: ${err?.stack || err}`);
    process.exit(1);
  });
