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
 *   "workspaceRoot": "/tmp/pan-workspaces"    // per-session state roots (and
 *                                             // isolated worker workspaces);
 *                                             // default os.tmpdir()/pan-workspaces
 * }
 *
 * Every launched task gets a per-session state root under workspaceRoot that
 * holds all Pan-owned control and signal files (its `.pan/` directory). A
 * playbook with a fixed `workingDirectory` or `workspaceSlots` runs the worker
 * in that real checkout, yet its Pan state still lives under workspaceRoot —
 * never inside the repository. A playbook without either uses its session root
 * as the worker's workspace too. The runner keeps no other on-disk state.
 * ---------------------------------------------------------------------------
 */

import { parseArgs } from 'node:util';
import { spawn } from 'node:child_process';
import { readFile, mkdir, writeFile, readdir, lstat, rm } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import readline from 'node:readline';
import {
  claimConfirmed,
  cleanTerminalLeaseFields,
  computeMachineSlotOccupancy,
  FIELD,
  findProjectItemForTask,
  leaseExpiredOrMissing,
  leaseIsFree,
  occupiedSlotsForPlaybook,
  ownerOf,
  pendingFinalizationKind,
  preparePoll,
  statusOf,
  val,
} from './pan-runner-poll.js';
import {
  affinityMatchesMachine,
  canonicalPathKey,
  formatAffinity,
  isSlotPooled,
  machineHasSeparator,
  parseWorkspaceSlots,
  selectSlot,
  splitAffinity,
} from './pan-runner-slots.js';
import {
  ensureIssueClosed,
  ensureIssueComment,
} from './pan-issue-lifecycle.js';
import {
  CANONICAL_FIELD_COUNT,
  schemaProblems,
} from './pan-project-schema.js';

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

export async function loadConfig(configPath) {
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

  // The machine name is embedded in composite `<machine>::<slot>` affinities, so
  // a name containing the reserved separator could not round-trip.
  if (machineHasSeparator(json.machine)) {
    throw new UserError('Config field "machine" must not contain "::" (it is reserved for workspace-slot affinities).');
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
    workspaceRoot: path.resolve(json.workspaceRoot || path.join(os.tmpdir(), 'pan-workspaces')),
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

/** Split YAML front matter from a markdown document.
 *
 *  Flat `key: value` scalars are parsed as before. Additionally, a single level
 *  of nesting is supported for a mapping value: a key whose value is empty and
 *  which is followed by indented `child: value` lines collects those children
 *  as an ordered array of `[child, value]` pairs (order preserved so duplicate
 *  child keys stay visible to validation). This is the narrow shape
 *  `workspaceSlots` needs; existing flat front matter, which has no indented
 *  lines, is unaffected. */
export function splitFrontMatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { front: {}, body: text };
  const front = {};
  let pendingMapKey = null; // top-level key awaiting nested children
  for (const line of m[1].split(/\r?\n/)) {
    if (line.trim() === '') continue;
    const indented = /^\s/.test(line);
    const kv = /^\s*([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!kv) {
      pendingMapKey = null;
      continue;
    }
    let v = stripInlineComment(kv[2]).trim();
    const isEmpty = v === 'null' || v === '';
    if (indented && pendingMapKey) {
      const childValue = isEmpty ? null : v.replace(/^["']|["']$/g, '');
      if (!Array.isArray(front[pendingMapKey])) front[pendingMapKey] = [];
      front[pendingMapKey].push([kv[1], childValue]);
      continue;
    }
    if (isEmpty) {
      front[kv[1]] = null;
      pendingMapKey = kv[1]; // becomes a mapping only if indented children follow
    } else {
      front[kv[1]] = v.replace(/^["']|["']$/g, '');
      pendingMapKey = null;
    }
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
 *  self-describes its concurrency (`capacity`) and either an optional fixed
 *  `workingDirectory` or a `workspaceSlots` mapping in its front matter. Fails
 *  loudly (UserError) on a malformed definition rather than silently dropping
 *  it. */
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

  const playbooks = new Map(); // name -> { name, description, workingDirectory, slots, capacity, body }
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

    // Optional named workspace slots. Mutually exclusive with workingDirectory:
    // a playbook either owns one fixed directory or pools work across a fixed
    // set of slot directories, never both. Slot count bounds concurrency.
    let slots = null;
    if ('workspaceSlots' in front) {
      if (workingDirectory !== null) {
        throw new UserError(
          `${dir}/${file} cannot set both workingDirectory and workspaceSlots; use one or the other.`,
        );
      }
      try {
        slots = parseWorkspaceSlots(front.workspaceSlots);
      } catch (e) {
        throw new UserError(`${dir}/${file} ${e.message}`);
      }
      if (cap > slots.length) {
        throw new UserError(
          `${dir}/${file} capacity ${cap} exceeds its ${slots.length} workspace slot(s); ` +
            'a slot-pooled playbook cannot run more concurrent tasks than it has slots.',
        );
      }
    }

    playbooks.set(name, {
      name,
      description: String(front.description).trim(),
      workingDirectory,
      slots,
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

/** Fold a page of Project field nodes into the runner's field map. */
export function collectFieldNodes(nodes, fields = new Map()) {
  for (const f of nodes || []) {
    if (!f?.name) continue;
    const options = f.options ? new Map(f.options.map((o) => [o.name, o.id])) : null;
    const dataType = f.dataType ?? (options ? 'SINGLE_SELECT' : f.__typename);
    fields.set(f.name, { id: f.id, dataType, options });
  }
  return fields;
}

/** Resolve project id, field ids, and single-select option ids. */
export async function loadProjectMeta(cfg, deps = {}) {
  const resolveOwner = deps.resolveOwnerType ?? resolveOwnerType;
  const runJson = deps.ghJson ?? ghJson;
  const ownerType = await resolveOwner(cfg.project.owner);
  const query = `query($login:String!,$number:Int!,$cursor:String){
    ${ownerType}(login:$login){
      projectV2(number:$number){
        id
        fields(first:50, after:$cursor){
          nodes{
            __typename
            ... on ProjectV2FieldCommon { id name }
            ... on ProjectV2Field { dataType }
            ... on ProjectV2SingleSelectField { id name options{ id name } }
          }
          pageInfo{ hasNextPage endCursor }
        }
      }
    }
  }`;
  const fields = new Map(); // name -> { id, dataType, options: Map(optName->optId)|null }
  let projectId = null;
  let cursor = null;
  for (;;) {
    const args = [
      'api',
      'graphql',
      '-f',
      `query=${query}`,
      '-f',
      `login=${cfg.project.owner}`,
      '-F',
      `number=${cfg.project.number}`,
    ];
    if (cursor != null) args.push('-f', `cursor=${cursor}`);
    const data = await runJson(args);
    const project = data.data[ownerType]?.projectV2;
    if (!project) throw new UserError(`Project ${cfg.project.owner}/${cfg.project.number} not found.`);
    projectId = project.id;
    collectFieldNodes(project.fields.nodes, fields);
    const page = project.fields.pageInfo;
    if (!page?.hasNextPage) break;
    cursor = page.endCursor;
  }
  return { ownerType, projectId, fields };
}

/** Validate the resolved Project against the canonical field contract. */
function validateProjectSchema(meta) {
  const problems = schemaProblems(meta.fields);
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

/** The exact shape of the v4 UUID `randomUUID()` mints for a session id. A
 *  resumed `session-id` is read back from the Project, where it could have been
 *  tampered with; requiring this exact shape rejects anything containing a path
 *  separator or `..` before it is ever interpolated into a directory name, so a
 *  crafted value can neither alias another session's root nor create a nested
 *  root that a flat rehydrate scan could not discover. */
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidSessionId(id) {
  return typeof id === 'string' && SESSION_ID_RE.test(id);
}

/** Parse a directory name into the canonical `{ number, sessionId }` a runner
 *  state root encodes (`pan-<issue>-<minted session UUID>`), or null when it is
 *  not that exact shape. Any non-canonical name is never treated as a session
 *  root, and rehydration binds this parsed identity against task.json,
 *  launch.json, and the live Project item before acting. */
function parseSessionRootName(entry) {
  const m = /^pan-(\d+)-(.+)$/.exec(entry);
  if (!m) return null;
  const number = Number(m[1]);
  const sessionId = m[2];
  if (!Number.isInteger(number) || number <= 0) return null;
  if (!isValidSessionId(sessionId)) return null;
  return { number, sessionId };
}

/** Whether `child` resolves to a strict descendant of `parent`. Used to keep a
 *  session state root confined to `workspaceRoot`: a resumed `session-id` comes
 *  from the Project, so a value carrying path separators or `..` must not let the
 *  computed root escape the workspace and have Pan write control files elsewhere. */
function isPathInside(child, parent) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** A canonical key that resolves symlinks on whatever part of `dir` already
 *  exists, so two spellings of one directory — including a symlinked alias —
 *  compare equal. Not-yet-created leaves still benefit from resolving their
 *  existing ancestors. Falls back to the lexical {@link canonicalPathKey} when
 *  nothing on the path exists. Used for the launch-time overlap guard, where a
 *  purely lexical compare could miss an aliased fixed/slot checkout. */
function canonicalRealKey(dir) {
  let resolved = path.resolve(dir);
  let probe = resolved;
  for (;;) {
    try {
      const real = realpathSync(probe);
      const rest = path.relative(probe, resolved);
      resolved = rest ? path.join(real, rest) : real;
      break;
    } catch {
      const parent = path.dirname(probe);
      if (parent === probe) break; // reached the filesystem root; nothing exists
      probe = parent;
    }
  }
  return canonicalPathKey(resolved);
}

/** Whether two directories overlap: identical, or one contains the other. Uses
 *  realpath-resolved keys so a symlinked alias is caught where the paths exist.
 *  A fixed/slot working directory and the session state root must never overlap,
 *  or Pan's `.pan/` would land inside the repository. */
function directoriesOverlap(a, b) {
  const ka = canonicalRealKey(a);
  const kb = canonicalRealKey(b);
  if (ka === kb) return true;
  const relAB = path.relative(ka, kb);
  if (relAB && !relAB.startsWith('..') && !path.isAbsolute(relAB)) return true;
  const relBA = path.relative(kb, ka);
  if (relBA && !relBA.startsWith('..') && !path.isAbsolute(relBA)) return true;
  return false;
}

/** The `version` tag every runner-written launch marker carries; a differing
 *  version is treated as invalid so a format change can't be mis-read as valid. */
const LAUNCH_MARKER_VERSION = 1;

/** Read `.pan/launch.json` as `{ present, marker }`. Absence (only `ENOENT`) is
 *  the legacy-isolated compatibility path; a present-but-unreadable/unparseable
 *  file is `{ present: true, marker: null }` so it fails closed rather than being
 *  mistaken for a legacy absent marker. */
async function readLaunchMarker(panDir) {
  let raw;
  try {
    raw = await readFile(path.join(panDir, 'launch.json'), 'utf8');
  } catch (e) {
    // Only a genuinely missing file is "absent"; any other read error (EISDIR,
    // EACCES, ENOTDIR, …) is a present-but-unreadable marker that must fail closed.
    if (e && e.code === 'ENOENT') return { present: false, marker: null };
    return { present: true, marker: null };
  }
  try {
    return { present: true, marker: JSON.parse(raw) };
  } catch {
    return { present: true, marker: null };
  }
}

/** Whether a present launch marker completely matches this runner and this
 *  session/task — the precondition for adopting, finalizing, resuming, or
 *  deleting a root that carries a `launch.json`. Any missing or mismatched field
 *  (foreign machine/identity, wrong version, or an ill-formed workspace kind/slot)
 *  fails closed. Marker absence is handled separately (the legacy path). */
function launchMarkerValid(marker, { machine, identity, sessionId, number, itemId }) {
  if (!marker || typeof marker !== 'object') return false;
  if (marker.panRunner !== true) return false;
  if (marker.version !== LAUNCH_MARKER_VERSION) return false;
  if (!machine || marker.machine !== machine) return false;
  if (!identity || marker.identity !== identity) return false;
  if (marker.itemId !== itemId) return false;
  if (marker.number !== number) return false;
  if (marker.sessionId !== sessionId) return false;
  if (typeof marker.isolated !== 'boolean') return false;
  if (marker.isolated) {
    if (marker.slot != null) return false;
  } else if (marker.slot != null && typeof marker.slot !== 'string') {
    return false;
  }
  return true;
}

/** Whether `sessionRoot` is a real, direct child directory of `workspaceRoot`
 *  and not a symlink/junction, so a read/write/removal addressed by name cannot
 *  escape `workspaceRoot`. Fail-closed on any error, link, or containment
 *  mismatch. */
async function sessionRootLinkSafe(workspaceRoot, sessionRoot) {
  let st;
  try {
    st = await lstat(sessionRoot);
  } catch {
    return false;
  }
  if (st.isSymbolicLink() || !st.isDirectory()) return false;
  try {
    const realParent = realpathSync(path.dirname(sessionRoot));
    const realWs = realpathSync(workspaceRoot);
    return canonicalPathKey(realParent) === canonicalPathKey(realWs);
  } catch {
    return false;
  }
}

/** Best-effort removal of an inert session state root during rehydrate. Removes
 *  only the state root, never a fixed/slot repository. The target is re-derived
 *  from `workspaceRoot` and the canonical name (never a worker-writable field)
 *  and re-verified as a real, direct, non-linked child before `rm`, so a corrupt
 *  marker can only cause a refusal, never a delete outside the root. A failure is
 *  logged, never fatal. */
async function pruneWorkspace(workspaceRoot, entry, number, why) {
  const parsed = parseSessionRootName(entry);
  if (!parsed) {
    logErr(`refusing to prune non-canonical entry ${JSON.stringify(entry)} for #${number}`);
    return;
  }
  const sessionRoot = path.join(workspaceRoot, entry);
  // Re-check identity and link-safety here to close any TOCTOU window between
  // discovery and removal.
  if (path.dirname(path.resolve(sessionRoot)) !== path.resolve(workspaceRoot)) {
    logErr(`refusing to prune ${sessionRoot}: not a direct child of workspaceRoot`);
    return;
  }
  if (!(await sessionRootLinkSafe(workspaceRoot, sessionRoot))) {
    logErr(`refusing to prune ${sessionRoot}: not a real direct-child directory (symlink/junction or escaped)`);
    return;
  }
  try {
    await rm(sessionRoot, { recursive: true, force: true });
    log(`#${number} pruned stale state root ${sessionRoot} (${why}) (rehydrate)`);
  } catch (e) {
    logErr(`could not prune stale state root ${sessionRoot} for #${number}: ${e.message}`);
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

export class Runner {
  constructor(cfg, meta, playbooks, deps = {}) {
    this.cfg = cfg;
    this.meta = meta;
    this.playbooks = playbooks;
    // GitHub boundary for the poll/claim AND finalize paths. Defaults to the
    // module-level `gh`-backed implementations; tests inject fakes (including the
    // issue-lifecycle/`gh` seams) to exercise finalize without a real Issue.
    this.deps = {
      readAllItems,
      readItemById,
      setTextField,
      setSelectField,
      readDomainFile,
      gh,
      ensureIssueComment,
      ensureIssueClosed,
      ...deps,
    };
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
    const items = await this.deps.readAllItems(this.cfg, this.meta);
    const cleaned = await cleanTerminalLeaseFields(items, {
      readItem: (itemId) => this.deps.readItemById(itemId),
      clearFields: async (itemId) => {
        await this.deps.setTextField(
          this.cfg,
          this.meta,
          itemId,
          FIELD.leaseUntil,
          '',
        );
        await this.deps.setTextField(
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
      readItem: (itemId) => this.deps.readItemById(itemId),
      setPaused: (itemId) =>
        this.deps.setSelectField(this.cfg, this.meta, itemId, FIELD.status, 'paused'),
      warn: logErr,
    });
    for (const item of swept) {
      const label = item.issue?.number ? `#${item.issue.number}` : `Project item ${item.itemId}`;
      log(`${label} paused: lease expired (passive sweep)`);
    }

    let claimed = 0;
    // Slots occupied on this physical machine, scoped by playbook and computed
    // once from current active state and live Project items, then updated as
    // claims land this cycle so a second claim in the same poll cannot reuse a
    // slot the first just took. Cross-playbook slot ids are independent: two
    // playbooks may each use `primary` for different directories.
    const occupiedByPlaybook = computeMachineSlotOccupancy({
      active: this.active,
      items,
      machine: this.cfg.machine,
      warn: logErr,
    });
    for (const it of candidates) {
      if (this.draining) break;
      if (this.capacityCount() >= this.cfg.maxConcurrent) break;
      const pb = val(it, FIELD.playbook, '');
      const pbObj = this.playbooks.get(pb);
      if (this.activeForPlaybook(pb) >= pbObj.capacity) continue;

      let slot = null;
      if (isSlotPooled(pbObj)) {
        const occupied = occupiedSlotsForPlaybook(occupiedByPlaybook, pb);
        const decision = selectSlot({
          slots: pbObj.slots,
          machineField: val(it, FIELD.machine, ''),
          machine: this.cfg.machine,
          occupied,
        });
        if (!decision.ok) {
          log(`#${it.issue?.number ?? it.itemId} waiting for a workspace slot (${decision.reason})`);
          continue;
        }
        slot = decision.slot;
      }

      // claimAndLaunch may re-select a different slot from the fresh affinity
      // than the poll chose, so reserve the slot it actually claimed (under the
      // playbook it actually validated), never the stale poll-time hint. A
      // failed claim/launch reserves nothing.
      const result = await this.claimAndLaunch(it, slot, occupiedByPlaybook);
      if (result) {
        claimed += 1;
        if (result.slot) {
          occupiedSlotsForPlaybook(occupiedByPlaybook, result.playbook).add(result.slot);
        }
      }
    }
    return { candidates: candidates.length, claimed };
  }

  /** Claim one item (re-read to avoid races), then launch its worker. For a
   *  slot-pooled playbook `slot` is the workspace slot the poll selected.
   *  `occupiedByPlaybook` is the poll's live `Map<playbook, Set<slot id>>` of
   *  slots already occupied on this machine (Project leases, active workers, and
   *  same-cycle reservations); the fresh re-selection below merges it with the
   *  current active slots so a slot held only by another live Project lease is
   *  not lost when occupancy is reconstructed from scratch.
   *
   *  Returns `false` on any skip/failure. On success it reports the slot it
   *  actually claimed so the caller reserves the real occupancy, not the stale
   *  poll-time hint: an ordinary (slotless) playbook returns `true` unchanged,
   *  while a slot-pooled claim returns `{ ok: true, playbook, slot }` carrying
   *  the freshly validated playbook and slot. */
  async claimAndLaunch(item, slot = null, occupiedByPlaybook = null) {
    const number = item.issue?.number;
    if (!number) return false;

    // Re-read and re-confirm dispatchable + unleased.
    const fresh = await this.deps.readItemById(item.itemId);
    if (!fresh || !fresh.issue) return false;
    const previousStatus = statusOf(fresh);
    const resuming = previousStatus === 'paused';
    if (ownerOf(fresh) !== 'agent' || (previousStatus !== 'ready' && !resuming)) return false;
    if (resuming && !affinityMatchesMachine(val(fresh, FIELD.machine, ''), this.cfg.machine)) return false;
    if (!leaseIsFree(fresh, this.cfg.identity, { warn: logErr })) return false; // claim race — skip
    const pb = val(fresh, FIELD.playbook, '');
    if (!this.playbooks.has(pb)) return false;
    const pbObj = this.playbooks.get(pb);

    // The playbook may have changed between poll and this re-read; revalidate
    // capacity against the freshly-read playbook before claiming.
    const cap = pbObj.capacity;
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

    // Re-run slot selection against the freshly-read `machine` value, the
    // current configured slots, and current occupancy (active workers for this
    // playbook on this machine). The poll's choice is only a hint: the fresh
    // affinity is authoritative, so a task that now carries a foreign-machine or
    // unconfigured affinity is skipped, one that now names a valid exact slot is
    // honored (and waits if that slot is occupied) rather than being overwritten
    // by the stale poll choice, and one still unassigned (or a legacy exact base)
    // deterministically takes the current first free slot. `machine` is written
    // as a composite `<machine>::<slot>` affinity for slot-pooled work, plain for
    // the rest.
    let machineValue = this.cfg.machine;
    if (isSlotPooled(pbObj)) {
      // Start from the poll's per-playbook occupancy (live Project leases,
      // active workers, and same-cycle reservations from earlier claims this
      // cycle) so a slot held only by another live Project lease still counts,
      // then merge in the current active slots to revalidate against any change
      // since the poll. A copy is taken so re-selection never mutates the shared
      // reservation set — the caller adds the selected slot only after a
      // successful claim. The candidate's own prior state is ready/paused (never
      // in-progress), so it is absent from the Project occupancy and cannot
      // spuriously mark its own slot as busy.
      const occupied = new Set(
        occupiedByPlaybook ? occupiedSlotsForPlaybook(occupiedByPlaybook, pb) : [],
      );
      for (const w of this.active.values()) {
        if (w.playbook === pb && w.slot) occupied.add(w.slot);
      }
      const decision = selectSlot({
        slots: pbObj.slots,
        machineField: val(fresh, FIELD.machine, ''),
        machine: this.cfg.machine,
        occupied,
      });
      if (!decision.ok) {
        log(`#${number} waiting for a workspace slot on re-read (${decision.reason}); skipping`);
        return false;
      }
      slot = decision.slot;
      machineValue = formatAffinity(this.cfg.machine, slot);
    } else {
      slot = null;
    }

    // Record the claim: claimed-by, machine, lease-until, Status=in-progress.
    // `machine` is durable provenance (which machine ran the work, and for
    // slot-pooled work which slot); unlike the lease it is not cleared on pause,
    // so a stopped task can be resumed on the same machine and slot (see
    // session-id, written at launch).
    const leaseWritten = this.leaseTimestamp();
    try {
      await this.deps.setTextField(this.cfg, this.meta, item.itemId, FIELD.claimedBy, this.cfg.identity);
      await this.deps.setTextField(this.cfg, this.meta, item.itemId, FIELD.machine, machineValue);
      await this.deps.setTextField(this.cfg, this.meta, item.itemId, FIELD.leaseUntil, leaseWritten);
      await this.deps.setSelectField(this.cfg, this.meta, item.itemId, FIELD.status, 'in-progress');
    } catch (e) {
      logErr(`claim write failed for #${number}: ${e.message}`);
      return false;
    }

    log(`claimed #${number} (${pb})`);

    // Confirming re-read (best-effort optimistic concurrency — GitHub has no
    // atomic CAS). Another runner may have written its own claim between our
    // re-read above and our writes. Re-read now and verify we still own the
    // item: claimed-by, lease-until, and machine must all be the exact values we
    // wrote and Status must be in-progress. If any changed, a foreign claim
    // won — ABANDON without writing anything (do not stomp the winner's fields)
    // and skip this item this cycle.
    let confirm;
    try {
      confirm = await this.deps.readItemById(item.itemId);
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
    if (!claimConfirmed(confirm, { identity: this.cfg.identity, lease: leaseWritten, machine: machineValue })) {
      const confirmClaimed = confirm ? val(confirm, FIELD.claimedBy, '') : '';
      log(`#${number} claim lost to another runner (claimed-by=${JSON.stringify(confirmClaimed)}); abandoning without writing`);
      return false;
    }

    // Guard against concurrent use of a shared resolved directory — a fixed
    // workingDirectory or a slot directory. Two workers sharing one `.pan/`
    // would clobber each other's signals and task context (the pre-launch
    // stale-signal cleanup wipes the other's marker), so a worker could finalize
    // the wrong task. Isolated workspaces are per-task unique and never collide.
    // This is a benign capacity collision, not an operational failure: restore
    // the just-written claim to its prior state and do NOT count a strike. We
    // only reach here still owning the claim, so the restore cannot stomp
    // another runner's winning claim.
    const fixedDir = pbObj?.workingDirectory
      ? pbObj.workingDirectory
      : (isSlotPooled(pbObj) ? pbObj.slots.find((s) => s.id === slot)?.dir : null);
    if (fixedDir) {
      const resolvedDir = canonicalPathKey(fixedDir);
      let collision = false;
      for (const w of this.active.values()) {
        if (w.workingDir && canonicalPathKey(w.workingDir) === resolvedDir) {
          collision = true;
          break;
        }
      }
      if (collision) {
        try {
          await this.deps.setTextField(this.cfg, this.meta, item.itemId, FIELD.claimedBy, '');
          // Restore `machine` to its pre-claim value: no worker ran here, so the
          // just-written claim must not leave stale provenance that would later
          // pair this machine with another machine's `session-id` and trigger a
          // bogus "resume".
          await this.deps.setTextField(this.cfg, this.meta, item.itemId, FIELD.machine, val(fresh, FIELD.machine, ''));
          await this.deps.setTextField(this.cfg, this.meta, item.itemId, FIELD.leaseUntil, '');
          await this.deps.setSelectField(this.cfg, this.meta, item.itemId, FIELD.status, previousStatus);
        } catch (e) {
          logErr(`revert-to-${previousStatus} writes failed for #${number}: ${e.message}`);
        }
        log(
          `#${number} skipped: working directory ${resolvedDir} already in use by an active worker; returned to ${previousStatus}`,
        );
        return false;
      }
    }

    try {
      await this.launchWorker(fresh, pb, slot);
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
        await this.deps.setTextField(this.cfg, this.meta, item.itemId, FIELD.needsHumanSince, '');
        const worker = this.active.get(item.itemId);
        if (worker) worker.hadNeedsHuman = false;
      } catch (e) {
        // Keep hadNeedsHuman set so normal supervision retries the clear.
        logErr(`could not clear needs-human-since while resuming #${number}: ${e.message}`);
      }
    }
    return slot ? { ok: true, playbook: pb, slot } : true;
  }

  // ---- Launch -------------------------------------------------------------

  async launchWorker(item, playbookName, slot = null) {
    const pb = this.playbooks.get(playbookName);
    const number = item.issue.number;

    // Copilot session id for resumability. Copilot sessions live on the local
    // machine, so only reuse a previously recorded session id when it was
    // created on THIS machine — then a task whose worker died can be resumed
    // (its transcript and state re-adopted) instead of started from scratch.
    // Otherwise mint a fresh UUID. Passing the id via `copilot --session-id`
    // both creates the session on first launch and resumes it on a later one.
    // A slot-pooled task's `machine` is a composite `<machine>::<slot>` value,
    // so match on the base machine.
    const previousStatus = statusOf(item);
    const recordedSessionId = val(item, FIELD.sessionId, '');
    const recordedMachine = val(item, FIELD.machine, '');
    const resuming = previousStatus === 'paused';
    if (resuming && (!recordedSessionId || !affinityMatchesMachine(recordedMachine, this.cfg.machine))) {
      throw new Error(`cannot resume #${number}: recorded session or machine is missing/mismatched`);
    }
    // Issue numbers and session ids are interpolated into the session root's
    // directory name, so both must be safe path components before any path is
    // built. The number comes from GitHub (an integer) and a fresh session id is
    // a minted UUID, but a resumed session id is read back from the Project and
    // could have been tampered with — require the exact UUID shape so a value
    // carrying separators or `..` is rejected here, not after it has aliased or
    // nested a directory.
    if (!Number.isInteger(number) || number <= 0) {
      throw new Error(`cannot launch #${number}: issue number is not a positive integer`);
    }
    if (resuming && !isValidSessionId(recordedSessionId)) {
      throw new Error(`cannot resume #${number}: recorded session-id is not a valid Pan session id`);
    }
    const sessionId = resuming ? recordedSessionId : randomUUID();

    // 1. Resolve two distinct locations. The session state root always lives
    //    under workspaceRoot and holds every Pan-owned control/signal file (its
    //    `.pan/`); it is never inside a repository. The working directory is the
    //    worker's CWD: a fixed `workingDirectory` or chosen slot is a real
    //    in-place checkout, while a playbook with neither uses its session root
    //    as the workspace as well.
    let workingDir;
    let isolated = false;
    let workerSlot = null;
    if (isSlotPooled(pb)) {
      workerSlot = slot ?? splitAffinity(recordedMachine).slot;
      const slotDef = pb.slots.find((s) => s.id === workerSlot);
      if (!slotDef) {
        throw new Error(`cannot launch #${number}: workspace slot ${JSON.stringify(workerSlot)} is not configured`);
      }
      workingDir = slotDef.dir;
    } else if (pb.workingDirectory) {
      workingDir = pb.workingDirectory;
    } else {
      isolated = true;
    }

    // The session root's name is stable for the recorded Copilot session, so a
    // resume reopens the same directory. An isolated resume reuses the directory
    // rehydrate remembered (its checkout lives there); a fixed/slot session root
    // holds only regenerable state, so it is derived purely from the stable name.
    let sessionRoot = path.join(this.cfg.workspaceRoot, `pan-${number}-${sessionId}`);
    if (isolated && resuming) {
      sessionRoot = this.resumeWorkspaces.get(item.itemId) || sessionRoot;
    }
    // Fail closed if the resolved root is not strictly inside workspaceRoot. A
    // resumed session-id comes from the Project; a value with path separators or
    // `..` must never let Pan write its control files outside the workspace.
    if (!isPathInside(sessionRoot, this.cfg.workspaceRoot)) {
      throw new Error(`cannot launch #${number}: session state directory escapes workspaceRoot (${sessionRoot})`);
    }
    // The session state root must never overlap the fixed/slot working directory,
    // or Pan's `.pan/` would land in the repository (catches a workspaceRoot that
    // equals or lives beneath a checkout, incl. a symlinked alias). Isolated tasks
    // intentionally use their root as the workspace, so this applies to fixed/slot.
    if (!isolated && directoriesOverlap(sessionRoot, workingDir)) {
      throw new Error(
        `cannot launch #${number}: session state directory (${sessionRoot}) overlaps the working directory ` +
          `(${workingDir}); workspaceRoot must be outside every fixed workingDirectory and workspaceSlots path`,
      );
    }
    await mkdir(this.cfg.workspaceRoot, { recursive: true });
    if (resuming) {
      if (isolated && !existsSync(sessionRoot)) {
        throw new Error(`cannot resume #${number}: isolated workspace is missing (${sessionRoot})`);
      }
      if (existsSync(sessionRoot)) {
        // Never follow a symlink/junction masquerading as the session root, and
        // never write into a root that does not resolve inside workspaceRoot.
        if (!(await sessionRootLinkSafe(this.cfg.workspaceRoot, sessionRoot))) {
          throw new Error(`cannot resume #${number}: state root ${sessionRoot} is not a real directory inside workspaceRoot`);
        }
        // A present marker must be this runner's complete, matching marker, or
        // the derived path aliases another session's root; a missing marker is
        // the legacy path, allowed only for an isolated resume. The recorded
        // workspace kind/slot (and, for a slot, its checkout path) must match the
        // resume target so an established session is never moved or reinterpreted.
        const { present, marker } = await readLaunchMarker(path.join(sessionRoot, '.pan'));
        if (present) {
          if (!launchMarkerValid(marker, {
            machine: this.cfg.machine,
            identity: this.cfg.identity,
            sessionId,
            number,
            itemId: item.itemId,
          })) {
            throw new Error(`cannot resume #${number}: existing state root ${sessionRoot} has an invalid/foreign marker`);
          }
          if (marker.isolated !== isolated || (marker.slot ?? null) !== (workerSlot ?? null)) {
            throw new Error(
              `cannot resume #${number}: recorded workspace kind/slot ` +
                `(${marker.isolated ? 'isolated' : (marker.slot ?? 'fixed')}) does not match the resume target ` +
                `(${isolated ? 'isolated' : (workerSlot ?? 'fixed')})`,
            );
          }
          // A slot's recorded checkout must still be the one the playbook maps it
          // to, so a same-slot-id remap refuses rather than relaunching elsewhere.
          if (workerSlot != null && marker.workingDir
            && canonicalRealKey(marker.workingDir) !== canonicalRealKey(workingDir)) {
            throw new Error(
              `cannot resume #${number}: slot ${JSON.stringify(workerSlot)} now maps to a different checkout ` +
                `(${workingDir}) than the recorded session (${marker.workingDir})`,
            );
          }
        } else if (!isolated) {
          throw new Error(`cannot resume #${number}: fixed/slot state root ${sessionRoot} has no runner marker`);
        }
      }
      await mkdir(sessionRoot, { recursive: true });
    } else {
      if (existsSync(sessionRoot)) {
        throw new Error(`new session state directory already exists (${sessionRoot})`);
      }
      await mkdir(sessionRoot);
    }
    // After creation/resume the session root must be a real directory that is a
    // direct child of workspaceRoot — never a symlink/junction — so every
    // subsequent read/write is confined to the workspace.
    if (!(await sessionRootLinkSafe(this.cfg.workspaceRoot, sessionRoot))) {
      throw new Error(`cannot launch #${number}: session state directory ${sessionRoot} is not a real directory inside workspaceRoot`);
    }

    if (isolated) {
      // An isolated worker's checkout lives inside its own session root.
      workingDir = sessionRoot;
    } else {
      await mkdir(workingDir, { recursive: true });
    }

    const panDir = path.join(sessionRoot, '.pan');
    await mkdir(panDir, { recursive: true });

    // Never clear an unprocessed result on resume: a leftover result.json means a
    // finished worker was never finalized, so fail closed (leaving the task
    // paused with its result intact for rehydrate) rather than deleting it below.
    if (resuming && existsSync(path.join(panDir, 'result.json'))) {
      throw new Error(
        `cannot resume #${number}: an unprocessed result.json is present in ${panDir}; ` +
          `refusing to clear a finished worker's result`,
      );
    }

    // Clear any stale signal files. A fresh session root has none; a resumed one
    // may still carry a dead worker's liveness/pid markers.
    await Promise.all(
      ['result.json', 'needs-human.json', 'worker.running', 'worker.pid', 'worker.stop', 'pan.md'].map((f) =>
        rm(path.join(panDir, f), { force: true }),
      ),
    );

    // 2. Task context files (always under the session root, never the repo).
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

    // Runner-owned launch metadata AND ownership marker (not a worker contract):
    // records the real working directory for restart supervision, and its
    // identity fields prove this runner created this root for this task — the
    // precondition for any later adopt/finalize/resume/delete.
    await writeFile(
      path.join(panDir, 'launch.json'),
      JSON.stringify(
        {
          panRunner: true,
          version: 1,
          machine: this.cfg.machine,
          identity: this.cfg.identity,
          itemId: item.itemId,
          number,
          sessionId,
          isolated,
          workingDir,
          slot: workerSlot,
        },
        null,
        2,
      ),
    );

    // Domain-specific instructions live in the Domain repo's pan.md and must
    // reach the worker (playbooks and worker-base-instructions alone don't
    // carry them). Fetch it live, best-effort: a Domain without a pan.md simply
    // gets no file, and a transient read failure must not block the launch.
    let hasDomainPan = false;
    try {
      const domainPan = await this.deps.readDomainFile(this.cfg, 'pan.md');
      await writeFile(path.join(panDir, 'pan.md'), domainPan);
      hasDomainPan = true;
    } catch (e) {
      logErr(`could not fetch Domain pan.md for #${number} (continuing without it): ${e.message}`);
    }

    const systemDir = path.join(this.cfg.panCheckout, 'system');
    const prompt = this.buildPrompt(systemDir, playbookName, panDir, hasDomainPan);
    await writeFile(path.join(panDir, 'launch-prompt.txt'), prompt);

    // Stable, human-readable window title so the user can tell at a glance
    // which task each spawned window is working on. Computed here because the
    // launcher bakes it in to keep re-asserting it against copilot (see below).
    const windowTitle = workerWindowTitle(number, item.issue.title);

    // Generate the Node launcher. It runs with its CWD set to workingDir but
    // reads and writes every control/signal file by its absolute path under the
    // session state root, so a fixed/slot worker's repository never gains a
    // `.pan/`. The prompt is passed to copilot as a single argv element (no
    // shell re-parses it), and `--session-id` binds the worker to the recorded
    // session so the task is resumable.
    await writeFile(path.join(panDir, 'launch.mjs'), this.buildLauncherSource(windowTitle, sessionId, panDir));

    // Record a new Copilot session before launch. Without this durable link a
    // stopped task could not be resumed, so a write failure must abort launch.
    // A resume already has the required recorded value.
    if (!resuming) {
      await this.deps.setTextField(this.cfg, this.meta, item.itemId, FIELD.sessionId, sessionId);
    }

    // 3. Pre-trust both the working directory and the session state directory so
    // the headed worker starts without an interactive "trust this folder?"
    // prompt. copilot's --allow-all covers tools/paths/URLs but NOT the
    // per-folder trust gate, which is governed only by trustedFolders in
    // ~/.copilot/config.json. Best-effort: on any failure the worker at worst
    // shows the prompt as before.
    await this.trustWorkspace(workingDir);
    if (canonicalPathKey(sessionRoot) !== canonicalPathKey(workingDir)) {
      await this.trustWorkspace(sessionRoot);
    }

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
      sessionRoot,
      panDir,
      isolated,
      slot: workerSlot,
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

  buildPrompt(systemDir, playbookName, panDir, hasDomainPan = false) {
    // Single line: some terminal launchers only read the first line of the file.
    // Every Pan file is named by its absolute path in the session state
    // directory, which is NOT the worker's repository working directory — a
    // fixed/slot worker's CWD is its checkout, so relative `.pan/...` paths would
    // wrongly resolve inside the repository.
    return [
      `You are a Pan worker doing exactly one task.`,
      `Read and follow ${path.join(systemDir, 'worker-base-instructions.md')}.`,
      `The Pan system documents are in ${systemDir}.`,
      `Your Pan state directory is ${panDir} (also in the PAN_STATE_DIR environment variable); every Pan control and signal file lives there, not in your working directory, and you must not create a .pan directory in your working directory.`,
      hasDomainPan
        ? `Read ${path.join(panDir, 'pan.md')} for Domain-specific instructions and apply them.`
        : ``,
      `Your task is in ${path.join(panDir, 'task.json')} and your playbook "${playbookName}" is in ${path.join(panDir, 'playbook.md')}.`,
      `Signal that you need the user by writing ${path.join(panDir, 'needs-human.json')} (delete it once resolved), and write ${path.join(panDir, 'result.json')} exactly once when finished.`,
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
   * Source for the generated `launch.mjs`. It runs with CWD = the worker's
   * repository working directory, but it reads and writes every control/signal
   * file by its absolute path under the session state directory (baked in as
   * `panDir`), so a fixed/slot worker's repository never gains a `.pan/`. It
   * maintains the liveness marker and pid, then spawns copilot with the prompt
   * as a single argv element (never re-parsed by any shell). copilotBin and the
   * argument list are baked in as JSON literals so the launcher reads no config
   * at runtime. Permission flags derived from workerPermissions come first, then
   * `--add-dir <panDir>` so copilot may access the out-of-tree state directory,
   * then any configured copilotArgs, then `--session-id <id>` so the worker runs
   * under the exact session id recorded on the Issue — creating that session on
   * first launch and resuming it on a later one (see system/runner.md,
   * "Lease-driven resume"). PAN_STATE_DIR and PAN_WORKING_DIRECTORY are exported
   * to the worker so its signalling can name the state directory robustly.
   *
   * The launcher also runs a title watchdog: copilot rewrites the terminal
   * title (`OSC 0`) repeatedly during a session with its own AI-generated
   * summary, and that always wins over a terminal-side "custom title". So the
   * launcher periodically re-emits our stable task title to the tty, keeping
   * each worker window identifiable. This is a benign competition — an `OSC 0`
   * title escape never touches copilot's alt-screen content — with at most a
   * brief flicker to copilot's title after each of its (infrequent) updates.
   *
   * Finally, the launcher watches for `worker.stop` in the state directory,
   * which the runner writes once it has finalized the task. On that signal the
   * launcher stops copilot and closes its own terminal window so finished worker
   * windows do not accumulate: on macOS it asks Terminal.app to close the window
   * matching its tty; on Windows it simply exits 0 and Windows Terminal
   * auto-closes the tab. On macOS the launcher runs via `exec node` (it replaced
   * the login shell), so when it exits the tab has no running process and
   * Terminal closes it without its "terminate running processes in this window?"
   * prompt.
   */
  buildLauncherSource(windowTitle = '', sessionId = '', panDir = '') {
    const copilotBin = JSON.stringify(this.cfg.copilotBin);
    const sessionArgs = sessionId ? ['--session-id', sessionId] : [];
    // Grant copilot file access to the out-of-tree state directory; it holds the
    // task context the worker must read and the signal files it must write.
    const addDirArgs = panDir ? ['--add-dir', panDir] : [];
    // copilot has no positional prompt argument: the initial prompt must be the
    // VALUE of -i/--interactive (see `copilot --help`). The launcher appends
    // `--interactive <promptText>` at spawn time, so strip any bare interactive
    // flag a config may still carry, otherwise it would consume the prompt as
    // its value and leave the real prompt as a rejected positional argument.
    const baseArgs = [...this.cfg.permissionArgs, ...addDirArgs, ...this.cfg.copilotArgs, ...sessionArgs]
      .filter((a) => a !== '--interactive' && a !== '-i');
    const copilotArgs = JSON.stringify(baseArgs);
    const title = JSON.stringify(windowTitle || '');
    const panDirLit = JSON.stringify(panDir);
    return `import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// Baked in by the runner; the launcher reads no config at runtime.
const copilotBin = ${copilotBin};
const copilotArgs = ${copilotArgs};
const windowTitle = ${title};
// Absolute session state directory. Every control/signal file is addressed
// under it, so the launcher never depends on its CWD (the repository checkout).
const panDir = ${panDirLit};

const marker = join(panDir, 'worker.running');
const stopSignal = join(panDir, 'worker.stop');
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

// The runner writes worker.stop into the state directory after it finalizes the
// task (records the result and updates the Project). That is our cue to shut
// copilot down and close this window so finished worker windows don't pile up.
// We exit 0 so Windows Terminal auto-closes the tab; the detached closer handles
// macOS.
function shutdownForStop() {
  if (stopping) return;
  stopping = true;
  if (stopTimer) { try { clearInterval(stopTimer); } catch {} stopTimer = null; }
  closeWindow();
  try { child.kill('SIGTERM'); } catch {}
  cleanup();
  setTimeout(() => process.exit(0), 400);
}

try { writeFileSync(join(panDir, 'worker.pid'), String(process.pid)); } catch {}
try { writeFileSync(marker, ''); } catch {}

// Remove the marker on normal exit and on window-close signals, mirroring the
// old bash \`trap\`. A hard kill (SIGKILL) cannot run handlers; the runner's
// rehydration pause and liveness grace still recover a truly-gone worker.
process.on('exit', cleanup);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => { cleanup(); process.exit(130); });
}

const promptText = readFileSync(join(panDir, 'launch-prompt.txt'), 'utf8');
// The prompt is the value of copilot's -i/--interactive flag, never a bare
// positional argument (copilot has no positional prompt and would reject it).
// PAN_STATE_DIR / PAN_WORKING_DIRECTORY let the worker name its state directory
// (and confirm its checkout) without re-deriving either from the prompt.
const child = spawn(copilotBin, [...copilotArgs, '--interactive', promptText], {
  stdio: 'inherit',
  env: { ...process.env, PAN_STATE_DIR: panDir, PAN_WORKING_DIRECTORY: process.cwd() },
});
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
    // The Node launcher owns the liveness marker and pid; we only cd into the
    // repository working dir (the worker's CWD) and run the launcher by its
    // absolute path in the out-of-tree state directory. No prompt text flows
    // through the shell — the sole shell-quoted values are the controlled
    // working-dir path, nodeBin, and the launcher path.
    const nodeBin = this.cfg.nodeBin;
    const launcher = path.join(panDir, 'launch.mjs');
    // `exec` replaces the login shell (`-zsh`) with the Node launcher so the
    // tab has exactly one process — node — and no leftover interactive shell.
    // That matters when the launcher closes its own window on completion: once
    // node exits the tab has NO running process at all ("[Process completed]"),
    // so Terminal.app closes it silently instead of showing its "Do you want to
    // terminate running processes in this window?" prompt for the idle shell
    // (see buildLauncherSource / closeWindow).
    const doScript = `cd ${shQuote(workingDir)} && exec ${shQuote(nodeBin)} ${shQuote(launcher)}`;
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
    // Launch the Node launcher via an argv array with no cmd prompt expansion.
    // `-d workingDir` sets the CWD to the worker's repository checkout; the
    // launcher itself is referenced by its absolute path in the out-of-tree
    // state directory and addresses every signal file there, so no `.pan/` is
    // created under the repository. The launcher maintains the liveness marker
    // (including on window-close signals), so no batch file is needed.
    // `--title` plus `--suppressApplicationTitle` pin a stable task name that
    // Windows Terminal will not let the running program overwrite. (The
    // launcher's title watchdog also runs, but its OSC titles are ignored here
    // for the same reason — belt-and-suspenders with the macOS path.)
    const ntArgs = ['-w', '0', 'nt'];
    if (title) {
      ntArgs.push('--title', title, '--suppressApplicationTitle');
    }
    ntArgs.push('-d', workingDir, this.cfg.nodeBin, path.join(panDir, 'launch.mjs'));
    await spawnOk('wt.exe', ntArgs, { detached: true });
  }

  // ---- Supervision --------------------------------------------------------

  async superviseTick() {
    for (const [itemId, w] of [...this.active.entries()]) {
      if (w.finished) {
        this.active.delete(itemId);
        continue;
      }
      // Occupancy-only entries reserve a live-but-not-ours worker's directory so
      // no duplicate launches into it; we must not supervise or write its
      // Project fields (that would steal it from its owner). Drop the entry once
      // its worker exits, freeing the directory without any Project write.
      if (w.occupancyOnly) {
        const markerPath = path.join(w.panDir, 'worker.running');
        if (!(existsSync(markerPath) && (await workerPidAlive(w.panDir)))) {
          this.active.delete(itemId);
          log(`#${w.issueNumber} occupancy-only worker exited; releasing its reserved directory`);
        }
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
    // via `wt.exe`, but the generated launcher writes its OWN pid to
    // `worker.pid` in the session state directory, so the tracked PID is the
    // real local launcher node process and `process.kill(pid, 0)` is reliable
    // for BOTH terminal kinds. If a future terminal kind cannot yield a
    // trackable local PID, the marker-only presence check remains the fallback.
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
      fresh = await this.deps.readItemById(w.itemId);
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
    const freshSessionId = val(fresh, FIELD.sessionId, '');
    const freshMachine = val(fresh, FIELD.machine, '');

    // Revalidate the live item against this worker before ANY write, so a stale
    // snapshot can never commit onto drifted state: require a non-empty session-id
    // still equal to this worker's and a matching machine/slot affinity.
    const sessionMatches = !!w.sessionId && freshSessionId === w.sessionId;
    const affinityMatches = affinityMatchesMachine(freshMachine, this.cfg.machine)
      && (w.slot == null || splitAffinity(freshMachine).slot === w.slot);
    if (!sessionMatches || !affinityMatches) {
      logErr(
        `finalization for #${w.issueNumber} stopped: live session/affinity no longer ` +
          `matches this worker (session=${JSON.stringify(freshSessionId)}, ` +
          `machine=${JSON.stringify(freshMachine)}); stopping without writes`,
      );
      await this.stopFinalizedWorker(w);
      return true;
    }

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
    // Finalize a passively-swept paused item only when it is still our finished
    // worker: a lapsed lease and our surviving claim on a still-paused item (an
    // unclaimed pause is a manual pause). Only the rehydrate swept path sets this
    // flag, so normal supervision is unaffected.
    const sweptPausedOurs = w.finalizeFromPausedSweep
      && currentStatus === 'paused'
      && claimedBy === this.cfg.identity
      && leaseExpiredOrMissing(fresh);
    if (
      (claimedBy && claimedBy !== this.cfg.identity) ||
      (currentStatus === 'in-progress' &&
        claimedBy !== this.cfg.identity) ||
      (currentStatus !== 'in-progress' && currentStatus !== status && !sweptPausedOurs)
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
      await this.deps.ensureIssueComment(
        this.deps.gh,
        this.issueRepoOf(w),
        w.issueNumber,
        `<!-- pan-result:${w.sessionId} -->`,
        comment,
      );
      // Clear any lingering human-attention signal on completion (idempotent).
      await this.deps.setTextField(this.cfg, this.meta, w.itemId, FIELD.needsHumanSince, '');
      if (outcome === 'done') {
        await this.deps.ensureIssueClosed(this.deps.gh, this.issueRepoOf(w), w.issueNumber);
      }
      await this.deps.setSelectField(this.cfg, this.meta, w.itemId, FIELD.status, status);
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
    await this.deps.setTextField(this.cfg, this.meta, w.itemId, FIELD.leaseUntil, '');
    await this.deps.setTextField(this.cfg, this.meta, w.itemId, FIELD.claimedBy, '');
    const confirmed = await this.deps.readItemById(w.itemId);
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
      fresh = await this.deps.readItemById(w.itemId);
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
      await this.deps.setSelectField(
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
    await this.deps.ensureIssueComment(
      this.deps.gh,
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
      if (status === 'paused' && affinityMatchesMachine(val(fresh, FIELD.machine, ''), this.cfg.machine) && w.isolated && existsSync(w.workingDir)) {
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

  /**
   * Decide whether a live worker discovered at restart can be safely (re-)adopted
   * for supervision. The startup snapshot is stale, so this re-reads the item
   * immediately: it adopts an already-`in-progress`+ours item as-is, restores a
   * claim only for the exact passive-sweep state (with a confirming re-read), and
   * otherwise returns false so the caller reserves the directory occupancy-only
   * rather than overwriting newer Project state. Fail-closed against any session,
   * machine, or ownership drift.
   */
  async reAdoptLiveWorker(w) {
    let fresh;
    try {
      fresh = await this.deps.readItemById(w.itemId);
    } catch (e) {
      logErr(`live re-adopt re-read failed for #${w.issueNumber}: ${e.message}`);
      return false;
    }
    if (!fresh) return false;

    const status = statusOf(fresh);
    const claimedBy = val(fresh, FIELD.claimedBy, '');
    const machine = val(fresh, FIELD.machine, '');
    const sessionId = val(fresh, FIELD.sessionId, '');

    // The live item must still be the same session on our machine, or this is no
    // longer the worker we think it is.
    if (!sessionId || sessionId !== w.sessionId || !affinityMatchesMachine(machine, this.cfg.machine)) {
      return false;
    }

    // Already in-progress and ours: adopt without touching the Project.
    if (status === 'in-progress' && claimedBy === this.cfg.identity) {
      w.lastRenew = 0; // force an immediate renewal on the next tick
      return true;
    }

    // The only drift we restore is the exact passive-sweep state (paused, our
    // claim intact, lapsed lease); anything else is left for reservation.
    const restorable = status === 'paused'
      && claimedBy === this.cfg.identity
      && leaseExpiredOrMissing(fresh);
    if (!restorable) return false;

    const lease = this.leaseTimestamp();
    try {
      await this.deps.setTextField(this.cfg, this.meta, w.itemId, FIELD.claimedBy, this.cfg.identity);
      await this.deps.setTextField(this.cfg, this.meta, w.itemId, FIELD.leaseUntil, lease);
      await this.deps.setSelectField(this.cfg, this.meta, w.itemId, FIELD.status, 'in-progress');
    } catch (e) {
      logErr(`could not restore claim for live #${w.issueNumber} on rehydrate: ${e.message}`);
      return false;
    }

    // Confirming re-read: another actor may have raced our writes. Require the
    // exact values we wrote plus the unchanged session/machine binding.
    let confirm;
    try {
      confirm = await this.deps.readItemById(w.itemId);
    } catch (e) {
      logErr(`live re-adopt confirm re-read failed for #${w.issueNumber}: ${e.message}`);
      return false;
    }
    if (
      !confirm ||
      statusOf(confirm) !== 'in-progress' ||
      val(confirm, FIELD.claimedBy, '') !== this.cfg.identity ||
      val(confirm, FIELD.leaseUntil, '') !== lease ||
      val(confirm, FIELD.sessionId, '') !== w.sessionId ||
      !affinityMatchesMachine(val(confirm, FIELD.machine, ''), this.cfg.machine)
    ) {
      logErr(`live re-adopt not confirmed for #${w.issueNumber}; reserving directory instead`);
      return false;
    }
    w.lastRenew = Date.now();
    log(`#${w.issueNumber} live worker: restored in-progress claim from a passive sweep (rehydrate)`);
    return true;
  }

  // ---- Rehydration (best-effort) -----------------------------------------

  /**
   * Best-effort restart adoption: scan workspaceRoot for per-session state roots
   * and reconcile each against the live Project.
   *
   * Invariant: every adoption, finalization, or deletion requires the state root
   * to bind to the live Project item (canonical name, task.json, a complete valid
   * launch.json marker, and the item agreeing on issue/itemId/machine/session and,
   * for a slot, the slot id and its checkout path). A live worker's directory is
   * always kept reserved so no duplicate launches; a stopped in-progress worker is
   * released to paused; an inert root is pruned only when its marker validates.
   * Anything short of full binding is preserved untouched, never finalized or
   * deleted. See bin/README.md for the detailed contract.
   *
   * LIMITATION: a task whose `.pan/` predates this state-separation is not under
   * workspaceRoot and is not discovered here (its expired lease is still swept to
   * `paused` at poll time), and a worker's exact child process is not re-attached.
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
        items = await this.deps.readAllItems(this.cfg, this.meta);
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
    // state roots for one Project item, a live worker wins over a dead leftover.
    const workspaces = [];
    for (const entry of entries) {
      // Only directories named exactly `pan-<issue>-<minted session UUID>` are
      // runner state roots. Anything else under workspaceRoot — a user's
      // checkout, a legacy/fake name — never parses, so rehydrate can never
      // adopt, finalize, or prune it. The parsed `{ number, sessionId }` is the
      // first of the four sources (name, task.json, launch.json, Project item)
      // whose exact agreement gates every action below.
      const parsedName = parseSessionRootName(entry);
      if (!parsedName) continue;
      const sessionRoot = path.join(this.cfg.workspaceRoot, entry);
      const panDir = path.join(sessionRoot, '.pan');
      const taskPath = path.join(panDir, 'task.json');
      const markerPath = path.join(panDir, 'worker.running');
      const resultPath = path.join(panDir, 'result.json');
      // lstat (not stat): never follow a symlink/junction, or a linked "session
      // root" could make rehydrate read/write/remove outside workspaceRoot.
      let st;
      try {
        st = await lstat(sessionRoot);
      } catch {
        continue;
      }
      if (st.isSymbolicLink() || !st.isDirectory()) {
        logErr(`rehydrate: ignoring non-directory or linked session root ${sessionRoot}`);
        continue;
      }
      if (!(await sessionRootLinkSafe(this.cfg.workspaceRoot, sessionRoot))) {
        logErr(`rehydrate: ignoring session root ${sessionRoot} that does not resolve inside workspaceRoot`);
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

      // launch.json is launch metadata AND an ownership marker. An absent marker
      // is the legacy-isolated path; a present marker must be fully valid (see
      // launchMarkerValid) or it authorizes nothing.
      let workingDir = sessionRoot;
      let isolated = true;
      let launchSlot = null;
      const { present: markerPresent, marker } = await readLaunchMarker(panDir);
      if (marker) {
        if (typeof marker.workingDir === 'string' && marker.workingDir) {
          workingDir = marker.workingDir;
        }
        // Only an explicit `isolated: false` marks a fixed/slot task.
        isolated = marker.isolated !== false;
        launchSlot = marker.slot ?? null;
      }
      const markerValid = markerPresent && launchMarkerValid(marker, {
        machine: this.cfg.machine,
        identity: this.cfg.identity,
        sessionId: parsedName.sessionId,
        number: parsedName.number,
        itemId: task.itemId,
      });
      // Bindable (adoptable/finalizable/resumable) requires name↔task agreement
      // plus a valid marker OR a genuine legacy root with no marker; a
      // present-but-invalid marker is never bindable. Deletion requires the
      // stricter valid marker (`owned`).
      const nameTaskAgree = number === parsedName.number;
      const markerAbsent = !markerPresent;
      const bindable = nameTaskAgree && (markerValid || markerAbsent);
      const owned = markerValid;

      // Alive = liveness marker present AND its recorded PID is a live process.
      const alive = existsSync(markerPath) && (await workerPidAlive(panDir));
      workspaces.push({
        entry,
        sessionRoot,
        workingDir,
        isolated,
        slot: launchSlot,
        panDir,
        resultPath,
        task,
        number,
        nameNumber: parsedName.number,
        nameSessionId: parsedName.sessionId,
        markerPresent,
        markerValid,
        bindable,
        alive,
        owned,
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
        entry,
        sessionRoot,
        workingDir,
        isolated,
        slot: launchSlot,
        panDir,
        resultPath,
        task,
        number,
        nameNumber,
        nameSessionId,
        markerPresent,
        markerValid,
        bindable,
        alive,
        owned,
      } = workspace;

      // Deletion is fail-closed on ownership (`owned` = a fully valid marker). The
      // target is re-derived inside pruneWorkspace from workspaceRoot + the
      // canonical name and re-checked for symlink/containment safety.
      const pruneIfOwned = async (why) => {
        if (owned) {
          await pruneWorkspace(this.cfg.workspaceRoot, entry, number, why);
        } else {
          log(
            `#${number} leaving state root ${sessionRoot} untouched ` +
              `(${why}); no valid runner ownership marker (rehydrate)`,
          );
        }
      };

      const match = findProjectItemForTask(items, task);
      if (!match) {
        // Gone from the Project: an inert leftover if no worker is alive here.
        if (!alive) await pruneIfOwned('task not found on Project');
        continue;
      }

      if (this.active.has(match.itemId)) {
        if (!alive) {
          log(`#${number} has an older inactive duplicate state root at ${sessionRoot}; leaving it untouched`);
        }
        continue;
      }

      // A present-but-invalid marker authorizes nothing; leave the root untouched.
      // (An absent marker is the legacy path, handled below via `bindable`.)
      if (markerPresent && !markerValid) {
        logErr(
          `#${number} has an invalid/foreign launch marker at ${sessionRoot}; ` +
            `leaving it untouched (no adopt/finalize/prune) (rehydrate)`,
        );
        continue;
      }

      const projectStatus = statusOf(match);
      const projectMachine = val(match, FIELD.machine, '');
      const projectSessionId = val(match, FIELD.sessionId, '');
      const claimedBy = val(match, FIELD.claimedBy, '');

      // Bind the root to the live Project item so a stale session-A root can never
      // act on the current session B: issue number, itemId, machine, session-id,
      // and — for a slot — the composite slot AND its recorded checkout path
      // (the playbook must still map that slot id to the same directory), so an
      // established session is never moved between slot checkouts.
      const projectSlot = splitAffinity(projectMachine).slot;
      let slotPathBound = true;
      if (launchSlot != null) {
        const pb = this.playbooks.get(task.playbook);
        const slotDef = pb && isSlotPooled(pb) ? pb.slots.find((s) => s.id === launchSlot) : null;
        slotPathBound = !!slotDef && canonicalRealKey(slotDef.dir) === canonicalRealKey(workingDir);
      }
      const sessionBound = bindable
        && match.issue?.number === nameNumber
        && match.itemId === task.itemId
        && projectSessionId === nameSessionId
        && affinityMatchesMachine(projectMachine, this.cfg.machine)
        && projectSlot === (launchSlot ?? null)
        && slotPathBound;

      // A pending result is finalizable only when it is our finished worker:
      // session-bound with a lapsed lease (the surviving-claim check is in
      // pendingFinalizationKind). Anything else leaves the result untouched.
      const sweptEligible = sessionBound && leaseExpiredOrMissing(match);

      const w = {
        itemId: match.itemId,
        issueNumber: number,
        title: task.title,
        url: task.url,
        repo: task.repo || repoFromUrl(task.url),
        playbook: task.playbook,
        workingDir,
        sessionRoot,
        panDir,
        isolated,
        slot: launchSlot,
        sessionId: projectSessionId,
        startedAt: Date.now(),
        lastRenew: 0, // force an immediate lease renewal
        hadNeedsHuman: !!val(match, FIELD.needsHumanSince, ''),
        needsHumanRelayed: false,
        warnedPartialNeedsHuman: false,
        lastBadOutcome: null,
        finished: false,
      };

      // Reserve a live worker's fixed/slot directory without adopting it, so no
      // second worker is ever launched into the same checkout when we cannot
      // safely take over the live process.
      const reserveLiveOccupancy = (why) => {
        w.occupancyOnly = true;
        this.active.set(match.itemId, w);
        logErr(`#${number} reserving its working directory without adopting (${why}) (rehydrate)`);
      };

      // Process a pending result before any paused handling, so a passive sweep
      // to paused cannot strand — and a later resume cannot clear — the outcome.
      if (existsSync(resultPath)) {
        let pendingStatus = null;
        try {
          pendingStatus = terminalStatusForResult(
            JSON.parse(await readFile(resultPath, 'utf8')),
          );
        } catch {
          pendingStatus = null;
        }
        // Only a valid result drives a finalize/skip decision; a partial/garbage
        // one falls through to the alive/paused handling below.
        if (pendingStatus) {
          // Never finalize against a result whose session does not bind to the
          // item's current one. Preserve it, and reserve the directory if a
          // launcher is still alive.
          if (!sessionBound) {
            log(
              `#${number} pending result is not bound to the current Project session ` +
                `(root ${nameSessionId} vs item ${JSON.stringify(projectSessionId)}); ` +
                `leaving the result untouched (rehydrate)`,
            );
            if (alive) reserveLiveOccupancy('unbound live result');
            continue;
          }

          const finalizationKind = pendingFinalizationKind({
            projectStatus,
            pendingStatus,
            claimedBy,
            identity: this.cfg.identity,
            sweptEligible,
          });

          if (!finalizationKind) {
            // Externally transitioned (foreign claim, manual pause, or moved).
            // Never prune — that would discard an unprocessed result — and
            // reserve the directory if a launcher is still alive.
            log(
              `#${number} has a pending result but is not this runner's to finalize ` +
                `(status=${projectStatus}, claimed-by=${JSON.stringify(claimedBy)}); ` +
                `leaving the result untouched (rehydrate)`,
            );
            if (alive) reserveLiveOccupancy('unfinalizable external result');
            continue;
          }
          w.finalizationEscalated = finalizationKind === 'escalated';
          w.finalizeFromPausedSweep = finalizationKind === 'swept';
          const finalized = await this.finalize(w, resultPath);
          if (finalized) continue;
          if (w.finalizationPending) {
            this.active.set(match.itemId, w);
            log(`rehydrated pending finalization for #${number} from ${sessionRoot}`);
            continue;
          }
          // finalize returned false (transient); fall through to liveness handling.
        }
      }

      // A live worker keeps its directory reserved so no duplicate launches. It
      // is only (re-)adopted for supervision when it still binds to this session
      // and a fresh, confirmed re-read shows it is ours.
      if (alive) {
        const adopted = sessionBound && (await this.reAdoptLiveWorker(w));
        if (adopted) {
          this.active.set(match.itemId, w);
          log(`re-adopted live worker for #${number} in ${workingDir} (state ${sessionRoot})`);
          continue;
        }
        reserveLiveOccupancy(
          sessionBound
            ? `claimed by ${JSON.stringify(claimedBy)} or restore not confirmed`
            : 'session not bound to the Project item',
        );
        continue;
      }

      // From here the worker is stopped (no live process). Paused work is
      // intentionally unclaimed; preserve its state root (never read the empty
      // claimed-by field as evidence it is inert). Only the root whose session
      // binds to the Project item is indexed for the next resume — a stale
      // session's root must never become the resume target for the current one.
      if (projectStatus === 'paused' && affinityMatchesMachine(projectMachine, this.cfg.machine)) {
        if (isolated && sessionBound) {
          this.resumeWorkspaces.set(match.itemId, sessionRoot);
        }
        log(`found paused ${isolated ? 'workspace' : 'session state'} for #${number} at ${sessionRoot}`);
        continue;
      }

      if (claimedBy !== this.cfg.identity) {
        // No longer ours: finalized (finalize clears claimed-by) or released to
        // another runner. With no live worker here, the state root is an inert
        // leftover — prune the root only (never the repo), gated on ownership.
        await pruneIfOwned('no longer owned by this runner');
        continue;
      }

      // Still ours but the worker stopped. Retain this state root and transition
      // the item to paused so the same machine can relaunch the recorded session
      // here.
      if (projectStatus !== 'in-progress') {
        // Not ours to pause and no live worker: inert leftover — prune the root
        // only, gated on ownership.
        await pruneIfOwned('stopped worker, not in-progress');
        continue;
      }
      this.active.set(match.itemId, w);
      await this.pauseWorker(w, 'worker exited while runner was offline');
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

  return startAfterLoad({ cfg, meta, playbooks, args });
}

/**
 * Surface actionable recovery guidance when a Project's schema has drifted, and
 * report whether that drift must stop startup.
 */
export function reportSchemaDrift(problems, emit = logErr) {
  if (problems.length === 0) return false;
  emit('Project schema is out of date; the runner cannot poll safely.');
  for (const problem of problems) emit(`  - ${problem}`);
  emit('');
  emit('Open Pan chat and run the "reconcile Project schema" action to bring the');
  emit('Project up to date, then restart the runner. See system/project-schema.md');
  emit('(Reconciling the Project schema) and system/runner.md.');
  return true;
}

/** Decide startup from already-loaded state: validate, refuse on schema drift, or poll. */
export async function startAfterLoad({
  cfg,
  meta,
  playbooks,
  args,
  makeRunner = (c, m, p) => new Runner(c, m, p),
}) {
  if (args['validate-config']) {
    validateProjectSchema(meta);
    log(`config OK: domain=${cfg.domainRepoSlug} project=${cfg.project.owner}/${cfg.project.number} machine=${cfg.machine}`);
    log(`worker permissions: ${cfg.workerPermissions}${cfg.workerPermissions === 'yolo' ? ' (workers launch with --allow-all)' : ''}`);
    log(`project schema OK: all ${CANONICAL_FIELD_COUNT} canonical fields present with correct types and options`);
    log(`playbooks this machine runs: ${[...playbooks.keys()].join(', ')}`);
    return 0;
  }

  // Refuse to poll a Project whose schema no longer satisfies the contract.
  if (reportSchemaDrift(schemaProblems(meta.fields))) return 1;

  const runner = makeRunner(cfg, meta, playbooks);
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

// Start the runner only when this file is the process entry point, not on import.
function isCliEntryPoint() {
  const invoked = process.argv[1];
  if (!invoked) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(invoked)).href;
  } catch {
    return false;
  }
}

if (isCliEntryPoint()) {
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
}
