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
 *                                             // human at the terminal. Either
 *                                             // way the runner also passes
 *                                             // --deny-tool ask_user so workers
 *                                             // signal via .pan/needs-human.json
 *                                             // instead of blocking on ask_user.
 *   "copilotArgs": [],                        // extra copilot flags, appended
 *                                             // after any permission flags
 *                                             // derived from workerPermissions.
 *                                             // Do NOT put "--interactive"/"-i"
 *                                             // here: the runner supplies the
 *                                             // prompt as the value of
 *                                             // --interactive itself (a bare
 *                                             // interactive flag is stripped)
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
import { randomUUID } from 'node:crypto';
import readline from 'node:readline';
import {
  cleanTerminalLeaseFields,
  FIELD,
  findProjectItemForTask,
  leaseIsFree,
  ownerOf,
  pendingFinalizationKind,
  preparePoll,
  statusOf,
  val,
} from './pan-runner-poll.js';
import {
  ensureIssueClosed,
  ensureIssueComment,
} from './pan-issue-lifecycle.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULTS = {
  pollIntervalSeconds: 30,
  leaseMinutes: 15,
  idleBackoffMaxSeconds: 120,
  superviseTickSeconds: 3,
  workerStartGraceSeconds: 20, // grace before we expect .pan/worker.running
  ghMaxRetries: 5,
};
const FINALIZATION_FAILURE_LIMIT = 3;
const FINALIZATION_RETRY_BASE_MS = 5000;

function terminalStatusForResult(result) {
  if (result?.outcome === 'done') return 'done';
  if (result?.outcome === 'needs-review') return 'in-review';
  return null;
}

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
  // Always deny the interactive `ask_user` tool. Runner-launched workers are
  // headed but unattended: a worker that asks a question through `ask_user`
  // blocks in its own terminal without setting the Issue's `needs-human-since`,
  // so the user is never told it is waiting. The worker contract requires
  // signalling via `.pan/needs-human.json` instead (see worker-base-instructions
  // and runner.md), so this tool must never be available regardless of the
  // permission level.
  const permissionArgs = [
    ...(workerPermissions === 'yolo' ? ['--allow-all'] : []),
    '--deny-tool=ask_user',
  ];

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
    copilotConfigPath:
      json.copilotConfigPath || path.join(os.homedir(), '.copilot', 'config.json'),
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
          ... on ProjectV2Field { dataType }
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

  const fields = new Map(); // name -> { id, dataType, options: Map(optName->optId)|null }
  for (const f of project.fields.nodes) {
    if (!f?.name) continue;
    const options = f.options ? new Map(f.options.map((o) => [o.name, o.id])) : null;
    const dataType = f.dataType ?? (options ? 'SINGLE_SELECT' : f.__typename);
    fields.set(f.name, { id: f.id, dataType, options });
  }
  return { ownerType, projectId: project.id, fields };
}

/** Validate the resolved Project against the canonical field contract. */
function validateProjectSchema(meta) {
  const singleSelects = ['Status', 'owner', 'priority'];
  const textFields = [
    'playbook',
    'workstream',
    'needs-human-since',
    'lease-until',
    'claimed-by',
    'machine',
    'session-id',
  ];
  const dateFields = ['next-action-date'];
  const problems = [];
  for (const name of singleSelects) {
    const f = meta.fields.get(name);
    if (!f) problems.push(`missing single-select field "${name}"`);
    else if (f.dataType !== 'SINGLE_SELECT' || !(f.options instanceof Map)) {
      problems.push(
        `field "${name}" must be a single-select (found ${f.dataType})`,
      );
    }
  }
  for (const name of textFields) {
    const f = meta.fields.get(name);
    if (!f) problems.push(`missing text field "${name}"`);
    else if (f.dataType !== 'TEXT') {
      problems.push(`field "${name}" must be a text field (found ${f.dataType})`);
    }
  }
  for (const name of dateFields) {
    const f = meta.fields.get(name);
    if (!f) problems.push(`missing date field "${name}"`);
    else if (f.dataType !== 'DATE') {
      problems.push(`field "${name}" must be a date field (found ${f.dataType})`);
    }
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
    ... on ProjectV2ItemFieldDateValue { date field{ ... on ProjectV2FieldCommon { name } } }
  } }`;

function parseItemNode(node) {
  const fields = {};
  for (const fv of node.fieldValues?.nodes || []) {
    const name = fv.field?.name;
    if (!name) continue;
    if (typeof fv.text === 'string') fields[name] = fv.text;
    else if (typeof fv.name === 'string') fields[name] = fv.name;
    else if (typeof fv.date === 'string') fields[name] = fv.date;
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

/** Best-effort removal of an inert isolated workspace directory. Only ever
 *  called during rehydrate for a directory under `workspaceRoot` (which holds
 *  only runner-created isolated workspaces) that has been confirmed inert — no
 *  live worker AND no longer owned/adoptable by this runner. Removing it stops
 *  finished workspaces from accumulating and being re-scanned and re-logged on
 *  every restart. A failure is logged but never fatal. */
async function pruneWorkspace(workingDir, number, why) {
  try {
    await rm(workingDir, { recursive: true, force: true });
    log(`#${number} pruned stale workspace ${workingDir} (${why}) (rehydrate)`);
  } catch (e) {
    logErr(`could not prune stale workspace ${workingDir} for #${number}: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

/** A human-friendly local-time stamp (`YYYY-MM-DD HH:MM:SS`) for console lines.
 *  Console output is for the person watching this runner's terminal, so it uses
 *  the machine's local time — not UTC. Timestamps written to the Project or to
 *  signal files (leases, needs-human `since`) stay RFC 3339 UTC. */
function consoleTimestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function log(msg) {
  process.stdout.write(`[pan-runner ${consoleTimestamp()}] ${msg}\n`);
}
function logErr(msg) {
  process.stderr.write(`[pan-runner ${consoleTimestamp()}] ${msg}\n`);
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

class Runner {
  constructor(cfg, meta, playbooks) {
    this.cfg = cfg;
    this.meta = meta;
    this.playbooks = playbooks;
    this.active = new Map();      // Project item id -> worker state
    this.failCounts = new Map();  // Project item id -> consecutive operational failures
    this.resumeWorkspaces = new Map(); // Project item id -> paused isolated workspace
    this.draining = false;
    this.hardStop = false;
    this.pollRequested = false;
    this.wakeController = null; // aborts an in-progress idle/backoff sleep
  }

  activeCount() {
    return this.active.size;
  }
  capacityCount() {
    let count = 0;
    for (const worker of this.active.values()) {
      if (!worker.finalizationPending) count += 1;
    }
    return count;
  }
  activeForPlaybook(name) {
    let n = 0;
    for (const w of this.active.values()) {
      if (w.playbook === name && !w.finalizationPending) n += 1;
    }
    return n;
  }

  leaseTimestamp() {
    return new Date(Date.now() + this.cfg.leaseMinutes * 60000).toISOString();
  }

  // ---- Poll + claim -------------------------------------------------------

  async pollAndClaim() {
    const items = await readAllItems(this.cfg, this.meta);
    const cleaned = await cleanTerminalLeaseFields(items, {
      readItem: readItemById,
      clearFields: async (itemId) => {
        await setTextField(
          this.cfg,
          this.meta,
          itemId,
          FIELD.leaseUntil,
          '',
        );
        await setTextField(
          this.cfg,
          this.meta,
          itemId,
          FIELD.claimedBy,
          '',
        );
      },
      warn: logErr,
    });
    for (const item of cleaned) {
      log(
        `${item.issue?.number ? `#${item.issue.number}` : item.itemId} ` +
          'cleared stale terminal lease fields',
      );
    }
    const { candidates, swept } = await preparePoll(items, {
      cfg: this.cfg,
      playbooks: this.playbooks,
      active: this.active,
      readItem: readItemById,
      setPaused: (itemId) =>
        setSelectField(this.cfg, this.meta, itemId, FIELD.status, 'paused'),
      warn: logErr,
    });
    for (const item of swept) {
      const label = item.issue?.number ? `#${item.issue.number}` : `Project item ${item.itemId}`;
      log(`${label} paused: lease expired (passive sweep)`);
    }

    let claimed = 0;
    for (const it of candidates) {
      if (this.draining) break;
      if (this.capacityCount() >= this.cfg.maxConcurrent) break;
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
    const previousStatus = statusOf(fresh);
    const resuming = previousStatus === 'paused';
    if (ownerOf(fresh) !== 'agent' || (previousStatus !== 'ready' && !resuming)) return false;
    if (resuming && val(fresh, FIELD.machine, '') !== this.cfg.machine) return false;
    if (!leaseIsFree(fresh, this.cfg.identity, { warn: logErr })) return false; // claim race — skip
    const pb = val(fresh, FIELD.playbook, '');
    if (!this.playbooks.has(pb)) return false;

    // The playbook may have changed between poll and this re-read; revalidate
    // capacity against the freshly-read playbook before claiming.
    const cap = this.playbooks.get(pb).capacity;
    if (cap <= 0) {
      log(`#${number} playbook changed to "${pb}" which is disabled on re-read; skipping`);
      return false;
    }
    if (this.capacityCount() >= this.cfg.maxConcurrent) {
      log(`#${number} at global capacity on re-read (playbook "${pb}"); skipping`);
      return false;
    }
    if (this.activeForPlaybook(pb) >= cap) {
      log(`#${number} playbook "${pb}" at capacity on re-read; skipping`);
      return false;
    }

    // Record the claim: claimed-by, machine, lease-until, Status=in-progress.
    // `machine` is durable provenance (which machine ran the work); unlike the
    // lease it is not cleared on pause, so a stopped task can be resumed on
    // the same machine (see session-id, written at launch).
    const leaseWritten = this.leaseTimestamp();
    try {
      await setTextField(this.cfg, this.meta, item.itemId, FIELD.claimedBy, this.cfg.identity);
      await setTextField(this.cfg, this.meta, item.itemId, FIELD.machine, this.cfg.machine);
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
      // supervision, or local state. Restore its pre-launch ready/paused state
      // (best-effort writes) and count this toward the consecutive-failure
      // tally for 3-strikes escalation. The item was never
      // added to this.active, so handleOperationalFailure's active.delete is a
      // harmless no-op. Do NOT launch a worker.
      await this.handleOperationalFailure(
        { itemId: item.itemId, issueNumber: number, url: item.issue?.url, repo: item.issue?.repo },
        `claim confirm re-read failed: ${e.message}`,
        { returnStatus: previousStatus },
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
    // not an operational failure: restore the just-written claim to its prior
    // state and do NOT count a strike. We only reach here still owning the
    // claim, so the restore cannot stomp another runner's winning claim.
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
          // Restore `machine` to its pre-claim value: no worker ran here, so the
          // just-written claim must not leave stale provenance that would later
          // pair this machine with another machine's `session-id` and trigger a
          // bogus "resume".
          await setTextField(this.cfg, this.meta, item.itemId, FIELD.machine, val(fresh, FIELD.machine, ''));
          await setTextField(this.cfg, this.meta, item.itemId, FIELD.leaseUntil, '');
          await setSelectField(this.cfg, this.meta, item.itemId, FIELD.status, previousStatus);
        } catch (e) {
          logErr(`revert-to-${previousStatus} writes failed for #${number}: ${e.message}`);
        }
        log(
          `#${number} skipped: fixed workingDirectory ${resolvedDir} already in use by an active worker; returned to ${previousStatus}`,
        );
        return false;
      }
    }

    try {
      await this.launchWorker(fresh, pb);
    } catch (e) {
      logErr(`launch failed for #${number}: ${e.message}`);
      await this.handleOperationalFailure(
        { itemId: item.itemId, issueNumber: number, url: item.issue?.url, repo: item.issue?.repo },
        `launch failed: ${e.message}`,
        { returnStatus: previousStatus },
      );
      return false;
    }
    this.failCounts.delete(item.itemId);
    if (resuming) {
      try {
        await setTextField(this.cfg, this.meta, item.itemId, FIELD.needsHumanSince, '');
        const worker = this.active.get(item.itemId);
        if (worker) worker.hadNeedsHuman = false;
      } catch (e) {
        // Keep hadNeedsHuman set so normal supervision retries the clear.
        logErr(`could not clear needs-human-since while resuming #${number}: ${e.message}`);
      }
    }
    return true;
  }

  // ---- Launch -------------------------------------------------------------

  async launchWorker(item, playbookName) {
    const pb = this.playbooks.get(playbookName);
    const number = item.issue.number;

    // Copilot session id for resumability. Copilot sessions live on the local
    // machine, so only reuse a previously recorded session id when it was
    // created on THIS machine — then a task whose worker died can be resumed
    // (its transcript and state re-adopted) instead of started from scratch.
    // Otherwise mint a fresh UUID. Passing the id via `copilot --session-id`
    // both creates the session on first launch and resumes it on a later one.
    const previousStatus = statusOf(item);
    const recordedSessionId = val(item, FIELD.sessionId, '');
    const recordedMachine = val(item, FIELD.machine, '');
    const resuming = previousStatus === 'paused';
    if (resuming && (!recordedSessionId || recordedMachine !== this.cfg.machine)) {
      throw new Error(`cannot resume #${number}: recorded session or machine is missing/mismatched`);
    }
    const sessionId = resuming ? recordedSessionId : randomUUID();

    // 1. Working directory: fixed workingDirectory, else isolated workspace.
    let workingDir;
    let isolated = false;
    if (pb.workingDirectory) {
      workingDir = pb.workingDirectory;
      await mkdir(workingDir, { recursive: true });
    } else {
      isolated = true;
      const stablePath = path.join(this.cfg.workspaceRoot, `pan-${number}-${sessionId}`);
      workingDir = resuming
        ? (this.resumeWorkspaces.get(item.itemId) || stablePath)
        : stablePath;
      if (resuming) {
        if (!existsSync(workingDir)) {
          throw new Error(`cannot resume #${number}: isolated workspace is missing (${workingDir})`);
        }
      } else {
        await mkdir(this.cfg.workspaceRoot, { recursive: true });
        if (existsSync(workingDir)) {
          throw new Error(`new isolated workspace already exists (${workingDir})`);
        }
        await mkdir(workingDir);
      }
    }

    const panDir = path.join(workingDir, '.pan');
    await mkdir(panDir, { recursive: true });

    // Clear any stale signal files from a previous task. This matters for a
    // fixed workingDirectory whose `.pan/` is reused; an isolated workspace is
    // already fresh, but clearing unconditionally is simplest and harmless.
    await Promise.all(
      ['result.json', 'needs-human.json', 'worker.running', 'worker.pid', 'worker.stop', 'pan.md'].map((f) =>
        rm(path.join(panDir, f), { force: true }),
      ),
    );

    // 2. Task context files.
    const task = {
      itemId: item.itemId,
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

    // Stable, human-readable window title so the user can tell at a glance
    // which task each spawned window is working on. Computed here because the
    // launcher bakes it in to keep re-asserting it against copilot (see below).
    const windowTitle = workerWindowTitle(number, item.issue.title);

    // Generate the Node launcher. It runs with its CWD set to workingDir and
    // passes the prompt to copilot as a single argv element, so no shell ever
    // re-parses the (domain-controlled) prompt text on any platform. The
    // session id is baked in as `--session-id` so the worker's copilot session
    // is the one recorded on the Issue, making the task resumable.
    await writeFile(path.join(panDir, 'launch.mjs'), this.buildLauncherSource(windowTitle, sessionId));

    // Record a new Copilot session before launch. Without this durable link a
    // stopped task could not be resumed, so a write failure must abort launch.
    // A resume already has the required recorded value.
    if (!resuming) {
      await setTextField(this.cfg, this.meta, item.itemId, FIELD.sessionId, sessionId);
    }

    // 3. Pre-trust the workspace folder so the headed worker starts without an
    // interactive "trust this folder?" prompt. copilot's --allow-all covers
    // tools/paths/URLs but NOT the per-folder trust gate, which is governed
    // only by trustedFolders in ~/.copilot/config.json. Best-effort: on any
    // failure the worker at worst shows the prompt as before.
    await this.trustWorkspace(workingDir);

    // 4. Launch a headed copilot session in a visible terminal window. The
    // window title is set by the launcher's watchdog (baked in above); the
    // terminal-side title below is just the initial value shown before copilot
    // loads.
    await this.spawnTerminal(workingDir, panDir, windowTitle);

    // 5. Register supervision state.
    this.active.set(item.itemId, {
      itemId: item.itemId,
      issueNumber: number,
      title: item.issue.title,
      url: item.issue.url,
      repo: item.issue.repo || repoFromUrl(item.issue.url),
      playbook: playbookName,
      workingDir,
      panDir,
      isolated,
      sessionId,
      startedAt: Date.now(),
      lastRenew: Date.now(),
      hadNeedsHuman: !!val(item, FIELD.needsHumanSince, ''),
      needsHumanRelayed: false,
      warnedPartialNeedsHuman: false,
      lastBadOutcome: null,
      finished: false,
    });
    this.resumeWorkspaces.delete(item.itemId);
    log(`launched worker for #${number} in ${workingDir}${resuming ? ` (resuming session ${sessionId})` : ` (session ${sessionId})`}`);
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

  /**
   * Best-effort: add a worker's workspace folder to copilot's trustedFolders so
   * the headed session starts without the interactive folder-trust modal. The
   * config file (~/.copilot/config.json) is "managed automatically" and may
   * begin with `//` comment lines before the JSON body; we strip those to parse,
   * then rewrite preserving the original header. Idempotent (skips folders that
   * are already trusted) and non-fatal: any error is logged and the launch
   * continues, so a worker at worst prompts as it did before.
   */
  async trustWorkspace(folderPath) {
    const configPath = this.cfg.copilotConfigPath;
    try {
      let raw;
      try {
        raw = await readFile(configPath, 'utf8');
      } catch {
        raw = '';
      }
      const lines = raw.split('\n');
      let i = 0;
      while (i < lines.length && (lines[i].trimStart().startsWith('//') || lines[i].trim() === '')) {
        i++;
      }
      const header = lines.slice(0, i).join('\n');
      const body = lines.slice(i).join('\n').trim();
      const config = body ? JSON.parse(body) : {};
      const trusted = Array.isArray(config.trustedFolders) ? config.trustedFolders : [];
      if (trusted.includes(folderPath)) return;
      trusted.push(folderPath);
      config.trustedFolders = trusted;
      const out = (header ? header + '\n' : '') + JSON.stringify(config, null, 2) + '\n';
      await mkdir(path.dirname(configPath), { recursive: true });
      await writeFile(configPath, out);
    } catch (e) {
      logErr(`could not pre-trust workspace ${folderPath} (worker may prompt): ${e.message}`);
    }
  }

  async spawnTerminal(workingDir, panDir, title) {
    if (this.cfg.terminalKind === 'macos-terminal') {
      return this.spawnMacTerminal(workingDir, panDir, title);
    }
    if (this.cfg.terminalKind === 'windows-terminal') {
      return this.spawnWindowsTerminal(workingDir, panDir, title);
    }
    throw new Error(`Unsupported terminalKind: ${this.cfg.terminalKind}`);
  }

  /**
   * Source for the generated `.pan/launch.mjs`. Run with CWD = the worker
   * working directory, it maintains the liveness marker and pid, then spawns
   * copilot with the prompt as a single argv element (never re-parsed by any
   * shell). copilotBin/copilotArgs are baked in as JSON literals so the
   * launcher reads no config at runtime. Permission flags derived from
   * workerPermissions are prepended to copilotArgs, and `--session-id <id>` is
   * appended so the worker runs under the exact session id recorded on the
   * Issue — creating that session on first launch and resuming it on a later
   * one (see system/runner.md, "Restart and rehydration").
   *
   * The launcher also runs a title watchdog: copilot rewrites the terminal
   * title (`OSC 0`) repeatedly during a session with its own AI-generated
   * summary, and that always wins over a terminal-side "custom title". So the
   * launcher periodically re-emits our stable task title to the tty, keeping
   * each worker window identifiable. This is a benign competition — an `OSC 0`
   * title escape never touches copilot's alt-screen content — with at most a
   * brief flicker to copilot's title after each of its (infrequent) updates.
   *
   * Finally, the launcher watches for `.pan/worker.stop`, which the runner
   * writes once it has finalized the task. On that signal the launcher stops
   * copilot and closes its own terminal window so finished worker windows do
   * not accumulate: on macOS it asks Terminal.app to close the window matching
   * its tty; on Windows it simply exits 0 and Windows Terminal auto-closes the
   * tab. On macOS the launcher runs via `exec node` (it replaced the login
   * shell), so when it exits the tab has no running process and Terminal closes
   * it without its "terminate running processes in this window?" prompt.
   */
  buildLauncherSource(windowTitle = '', sessionId = '') {
    const copilotBin = JSON.stringify(this.cfg.copilotBin);
    const sessionArgs = sessionId ? ['--session-id', sessionId] : [];
    // copilot has no positional prompt argument: the initial prompt must be the
    // VALUE of -i/--interactive (see `copilot --help`). The launcher appends
    // `--interactive <promptText>` at spawn time, so strip any bare interactive
    // flag a config may still carry, otherwise it would consume the prompt as
    // its value and leave the real prompt as a rejected positional argument.
    const baseArgs = [...this.cfg.permissionArgs, ...this.cfg.copilotArgs, ...sessionArgs]
      .filter((a) => a !== '--interactive' && a !== '-i');
    const copilotArgs = JSON.stringify(baseArgs);
    const title = JSON.stringify(windowTitle || '');
    return `import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';

// Baked in by the runner; the launcher reads no config at runtime.
const copilotBin = ${copilotBin};
const copilotArgs = ${copilotArgs};
const windowTitle = ${title};

const marker = '.pan/worker.running';
const stopSignal = '.pan/worker.stop';
let cleaned = false;
let titleTimer = null;
let stopTimer = null;
let stopping = false;
function cleanup() {
  if (cleaned) return;
  cleaned = true;
  if (titleTimer) { try { clearInterval(titleTimer); } catch {} titleTimer = null; }
  if (stopTimer) { try { clearInterval(stopTimer); } catch {} stopTimer = null; }
  try { rmSync(marker, { force: true }); } catch {}
}

// Capture our controlling terminal up front (before copilot inherits stdio) so
// that, when the runner signals the task is finished, we can close exactly our
// own window on macOS. Terminal.app does not auto-close a tab when its command
// exits, unlike Windows Terminal.
let myTty = '';
if (process.platform === 'darwin') {
  try { myTty = execFileSync('tty', { stdio: ['inherit', 'pipe', 'ignore'] }).toString().trim(); } catch {}
}

// Keep our task title on the window. copilot re-emits its own \`OSC 0\` title
// throughout the session, overriding any terminal-side custom title, so we
// periodically re-assert ours to the tty. An \`OSC 0\` escape only sets the
// title (icon + window); it never disturbs copilot's alt-screen content.
function setWindowTitle() {
  if (!windowTitle) return;
  try {
    if (process.stdout.isTTY) process.stdout.write('\\u001b]0;' + windowTitle + '\\u0007');
  } catch {}
}

// Close our own terminal window once the task is done. On macOS we ask
// Terminal.app to close the window whose selected tab matches our tty. Because
// the launcher runs via \`exec node\` (it replaced the login shell), once this
// launcher exits the tab has no running process at all, so \`close\` never
// triggers Terminal's "terminate running processes" prompt. The osascript is
// detached and briefly delayed so it runs AFTER this launcher has exited, and
// it additionally waits for the tab to report \`not busy\` before closing, so a
// slow exit can never race the close into that prompt. On Windows the tab
// auto-closes when this launcher exits 0, so no explicit close is needed.
function closeWindow() {
  if (process.platform !== 'darwin' || !myTty) return;
  const osa = [
    'tell application "Terminal"',
    '  repeat with w in windows',
    '    if tty of selected tab of w is "' + myTty + '" then',
    '      repeat 40 times',
    '        if not busy of selected tab of w then exit repeat',
    '        delay 0.25',
    '      end repeat',
    '      close w saving no',
    '    end if',
    '  end repeat',
    'end tell',
  ].join('\\n');
  try {
    const closer = spawn(process.execPath, ['-e',
      'setTimeout(() => { try { require("child_process").execFileSync("osascript", ["-e", process.argv[1]]); } catch {} }, 500)',
      osa,
    ], { detached: true, stdio: 'ignore' });
    closer.unref();
  } catch {}
}

// The runner writes .pan/worker.stop after it finalizes the task (records the
// result and updates the Project). That is our cue to shut copilot down and
// close this window so finished worker windows don't pile up. We exit 0 so
// Windows Terminal auto-closes the tab; the detached closer handles macOS.
function shutdownForStop() {
  if (stopping) return;
  stopping = true;
  if (stopTimer) { try { clearInterval(stopTimer); } catch {} stopTimer = null; }
  closeWindow();
  try { child.kill('SIGTERM'); } catch {}
  cleanup();
  setTimeout(() => process.exit(0), 400);
}

try { writeFileSync('.pan/worker.pid', String(process.pid)); } catch {}
try { writeFileSync(marker, ''); } catch {}

// Remove the marker on normal exit and on window-close signals, mirroring the
// old bash \`trap\`. A hard kill (SIGKILL) cannot run handlers; the runner's
// rehydration pause and liveness grace still recover a truly-gone worker.
process.on('exit', cleanup);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => { cleanup(); process.exit(130); });
}

const promptText = readFileSync('.pan/launch-prompt.txt', 'utf8');
// The prompt is the value of copilot's -i/--interactive flag, never a bare
// positional argument (copilot has no positional prompt and would reject it).
const child = spawn(copilotBin, [...copilotArgs, '--interactive', promptText], { stdio: 'inherit' });
setWindowTitle();
titleTimer = setInterval(setWindowTitle, 2000);
if (typeof titleTimer.unref === 'function') titleTimer.unref();
stopTimer = setInterval(() => { if (existsSync(stopSignal)) shutdownForStop(); }, 1000);
if (typeof stopTimer.unref === 'function') stopTimer.unref();
child.on('error', (e) => { cleanup(); console.error(e.message); process.exit(1); });
child.on('exit', (code, signal) => {
  cleanup();
  if (stopping) { process.exit(0); return; }
  process.exit(code == null ? (signal ? 1 : 0) : code);
});
`;
  }

  async spawnMacTerminal(workingDir, panDir, title) {
    // The Node launcher (.pan/launch.mjs) owns the liveness marker and pid; we
    // only cd into the working dir and run it. No prompt text flows through the
    // shell — the sole shell-quoted values are the controlled working-dir path
    // and nodeBin.
    void panDir;
    const nodeBin = this.cfg.nodeBin;
    // `exec` replaces the login shell (`-zsh`) with the Node launcher so the
    // tab has exactly one process — node — and no leftover interactive shell.
    // That matters when the launcher closes its own window on completion: once
    // node exits the tab has NO running process at all ("[Process completed]"),
    // so Terminal.app closes it silently instead of showing its "Do you want to
    // terminate running processes in this window?" prompt for the idle shell
    // (see buildLauncherSource / closeWindow).
    const doScript = `cd ${shQuote(workingDir)} && exec ${shQuote(nodeBin)} .pan/launch.mjs`;
    // Capture the tab returned by `do script` and set an initial title on it.
    // This is only the title shown before copilot loads: copilot rewrites the
    // window title (OSC 0) during the session and that overrides Terminal.app's
    // custom title, so the launcher's watchdog re-asserts our task title while
    // the worker runs (see buildLauncherSource).
    const args = [
      '-e', 'tell application "Terminal" to activate',
    ];
    if (title) {
      args.push(
        '-e',
        `tell application "Terminal" to set custom title of (do script "${appleScriptEscape(doScript)}") to "${appleScriptEscape(title)}"`,
      );
    } else {
      args.push(
        '-e',
        `tell application "Terminal" to do script "${appleScriptEscape(doScript)}"`,
      );
    }
    await spawnOk('osascript', args);
  }

  async spawnWindowsTerminal(workingDir, panDir, title) {
    // Launch the Node launcher (.pan/launch.mjs) via an argv array with no cmd
    // prompt expansion. `-d workingDir` sets the CWD so the launcher's relative
    // `.pan/...` paths resolve. The launcher maintains the liveness marker
    // (including on window-close signals), so no batch file is needed.
    // `--title` plus `--suppressApplicationTitle` pin a stable task name that
    // Windows Terminal will not let the running program overwrite. (The
    // launcher's title watchdog also runs, but its OSC titles are ignored here
    // for the same reason — belt-and-suspenders with the macOS path.)
    void panDir;
    const ntArgs = ['-w', '0', 'nt'];
    if (title) {
      ntArgs.push('--title', title, '--suppressApplicationTitle');
    }
    ntArgs.push('-d', workingDir, this.cfg.nodeBin, path.join('.pan', 'launch.mjs'));
    await spawnOk('wt.exe', ntArgs, { detached: true });
  }

  // ---- Supervision --------------------------------------------------------

  async superviseTick() {
    for (const [itemId, w] of [...this.active.entries()]) {
      if (w.finished) {
        this.active.delete(itemId);
        continue;
      }
      try {
        await this.superviseWorker(w);
      } catch (e) {
        logErr(`supervise error for #${w.issueNumber}: ${e.message}`);
      }
    }
  }

  async superviseWorker(w) {
    const resultPath = path.join(w.panDir, 'result.json');
    const needsHumanPath = path.join(w.panDir, 'needs-human.json');
    const markerPath = path.join(w.panDir, 'worker.running');

    // A valid result enters finalization, which performs its own ownership
    // re-read before writing. Pending finalization does not renew the worker's
    // lease or consume capacity; it only retries its idempotent terminal writes.
    if (
      existsSync(resultPath) &&
      Date.now() >= (w.nextFinalizeAttemptAt || 0)
    ) {
      const finalized = await this.finalize(w, resultPath);
      if (finalized) return;
    }
    if (w.finalizationPending) return;

    // At the renewal cadence re-read the item before Project-mutating
    // supervision. If another runner took the claim while we weren't looking,
    // stop without writing its fields.
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
    // paused).
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
      await this.pauseWorker(w, 'worker exited (marker gone or PID dead)');
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
    const status = terminalStatusForResult(result);
    if (!status) {
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

    w.finalizationPending = true;
    // TODO (best-effort v1): for pull-request work, confirm the PR merged on
    // GitHub before setting `done`. Not yet implemented; see bin/README.md.
    let comment = `✅ Worker finished (${outcome}): ${summary}`;
    if (details) comment += `\n\n${details}`;
    if (outcome === 'done') {
      comment += `\n\n_Note: runner did not independently confirm any pull-request merge (v1 limitation)._`;
    }

    let fresh;
    try {
      fresh = await readItemById(w.itemId);
    } catch (e) {
      return this.handleFinalizationFailure(w, e, status);
    }
    if (!fresh) {
      logErr(
        `finalization for #${w.issueNumber} stopped because its Project item disappeared`,
      );
      await this.stopFinalizedWorker(w);
      return true;
    }

    const currentStatus = statusOf(fresh);
    const claimedBy = val(fresh, FIELD.claimedBy, '');
    if (w.finalizationEscalated && currentStatus === 'blocked') {
      try {
        await this.clearAndConfirmTerminalFields(w, 'blocked');
      } catch (e) {
        return this.handleFinalizationFailure(w, e, status);
      }
      try {
        await this.recordFinalizationEscalation(
          w,
          w.lastFinalizationError || 'terminal lease cleanup failed',
          'The task remains blocked until its completion state is repaired.',
        );
      } catch (e) {
        return this.handleFinalizationFailure(w, e, status);
      }
      await this.stopFinalizedWorker(w);
      return true;
    }
    if (
      (claimedBy && claimedBy !== this.cfg.identity) ||
      (currentStatus === 'in-progress' &&
        claimedBy !== this.cfg.identity) ||
      (currentStatus !== 'in-progress' && currentStatus !== status)
    ) {
      logErr(
        `finalization for #${w.issueNumber} lost ownership ` +
          `(status=${currentStatus}, claimed-by=${JSON.stringify(claimedBy)}); ` +
          'stopping without writes',
      );
      await this.stopFinalizedWorker(w);
      return true;
    }

    try {
      await ensureIssueComment(
        gh,
        this.issueRepoOf(w),
        w.issueNumber,
        `<!-- pan-result:${w.sessionId} -->`,
        comment,
      );
      // Clear any lingering human-attention signal on completion (idempotent).
      await setTextField(this.cfg, this.meta, w.itemId, FIELD.needsHumanSince, '');
      if (outcome === 'done') {
        await ensureIssueClosed(gh, this.issueRepoOf(w), w.issueNumber);
      }
      await setSelectField(this.cfg, this.meta, w.itemId, FIELD.status, status);
      await this.clearAndConfirmTerminalFields(w, status);
    } catch (e) {
      return this.handleFinalizationFailure(w, e, status);
    }

    if (w.finalizationFailures >= FINALIZATION_FAILURE_LIMIT) {
      try {
        await this.recordFinalizationEscalation(
          w,
          w.lastFinalizationError || 'terminal finalization failed',
          `Pan recovered the task in ${status} and confirmed its lease cleanup.`,
        );
      } catch (e) {
        return this.handleFinalizationFailure(w, e, status);
      }
    }
    await this.finishFinalization(w, status);
    return true;
  }

  async finishFinalization(w, status) {
    w.finalizationFailures = 0;
    w.nextFinalizeAttemptAt = 0;
    this.failCounts.delete(w.itemId);
    await this.stopFinalizedWorker(w);
    log(`#${w.issueNumber} → ${status}`);
  }

  async clearAndConfirmTerminalFields(w, expectedStatus) {
    await setTextField(this.cfg, this.meta, w.itemId, FIELD.leaseUntil, '');
    await setTextField(this.cfg, this.meta, w.itemId, FIELD.claimedBy, '');
    const confirmed = await readItemById(w.itemId);
    if (
      !confirmed ||
      statusOf(confirmed) !== expectedStatus ||
      val(confirmed, FIELD.claimedBy, '') ||
      val(confirmed, FIELD.leaseUntil, '')
    ) {
      throw new Error(
        `GitHub did not confirm ${expectedStatus} with cleared lease fields.`,
      );
    }
  }

  async handleFinalizationFailure(w, error, targetStatus) {
    const reason = error instanceof Error ? error.message : String(error);
    const count = (w.finalizationFailures || 0) + 1;
    w.finalizationFailures = count;
    w.lastFinalizationError = reason;

    if (count < FINALIZATION_FAILURE_LIMIT) {
      const delay = FINALIZATION_RETRY_BASE_MS * 2 ** (count - 1);
      w.nextFinalizeAttemptAt = Date.now() + delay;
      logErr(
        `finalize failed for #${w.issueNumber} ` +
          `(${count}/${FINALIZATION_FAILURE_LIMIT}); retrying in ${delay / 1000}s: ${reason}`,
      );
      return false;
    }

    let fresh;
    try {
      fresh = await readItemById(w.itemId);
    } catch (e) {
      w.nextFinalizeAttemptAt = Date.now() + 60000;
      logErr(
        `finalization escalation re-read failed for #${w.issueNumber}; ` +
          `retrying in 60s: ${e.message}`,
      );
      return false;
    }

    const currentStatus = fresh ? statusOf(fresh) : '';
    const claimedBy = fresh ? val(fresh, FIELD.claimedBy, '') : '';
    if (
      !fresh ||
      (claimedBy && claimedBy !== this.cfg.identity) ||
      (currentStatus === 'in-progress' &&
        claimedBy !== this.cfg.identity) ||
      (currentStatus !== 'in-progress' &&
        currentStatus !== targetStatus &&
        !(w.finalizationEscalated && currentStatus === 'blocked'))
    ) {
      logErr(
        `finalization escalation for #${w.issueNumber} lost ownership ` +
          `(status=${currentStatus || 'missing'}, ` +
          `claimed-by=${JSON.stringify(claimedBy)}); stopping without writes`,
      );
      await this.stopFinalizedWorker(w);
      return true;
    }

    if (currentStatus === targetStatus || currentStatus === 'blocked') {
      w.nextFinalizeAttemptAt = Date.now() + 60000;
      try {
        await this.recordFinalizationEscalation(
          w,
          reason,
          `The task reached ${currentStatus}, but Pan is still retrying cleanup ` +
            'of its terminal lease fields.',
        );
      } catch (e) {
        logErr(
          `finalization escalation comment failed for #${w.issueNumber}; ` +
            `retrying in 60s: ${e.message}`,
        );
      }
      return false;
    }

    w.finalizationEscalated = true;
    try {
      await setSelectField(
        this.cfg,
        this.meta,
        w.itemId,
        FIELD.status,
        'blocked',
      );
      await this.clearAndConfirmTerminalFields(w, 'blocked');
    } catch (e) {
      w.nextFinalizeAttemptAt = Date.now() + 60000;
      try {
        await this.recordFinalizationEscalation(
          w,
          reason,
          'The task was moved toward blocked, and Pan is still retrying cleanup.',
        );
      } catch (commentError) {
        logErr(
          `finalization escalation comment failed for #${w.issueNumber}; ` +
            `retrying in 60s: ${commentError.message}`,
        );
      }
      logErr(
        `finalization escalation cleanup failed for #${w.issueNumber}; ` +
          `retrying in 60s: ${e.message}`,
      );
      return false;
    }

    try {
      await this.recordFinalizationEscalation(
        w,
        reason,
        'The task was moved to blocked for manual repair.',
      );
    } catch (e) {
      w.nextFinalizeAttemptAt = Date.now() + 60000;
      logErr(
        `finalization escalation comment failed for #${w.issueNumber}; ` +
          `retrying in 60s: ${e.message}`,
      );
      return false;
    }
    await this.stopFinalizedWorker(w);
    log(`#${w.issueNumber} blocked after repeated finalization failures`);
    return true;
  }

  async recordFinalizationEscalation(w, reason, resolution) {
    await ensureIssueComment(
      gh,
      this.issueRepoOf(w),
      w.issueNumber,
      `<!-- pan-finalization-failed:${w.sessionId} -->`,
      `⚠️ Pan could not finalize this completed worker after ` +
        `${FINALIZATION_FAILURE_LIMIT} attempts.\n\n` +
        `Last error: ${reason}\n\n${resolution}`,
    );
  }

  async stopFinalizedWorker(w) {
    w.finalizationPending = false;
    w.finished = true;
    this.active.delete(w.itemId);
    try {
      await writeFile(path.join(w.panDir, 'worker.stop'), '');
    } catch (e) {
      logErr(`could not signal worker.stop for #${w.issueNumber}: ${e.message}`);
    }
  }

  /** Release a started task whose worker stopped so its session and workspace
   *  can be resumed on this machine. Unlike an operational launch failure,
   *  worker exit is a lifecycle transition, not a retry strike. */
  async pauseWorker(w, reason) {
    const number = w.issueNumber;
    let fresh;
    try {
      fresh = await readItemById(w.itemId);
    } catch (e) {
      logErr(`pause re-read failed for #${number}: ${e.message}`);
      return false;
    }

    if (!fresh) {
      this.active.delete(w.itemId);
      return false;
    }

    const claimedBy = val(fresh, FIELD.claimedBy, '');
    const status = statusOf(fresh);
    if (claimedBy && claimedBy !== this.cfg.identity) {
      this.active.delete(w.itemId);
      logErr(`#${number} now claimed by "${claimedBy}"; not pausing a foreign worker`);
      return false;
    }
    if (status !== 'in-progress') {
      this.active.delete(w.itemId);
      if (status === 'paused' && val(fresh, FIELD.machine, '') === this.cfg.machine && w.isolated && existsSync(w.workingDir)) {
        this.resumeWorkspaces.set(w.itemId, w.workingDir);
      }
      return status === 'paused';
    }

    try {
      await setTextField(this.cfg, this.meta, w.itemId, FIELD.leaseUntil, '');
      await setTextField(this.cfg, this.meta, w.itemId, FIELD.claimedBy, '');
      await setSelectField(this.cfg, this.meta, w.itemId, FIELD.status, 'paused');
    } catch (e) {
      logErr(`pause writes failed for #${number}: ${e.message}`);
      return false;
    }

    this.active.delete(w.itemId);
    if (w.isolated && existsSync(w.workingDir)) {
      this.resumeWorkspaces.set(w.itemId, w.workingDir);
    }
    log(`#${number} paused: ${reason}`);
    return true;
  }

  /** Operational failure: return the task to its pre-launch state; escalate
   *  after 3 in a row.
   *  When `releaseFields` is false (e.g. a lost lease we no longer own), still
   *  count the failure and stop supervising, but never write the item's fields —
   *  another runner may now hold a valid claim we must not overwrite.
   *  When `releaseFields` is true, the item's ownership is re-read best-effort
   *  before any field writes: if the re-read positively shows a foreign runner
   *  now holds the claim, all field writes are skipped to avoid stomping that
   *  owner (the strike is still counted). Absent positive evidence of a foreign
   *  owner (re-read shows our identity, an empty claim, or fails/returns null),
   *  the writes proceed as before. */
  async handleOperationalFailure(w, reason, { releaseFields = true, returnStatus = 'ready' } = {}) {
    const number = w.issueNumber;
    const count = (this.failCounts.get(w.itemId) || 0) + 1;
    this.failCounts.set(w.itemId, count);
    this.active.delete(w.itemId);
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
        // Restore the state from which this launch was attempted. A new task
        // returns to ready; a failed resume remains paused so its established
        // session/workspace are not discarded.
        await setTextField(this.cfg, this.meta, w.itemId, FIELD.claimedBy, '');
        await setTextField(this.cfg, this.meta, w.itemId, FIELD.leaseUntil, '');
        await setSelectField(this.cfg, this.meta, w.itemId, FIELD.status, returnStatus);
        log(`#${number} returned to ${returnStatus}`);
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
   *   recorded PID is dead/missing — with the item still ours and
   *   `in-progress`, is retained and its item is transitioned to `paused`.
   * - A retained workspace for a task already `paused` on this machine is
   *   indexed for the next resume launch.
   * - An isolated workspace that is inert — no live worker AND no longer
   *   owned/adoptable by this runner (finalized, released, missing
   *   from the Project, or externally transitioned) — is pruned (its directory
   *   removed). Otherwise finished workspaces accumulate under workspaceRoot and
   *   are re-scanned and re-logged on every restart. Only workspaces confirmed
   *   inert are removed; a live or still-owned-and-adoptable workspace is never
   *   touched.
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
    // Resolve liveness before processing so, if an older runner left duplicate
    // workspaces for one Project item, a live worker wins over a dead leftover.
    const workspaces = [];
    for (const entry of entries) {
      const workingDir = path.join(this.cfg.workspaceRoot, entry);
      const panDir = path.join(workingDir, '.pan');
      const taskPath = path.join(panDir, 'task.json');
      const markerPath = path.join(panDir, 'worker.running');
      const resultPath = path.join(panDir, 'result.json');
      let st;
      try {
        st = await stat(workingDir);
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
      if (!number) continue;

      // Liveness of this workspace's worker: the marker must be present AND its
      // recorded PID must be a live process. Computed up front so the ownership
      // and finalization branches below can prune an inert leftover rather than
      // re-logging it on every restart.
      const alive = existsSync(markerPath) && (await workerPidAlive(panDir));
      workspaces.push({
        workingDir,
        panDir,
        resultPath,
        task,
        number,
        alive,
        hasResult: existsSync(resultPath),
        mtimeMs: st.mtimeMs,
      });
    }

    workspaces.sort((a, b) =>
      Number(b.alive) - Number(a.alive)
      || Number(b.hasResult) - Number(a.hasResult)
      || b.mtimeMs - a.mtimeMs,
    );

    for (const workspace of workspaces) {
      const {
        workingDir,
        panDir,
        resultPath,
        task,
        number,
        alive,
      } = workspace;

      const match = findProjectItemForTask(items, task);
      if (!match) {
        // The task is no longer on the Project. If no worker is alive here, the
        // isolated workspace is an inert leftover — prune it.
        if (!alive) await pruneWorkspace(workingDir, number, 'task not found on Project');
        continue;
      }

      if (this.active.has(match.itemId)) {
        if (!alive) {
          log(`#${number} has an older inactive duplicate workspace at ${workingDir}; leaving it untouched`);
        }
        continue;
      }

      // Confirm the Project still shows this task claimed by us.
      const projectStatus = statusOf(match);
      const projectMachine = val(match, FIELD.machine, '');
      const projectSessionId = val(match, FIELD.sessionId, '');
      const claimedBy = val(match, FIELD.claimedBy, '');

      // Paused work is intentionally unclaimed. Preserve its isolated
      // workspace and make it available to launchWorker() instead of treating
      // the empty claimed-by field as evidence that the directory is inert.
      if (!alive && projectStatus === 'paused' && projectMachine === this.cfg.machine) {
        const canonical = projectSessionId
          ? path.resolve(path.join(this.cfg.workspaceRoot, `pan-${number}-${projectSessionId}`))
          : null;
        const remembered = this.resumeWorkspaces.get(match.itemId);
        if (!remembered || (canonical && path.resolve(workingDir) === canonical)) {
          this.resumeWorkspaces.set(match.itemId, workingDir);
        }
        log(`found paused workspace for #${number} at ${workingDir}`);
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
        sessionId: projectSessionId,
        startedAt: Date.now(),
        lastRenew: 0, // force an immediate lease renewal
        hadNeedsHuman: !!val(match, FIELD.needsHumanSince, ''),
        needsHumanRelayed: false,
        warnedPartialNeedsHuman: false,
        lastBadOutcome: null,
        finished: false,
      };

      // Pending results may have committed their terminal Status before a
      // runner crash. Adopt normal in-progress finalization, a matching
      // done/in-review partial commit, or this runner's blocked escalation so
      // lease cleanup and worker.stop are completed after restart.
      if (existsSync(resultPath)) {
        let pendingStatus = null;
        try {
          pendingStatus = terminalStatusForResult(
            JSON.parse(await readFile(resultPath, 'utf8')),
          );
        } catch {
          pendingStatus = null;
        }
        const finalizationKind = pendingFinalizationKind({
          projectStatus,
          pendingStatus,
          claimedBy,
          identity: this.cfg.identity,
        });

        if (!finalizationKind) {
          log(
            `#${number} has a pending result but was externally transitioned ` +
              `(status=${projectStatus}); skipping finalization (rehydrate)`,
          );
          // The worker already finished (it wrote result.json). If it is no
          // longer alive, the workspace is inert — prune it.
          if (!alive) await pruneWorkspace(workingDir, number, 'pending result, externally transitioned');
          continue;
        }
        w.finalizationEscalated = finalizationKind === 'escalated';
        const finalized = await this.finalize(w, resultPath);
        if (finalized) continue;
        if (w.finalizationPending) {
          this.active.set(match.itemId, w);
          log(`rehydrated pending finalization for #${number} from ${workingDir}`);
          continue;
        }
      }

      if (claimedBy !== this.cfg.identity) {
        // No longer ours: finalized (finalize clears claimed-by) or released to
        // another runner. With no live worker here, the workspace is an inert
        // leftover — prune it so it is not re-scanned and re-logged every
        // restart. If a worker is somehow still alive, leave it untouched.
        if (!alive) {
          await pruneWorkspace(workingDir, number, 'no longer owned by this runner');
        } else {
          log(
            `#${number} no longer owned by this runner ` +
              `(claimed-by=${JSON.stringify(claimedBy)}); ` +
              `skipping adoption/finalization (rehydrate)`,
          );
        }
        continue;
      }

      // A missing marker, or a marker whose PID is dead/gone, means the worker
      // stopped. Retain this workspace and transition the item to paused so the
      // same machine can relaunch the recorded session here.
      if (!alive) {
        if (projectStatus !== 'in-progress') {
          // Not ours to pause and no live worker: inert leftover — prune it.
          await pruneWorkspace(workingDir, number, 'stopped worker, not in-progress');
          continue;
        }
        this.active.set(match.itemId, w);
        await this.pauseWorker(w, 'worker exited while runner was offline');
        continue;
      }

      this.active.set(match.itemId, w);
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

  /** Queue a poll cycle immediately. Bound to a keypress on the runner's
   *  terminal so an operator who just added work does not have to wait for the
   *  next poll. The flag also covers keypresses received while no abortable
   *  sleep exists. No-op while draining (no new claims are made then anyway). */
  pokeNow() {
    if (this.draining) return;
    log('manual trigger: poll cycle queued');
    this.pollRequested = true;
    this.wakeController?.abort();
  }

  /** Sleep that can be aborted by shutdown or a manual poll request. A fresh
   *  controller is created per sleep (an aborted controller stays aborted);
   *  AbortError just ends the wait early rather than crashing. */
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
    // The poll cadence is decoupled from the supervise cadence. While workers
    // are active the loop wakes every superviseTickSeconds to service their
    // status and leases, but it must NOT poll/claim on every one of those fast
    // ticks — otherwise a running worker forces a GitHub poll every few seconds
    // even while the heartbeat reports "next poll in 120s". `nextPollAt` gates
    // polling to the real idle cadence regardless of how often we tick.
    let nextPollAt = 0; // due immediately on the first iteration

    for (;;) {
      if (this.hardStop) break;

      const requested = this.pollRequested;
      const pollDue = !this.draining
        && !(once && firstCycleDone)
        && (requested || Date.now() >= nextPollAt);
      if (pollDue) {
        // Consume only the request that made this cycle due. A keypress that
        // arrives while pollAndClaim() is awaiting GitHub sets the flag again
        // and queues one more cycle instead of being overwritten here.
        if (requested) this.pollRequested = false;
        try {
          const { candidates, claimed } = await this.pollAndClaim();
          idleSeconds = claimed > 0 || candidates > 0
            ? this.cfg.pollIntervalSeconds
            : Math.min(idleSeconds * 1.5, DEFAULTS.idleBackoffMaxSeconds);
          // Heartbeat so an idle runner is visibly alive between claims: a
          // healthy poll that finds nothing otherwise prints no output, which
          // looks indistinguishable from a hung process.
          if (!once) {
            log(`polled: ${candidates} candidate(s), ${claimed} claimed, ${this.activeCount()} active; next poll in ${Math.round(idleSeconds)}s`);
          }
        } catch (e) {
          logErr(`poll cycle error: ${e.message}`);
          idleSeconds = Math.min(idleSeconds * 1.5, DEFAULTS.idleBackoffMaxSeconds);
        }
        nextPollAt = Date.now() + idleSeconds * 1000;
      }
      firstCycleDone = true;

      await this.superviseTick();

      // Exit conditions.
      if (once && this.activeCount() === 0) break;
      if (this.draining && this.activeCount() === 0) break;
      // A keypress can arrive while superviseTick() is awaiting GitHub, when
      // there is no sleep controller to abort. Do not enter a fresh sleep with
      // that request already pending.
      if (this.pollRequested) continue;

      // Sleep until the next poll is due, but while workers are active wake at
      // least every superviseTickSeconds so their status/leases are serviced
      // promptly. Polling itself is gated by nextPollAt above, so a fast
      // supervise tick no longer forces a poll. The sleep is abortable so a
      // drain/shutdown signal wakes it, and the loop top re-checks hardStop.
      const msUntilPoll = Math.max(0, nextPollAt - Date.now());
      const sleepMs = this.activeCount() > 0
        ? Math.min(DEFAULTS.superviseTickSeconds * 1000, msUntilPoll)
        : msUntilPoll;
      await this.abortableSleep(Math.max(250, sleepMs));
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

/**
 * Build a stable, human-readable window title for a worker. Format is
 * `#<number> <short title>`, collapsed to one line and truncated so it stays
 * readable in a terminal tab.
 */
function workerWindowTitle(number, title) {
  const clean = String(title || '').replace(/\s+/g, ' ').trim();
  const max = 60;
  const short = clean.length > max ? clean.slice(0, max - 1).trimEnd() + '…' : clean;
  return short ? `#${number} ${short}` : `#${number}`;
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
    log(`project schema OK: all 11 canonical fields present with correct types`);
    log(`playbooks this machine runs: ${[...playbooks.keys()].join(', ')}`);
    return 0;
  }

  const runner = new Runner(cfg, meta, playbooks);
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => runner.requestDrain());
  }

  log(`starting: identity=${cfg.identity} terminal=${cfg.terminalKind} once=${!!args.once}`);
  if (!args.once) enableManualTrigger(runner);
  await runner.loop({ once: !!args.once });
  return 0;
}

/** Bind Enter/Space on the runner's terminal to an immediate poll cycle.
 *  Uses raw keypress mode so a single key works without a trailing newline;
 *  because raw mode suppresses the automatic SIGINT, Ctrl+C is forwarded to the
 *  same drain path the signal handler uses. No-ops when stdin is not a TTY (for
 *  example, launched detached or with piped input). */
function enableManualTrigger(runner) {
  const stdin = process.stdin;
  if (!stdin.isTTY) return;

  readline.emitKeypressEvents(stdin);
  stdin.setRawMode(true);
  stdin.resume();
  if (typeof stdin.unref === 'function') stdin.unref();

  const restore = () => { try { if (stdin.isTTY) stdin.setRawMode(false); } catch {} };
  process.on('exit', restore);

  stdin.on('keypress', (_str, key) => {
    if (!key) return;
    if (key.ctrl && key.name === 'c') { restore(); runner.requestDrain(); return; }
    if (key.name === 'return' || key.name === 'enter' || key.name === 'space') {
      runner.pokeNow();
    }
  });

  log('press Enter or Space to queue a poll cycle now; Ctrl+C to drain and exit');
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
