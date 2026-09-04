import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, copyFileSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// This is the one end-to-end test that drives the real CLI: it runs
// `node bin/pan-runner.js --config <tmp>` as a subprocess with a stub `gh`
// ahead of the real one on PATH, so it exercises the direct-entry guard,
// main(), the process exit code, and the gh boundary that the in-process unit
// tests cannot reach.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.join(HERE, '..', 'bin', 'pan-runner.js');

const MACHINE = 'test-machine';
const DOMAIN_SLUG = 'example/domain';
const OWNER_TYPE = 'user';
const PROJECT_ID = 'PVT_driftfixture';

// A valid playbook so loadPlaybooks (which runs before the schema gate) accepts
// the Domain, letting the run reach and fail on the drifted schema.
const PLAYBOOK_MD = [
  '---',
  'name: isolated',
  'description: Isolated test playbook for the CLI schema-gate test',
  'capacity: 1',
  '---',
  'Body.',
  '',
].join('\n');

// The fake gh. On Unix it is the CLI entry (invoked as `node fake-gh.js ...`).
// On Windows the runner's plain `spawn('gh')` cannot resolve a .cmd/.bat (libuv
// only searches .com/.exe), so `gh.exe` is a copy of node and this same file is
// preloaded into it via NODE_OPTIONS=--require; the preload branch recognises
// and ignores the runner process and only acts for the gh child. The stub
// answers exactly the four startup calls and fails loudly on anything else, so
// any stray item poll or write surfaces as a hard error.
function fakeGhSource({ logPath }) {
  return String.raw`'use strict';
const fs = require('node:fs');
const path = require('node:path');

const LOG_PATH = ${JSON.stringify(logPath)};
const MACHINE = ${JSON.stringify(MACHINE)};
const DOMAIN_SLUG = ${JSON.stringify(DOMAIN_SLUG)};
const OWNER_TYPE = ${JSON.stringify(OWNER_TYPE)};
const PROJECT_ID = ${JSON.stringify(PROJECT_ID)};
const PLAYBOOK_MD = ${JSON.stringify(PLAYBOOK_MD)};
const PLAYBOOK_DIR = '/repos/' + DOMAIN_SLUG + '/contents/playbooks/' + MACHINE;

function done(text) { if (text) process.stdout.write(text); process.exit(0); }
function fail(msg) { process.stderr.write('fake-gh unexpected call: ' + msg + '\n'); process.exit(97); }

function handle(ghArgs) {
  fs.appendFileSync(LOG_PATH, JSON.stringify(ghArgs) + '\n');
  if (ghArgs.includes('graphql')) {
    const q = ghArgs.find((a) => typeof a === 'string' && a.startsWith('query=')) || '';
    if (q.includes('repositoryOwner')) return done('User\n');
    if (q.includes('projectV2')) {
      const resp = { data: {} };
      resp.data[OWNER_TYPE] = {
        projectV2: {
          id: PROJECT_ID,
          fields: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
        },
      };
      return done(JSON.stringify(resp));
    }
    return fail('graphql ' + q);
  }
  if (ghArgs.includes('api')) {
    const isRaw = ghArgs.some((a) => typeof a === 'string' && a.includes('application/vnd.github.raw'));
    const repoPath = ghArgs.find((a) => typeof a === 'string' && a.startsWith('/repos/')) || '';
    if (isRaw) {
      if (repoPath === PLAYBOOK_DIR + '/isolated.md') return done(PLAYBOOK_MD);
      return fail('raw ' + repoPath);
    }
    if (repoPath === PLAYBOOK_DIR) return done(JSON.stringify([{ name: 'isolated.md', type: 'file' }]));
    return fail('rest ' + repoPath);
  }
  return fail(JSON.stringify(ghArgs));
}

if (require.main === module) {
  // Unix: launched as the process entry point (node fake-gh.js api ...).
  handle(process.argv.slice(2));
} else {
  // Windows: preloaded into every node process. Leave the runner alone; for the
  // gh child, argv[0] is node's resolved first gh argument, so recover its
  // basename to rebuild the original gh argv.
  const argv = process.argv.slice(1);
  if (path.basename(String(argv[0] || '')) !== 'pan-runner.js') {
    const ghArgs = argv.slice();
    ghArgs[0] = path.basename(String(ghArgs[0]));
    handle(ghArgs);
  }
}
`;
}

// Build a self-contained sandbox: a stub gh on PATH, the fake-gh script, a
// config, and a log. Returns the paths plus a cleanup that removes everything.
function makeSandbox() {
  const dir = mkdtempSync(path.join(process.cwd(), '.pan-cli-test-'));
  const stubDir = path.join(dir, 'stub-bin');
  const workspaceRoot = path.join(dir, 'workspaces');
  const logPath = path.join(dir, 'gh-calls.log');
  const fakeGhJs = path.join(dir, 'fake-gh.cjs');
  const configPath = path.join(dir, 'config.json');
  for (const p of [stubDir, workspaceRoot]) mkdirSync(p, { recursive: true });
  writeFileSync(fakeGhJs, fakeGhSource({ logPath }), 'utf8');

  if (process.platform === 'win32') {
    // The runner's `spawn('gh')` resolves only .com/.exe, so ship gh as a node
    // copy and let NODE_OPTIONS preload the fake-gh script into it.
    copyFileSync(process.execPath, path.join(stubDir, 'gh.exe'));
  } else {
    const gh = path.join(stubDir, 'gh');
    writeFileSync(gh, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fakeGhJs)} "$@"\n`, 'utf8');
    chmodSync(gh, 0o755);
  }

  const config = {
    domainRepo: DOMAIN_SLUG,
    project: 'example/7',
    machine: MACHINE,
    identity: `${MACHINE}-runner-1`,
    panCheckout: dir,
    terminal: { kind: 'windows-terminal' },
    workspaceRoot,
    workerPermissions: 'standard',
  };
  writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');

  return {
    dir,
    stubDir,
    fakeGhJs,
    configPath,
    logPath,
    cleanup() { rmSync(dir, { recursive: true, force: true }); },
  };
}

// Run the real CLI to completion (or kill it at the timeout) and collect exit
// code plus captured streams.
function runCli({ stubDir, configPath, fakeGhJs }, timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    const basePath = process.env.PATH ?? process.env.Path ?? '';
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (key.toLowerCase() === 'path') delete env[key];
    }
    env.PATH = stubDir + path.delimiter + basePath;
    if (process.platform === 'win32') {
      const req = `--require ${JSON.stringify(fakeGhJs.replace(/\\/g, '/'))}`;
      env.NODE_OPTIONS = [process.env.NODE_OPTIONS, req].filter(Boolean).join(' ');
    }

    const child = spawn(process.execPath, [RUNNER, '--config', configPath], {
      cwd: stubDir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`runner did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

test('the real CLI refuses a drifted Project and never polls or writes items', async () => {
  const sb = makeSandbox();
  try {
    const { code, stderr } = await runCli(sb);

    // The direct-entry guard ran main(), hit the schema gate, and exited 1.
    assert.equal(code, 1, `expected exit 1, got ${code}; stderr:\n${stderr}`);

    // Recovery guidance the operator needs, end to end on the real stderr.
    assert.match(stderr, /Project schema is out of date/);
    assert.match(stderr, /missing single-select field "Status"/);
    assert.match(stderr, /Open Pan chat/);
    assert.match(stderr, /reconcile Project schema/);
    assert.match(stderr, /restart the runner/);

    // The gh boundary: exactly the four startup reads, no item poll and no write.
    const log = readFileSync(sb.logPath, 'utf8');
    const calls = log.split('\n').filter(Boolean).map((line) => JSON.parse(line));
    assert.equal(calls.length, 4, `expected 4 gh calls, got ${calls.length}: ${log}`);

    // What it did read: owner type, Project metadata, playbook dir, playbook body.
    assert.match(log, /repositoryOwner/);
    assert.match(log, /projectV2/);
    assert.match(log, /fields\(first:50/);
    assert.match(log, /\/contents\/playbooks\/test-machine"/);
    assert.match(log, /application\/vnd\.github\.raw/);

    // What it must not have done before the gate: no item polling, no item read,
    // no field write, no issue comment.
    assert.doesNotMatch(log, /items\(first:/);
    assert.doesNotMatch(log, /node\(id:/);
    assert.doesNotMatch(log, /"item-edit"/);
    assert.doesNotMatch(log, /"issue"/);
    assert.doesNotMatch(log, /"comment"/);
  } finally {
    sb.cleanup();
  }
});
