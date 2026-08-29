import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Runner, loadConfig, readIssue } from '../bin/pan-runner.js';
import { FIELD } from '../bin/pan-runner-poll.js';
import { canonicalPathKey } from '../bin/pan-runner-slots.js';

// These tests drive the real launchWorker / rehydrate path so they prove actual
// path construction, not a stubbed launch. Only the GitHub boundary and the
// terminal spawn are faked: launchWorker really resolves the session state root
// vs. the repository working directory, writes the `.pan/` files, and generates
// the launcher, so a regression that puts state back inside a repo would fail.

const MACHINE = 'box';
const IDENTITY = 'box-runner-1';
const VALID_LEASE = '2999-01-01T00:00:00.000Z';

function makeSandbox() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pan-launch-'));
  const workspaceRoot = path.join(dir, 'workspaces');
  const copilotConfigPath = path.join(dir, 'copilot-config.json');
  mkdirSync(workspaceRoot, { recursive: true });
  return { dir, workspaceRoot, copilotConfigPath, cleanup() { rmSync(dir, { recursive: true, force: true }); } };
}

function baseCfg(sb, overrides = {}) {
  return {
    machine: MACHINE,
    identity: IDENTITY,
    leaseMinutes: 15,
    maxConcurrent: 10,
    panCheckout: sb.dir,
    workspaceRoot: sb.workspaceRoot,
    copilotConfigPath: sb.copilotConfigPath,
    copilotBin: 'copilot',
    permissionArgs: ['--deny-tool=ask_user'],
    copilotArgs: [],
    nodeBin: 'node',
    terminalKind: 'windows-terminal',
    ...overrides,
  };
}

function item({
  itemId = 'item-1',
  number = 1,
  status = 'in-progress',
  owner = 'agent',
  playbook = 'fixed',
  machine = '',
  sessionId = '',
  title = 'Fix the thing',
} = {}) {
  return {
    itemId,
    issue: {
      number,
      title,
      body: 'body',
      url: `https://github.com/example/domain/issues/${number}`,
      repo: 'example/domain',
    },
    fields: {
      [FIELD.status]: status,
      [FIELD.owner]: owner,
      [FIELD.playbook]: playbook,
      [FIELD.machine]: machine,
      [FIELD.sessionId]: sessionId,
      [FIELD.claimedBy]: '',
      [FIELD.leaseUntil]: '',
      [FIELD.workstream]: '',
      [FIELD.needsHumanSince]: '',
    },
  };
}

function fixedPlaybook(dir) {
  return new Map([['fixed', { name: 'fixed', description: 'x', workingDirectory: dir, slots: null, capacity: 1, body: 'FIXED BODY' }]]);
}
function slotPlaybook(dir) {
  return new Map([['pooled', { name: 'pooled', description: 'x', workingDirectory: null, slots: [{ id: 'primary', dir }], capacity: 1, body: 'POOLED BODY' }]]);
}
function isolatedPlaybook() {
  return new Map([['isolated', { name: 'isolated', description: 'x', workingDirectory: null, slots: null, capacity: 1, body: 'ISO BODY' }]]);
}

// A Runner with a real launchWorker but faked IO: the GitHub boundary is stubbed
// and the terminal spawn is captured instead of opening a window.
function makeLaunchRunner(sb, playbooks, { domainPan = null, issueReader = null } = {}) {
  const spawned = [];
  const writes = [];
  const issueReads = [];
  const deps = {
    readAllItems: async () => [],
    readItemById: async () => null,
    readIssue: async (issue) => {
      issueReads.push({ ...issue });
      return issueReader ? issueReader(issue, issueReads.length) : { ...issue, comments: [] };
    },
    setTextField: async (_cfg, _meta, id, field, value) => { writes.push({ id, field, value }); },
    setSelectField: async (_cfg, _meta, id, field, value) => { writes.push({ id, field, value }); },
    readDomainFile: async () => {
      if (domainPan == null) throw new Error('no Domain pan.md');
      return domainPan;
    },
  };
  const runner = new Runner(baseCfg(sb), { fields: new Map() }, playbooks, deps);
  runner.spawnTerminal = async (workingDir, panDir, title) => { spawned.push({ workingDir, panDir, title }); };
  return { runner, spawned, writes, issueReads };
}

function stateRootFor(sb, number, sessionId) {
  return path.join(sb.workspaceRoot, `pan-${number}-${sessionId}`);
}

function trustedFolders(sb) {
  return JSON.parse(readFileSync(sb.copilotConfigPath, 'utf8')).trustedFolders || [];
}

function includesPath(list, target) {
  return list.some((p) => canonicalPathKey(p) === canonicalPathKey(target));
}

function launcherArgs(panDir) {
  const source = readFileSync(path.join(panDir, 'launch.mjs'), 'utf8');
  return launcherSourceArgs(source);
}

function launcherSourceArgs(source) {
  const match = /^const copilotArgs = (.+);$/m.exec(source);
  assert.ok(match, 'generated launcher must bake the Copilot argument list');
  return JSON.parse(match[1]);
}

function issueGraphqlPage({
  number,
  title,
  body,
  comments,
  hasNextPage = false,
  endCursor = null,
}) {
  return JSON.stringify({
    data: {
      repository: {
        issue: {
          number,
          title,
          body,
          url: `https://github.com/example/domain/issues/${number}`,
          comments: {
            pageInfo: { hasNextPage, endCursor },
            nodes: comments.map((comment) => ({
              author: comment.author == null ? null : { login: comment.author },
              createdAt: comment.timestamp,
              url: comment.url,
              body: comment.body,
            })),
          },
        },
      },
    },
  });
}

test('fixed workingDirectory: no .pan under the repo, state under workspaceRoot, terminal CWD is the repo', async () => {
  const sb = makeSandbox();
  try {
    const repoDir = path.join(sb.dir, 'repo');
    mkdirSync(repoDir, { recursive: true });
    writeFileSync(path.join(repoDir, 'README.md'), 'repo sentinel');
    const { runner, spawned, writes } = makeLaunchRunner(sb, fixedPlaybook(repoDir), { domainPan: 'DOMAIN PAN' });

    await runner.launchWorker(item({ number: 7 }), 'fixed');

    // The repository must never gain a `.pan/`, and its contents are untouched.
    assert.equal(existsSync(path.join(repoDir, '.pan')), false);
    assert.equal(readFileSync(path.join(repoDir, 'README.md'), 'utf8'), 'repo sentinel');

    const w = runner.active.get('item-1');
    assert.ok(w);
    assert.equal(w.isolated, false);
    assert.equal(canonicalPathKey(w.workingDir), canonicalPathKey(repoDir));

    // Every Pan file lives under the per-session state root in workspaceRoot.
    const stateRoot = stateRootFor(sb, 7, w.sessionId);
    const panDir = path.join(stateRoot, '.pan');
    assert.equal(canonicalPathKey(w.panDir), canonicalPathKey(panDir));
    for (const f of ['task.json', 'playbook.md', 'launch.json', 'launch.mjs', 'launch-prompt.txt', 'pan.md']) {
      assert.ok(existsSync(path.join(panDir, f)), `expected ${f} in the state dir`);
    }
    assert.equal(readFileSync(path.join(panDir, 'playbook.md'), 'utf8'), 'FIXED BODY');
    const firstLaunchArgs = launcherArgs(panDir);
    assert.deepEqual(firstLaunchArgs.slice(-2), ['--session-id', w.sessionId]);

    // Runner-owned metadata records the real working directory for rehydration.
    const launch = JSON.parse(readFileSync(path.join(panDir, 'launch.json'), 'utf8'));
    assert.equal(canonicalPathKey(launch.workingDir), canonicalPathKey(repoDir));
    assert.equal(launch.isolated, false);
    assert.equal(launch.slot, null);

    // The terminal is opened with CWD = repo and the absolute state dir.
    assert.equal(spawned.length, 1);
    assert.equal(canonicalPathKey(spawned[0].workingDir), canonicalPathKey(repoDir));
    assert.equal(canonicalPathKey(spawned[0].panDir), canonicalPathKey(panDir));
    assert.match(spawned[0].title, /#7/);

    // The session id was recorded on the Issue for resumability.
    assert.ok(writes.some((wr) => wr.field === FIELD.sessionId && wr.value === w.sessionId));

    // Both the repo and the out-of-tree state dir are pre-trusted for the worker.
    const trusted = trustedFolders(sb);
    assert.ok(includesPath(trusted, repoDir));
    assert.ok(includesPath(trusted, stateRoot));
  } finally {
    sb.cleanup();
  }
});

test('first ready launch records a session and ready follow-up reuses it with refreshed Issue context', async () => {
  const sb = makeSandbox();
  try {
    const repoDir = path.join(sb.dir, 'repo');
    mkdirSync(repoDir, { recursive: true });
    const graphqlResponses = [
      issueGraphqlPage({
        number: 121,
        title: 'Initial live title',
        body: 'Initial live body',
        comments: [
          { author: 'reviewer', timestamp: '2026-01-02T00:00:00Z', url: 'https://github.com/example/domain/issues/121#issuecomment-2', body: 'Second chronologically' },
        ],
        hasNextPage: true,
        endCursor: 'initial-next',
      }),
      issueGraphqlPage({
        number: 121,
        title: 'Initial live title',
        body: 'Initial live body',
        comments: [
          { author: 'worker', timestamp: '2026-01-01T00:00:00Z', url: 'https://github.com/example/domain/issues/121#issuecomment-1', body: 'First chronologically' },
        ],
      }),
      issueGraphqlPage({
        number: 121,
        title: 'Updated live title',
        body: 'Updated live body with feedback',
        comments: [
          { author: 'reviewer', timestamp: '2026-01-03T00:00:00Z', url: 'https://github.com/example/domain/issues/121#issuecomment-3', body: 'Please validate interactively' },
          { author: 'worker', timestamp: '2026-01-01T00:00:00Z', url: 'https://github.com/example/domain/issues/121#issuecomment-1', body: 'First chronologically' },
        ],
        hasNextPage: true,
        endCursor: 'updated-next',
      }),
      issueGraphqlPage({
        number: 121,
        title: 'Updated live title',
        body: 'Updated live body with feedback',
        comments: [
          { author: 'reviewer', timestamp: '2026-01-02T00:00:00Z', url: 'https://github.com/example/domain/issues/121#issuecomment-2', body: 'Second chronologically' },
        ],
      }),
    ];
    const graphqlCalls = [];
    const { runner, writes, issueReads } = makeLaunchRunner(sb, fixedPlaybook(repoDir), {
      issueReader: async (issue) => readIssue(issue, async (args) => {
        graphqlCalls.push(args);
        const response = graphqlResponses.shift();
        assert.ok(response, 'unexpected extra GraphQL page read');
        return response;
      }),
    });
    const first = item({ itemId: 'item-121', number: 121, status: 'ready' });

    await runner.launchWorker(first, 'fixed');

    const firstWorker = runner.active.get('item-121');
    const sessionId = firstWorker.sessionId;
    const panDir = firstWorker.panDir;
    const firstTask = JSON.parse(readFileSync(path.join(panDir, 'task.json'), 'utf8'));
    assert.equal(firstTask.body, 'Initial live body');
    assert.deepEqual(firstTask.comments.map((comment) => comment.body), [
      'First chronologically',
      'Second chronologically',
    ]);
    assert.deepEqual(launcherArgs(panDir).slice(-2), ['--session-id', sessionId]);

    const recordedAnswers = [{ question: 'Which environment?', answer: 'Production-like staging' }];
    writeFileSync(path.join(panDir, 'task.json'), JSON.stringify({ ...firstTask, answers: recordedAnswers }));
    runner.active.delete('item-121');

    const reviewed = item({
      itemId: 'item-121',
      number: 121,
      status: 'in-review',
      machine: MACHINE,
      sessionId,
      title: 'Stale Project title',
    });
    const followUp = structuredClone(reviewed);
    followUp.fields[FIELD.status] = 'ready';
    await runner.launchWorker(followUp, 'fixed');

    const resumed = runner.active.get('item-121');
    assert.equal(resumed.sessionId, sessionId);
    assert.equal(issueReads.length, 2, 'the live Issue is read on every launch');
    assert.equal(
      writes.filter((write) => write.field === FIELD.sessionId).length,
      1,
      'the existing Project session-id is never overwritten',
    );
    const refreshed = JSON.parse(readFileSync(path.join(panDir, 'task.json'), 'utf8'));
    assert.equal(refreshed.title, 'Updated live title');
    assert.equal(refreshed.body, 'Updated live body with feedback');
    assert.deepEqual(refreshed.answers, recordedAnswers);
    assert.deepEqual(refreshed.comments, [
      { author: 'worker', timestamp: '2026-01-01T00:00:00Z', url: 'https://github.com/example/domain/issues/121#issuecomment-1', body: 'First chronologically' },
      { author: 'reviewer', timestamp: '2026-01-02T00:00:00Z', url: 'https://github.com/example/domain/issues/121#issuecomment-2', body: 'Second chronologically' },
      { author: 'reviewer', timestamp: '2026-01-03T00:00:00Z', url: 'https://github.com/example/domain/issues/121#issuecomment-3', body: 'Please validate interactively' },
    ]);
    assert.deepEqual(
      graphqlCalls.map((args) => args.find((arg) => String(arg).startsWith('cursor=')) || null),
      [null, 'cursor=initial-next', null, 'cursor=updated-next'],
      'each launch must read every raw GraphQL comment page from a fresh cursor',
    );
    assert.deepEqual(launcherArgs(panDir).slice(-2), ['--session-id', sessionId]);
  } finally {
    sb.cleanup();
  }
});

test('ready claim rejects an incompatible recorded session before writing or spawning', async () => {
  const sb = makeSandbox();
  try {
    const repoDir = path.join(sb.dir, 'repo');
    mkdirSync(repoDir, { recursive: true });
    const { runner, writes, spawned } = makeLaunchRunner(sb, fixedPlaybook(repoDir));
    const candidate = item({ status: 'ready', machine: 'other-box', sessionId: randomUUID() });
    runner.deps.readItemById = async () => structuredClone(candidate);

    await assert.rejects(
      runner.claimAndLaunch(candidate),
      /recorded session belongs to a different machine/,
    );

    assert.deepEqual(writes, [], 'claim affinity and session-id must remain untouched');
    assert.equal(spawned.length, 0);
  } finally {
    sb.cleanup();
  }
});

test('paused launch still reuses its recorded session', async () => {
  const sb = makeSandbox();
  try {
    const repoDir = path.join(sb.dir, 'repo');
    mkdirSync(repoDir, { recursive: true });
    const { runner, writes } = makeLaunchRunner(sb, fixedPlaybook(repoDir));

    await runner.launchWorker(item({ itemId: 'item-22', number: 22 }), 'fixed');
    const sessionId = runner.active.get('item-22').sessionId;
    runner.active.delete('item-22');

    await runner.launchWorker(item({
      itemId: 'item-22',
      number: 22,
      status: 'paused',
      machine: MACHINE,
      sessionId,
    }), 'fixed');

    assert.equal(runner.active.get('item-22').sessionId, sessionId);
    assert.equal(writes.filter((write) => write.field === FIELD.sessionId).length, 1);
    assert.deepEqual(launcherArgs(runner.active.get('item-22').panDir).slice(-2), ['--session-id', sessionId]);
  } finally {
    sb.cleanup();
  }
});

test('workspace slot: no .pan under the slot repo, state under workspaceRoot, terminal CWD is the slot', async () => {
  const sb = makeSandbox();
  try {
    const slotDir = path.join(sb.dir, 'slot-primary');
    mkdirSync(slotDir, { recursive: true });
    writeFileSync(path.join(slotDir, 'README.md'), 'slot sentinel');
    const { runner, spawned } = makeLaunchRunner(sb, slotPlaybook(slotDir));

    await runner.launchWorker(item({ number: 8 }), 'pooled', 'primary');

    assert.equal(existsSync(path.join(slotDir, '.pan')), false);
    assert.equal(readFileSync(path.join(slotDir, 'README.md'), 'utf8'), 'slot sentinel');

    const w = runner.active.get('item-1');
    assert.equal(w.isolated, false);
    assert.equal(w.slot, 'primary');
    assert.equal(canonicalPathKey(w.workingDir), canonicalPathKey(slotDir));

    const panDir = path.join(stateRootFor(sb, 8, w.sessionId), '.pan');
    assert.equal(canonicalPathKey(w.panDir), canonicalPathKey(panDir));
    assert.ok(existsSync(path.join(panDir, 'task.json')));
    const launch = JSON.parse(readFileSync(path.join(panDir, 'launch.json'), 'utf8'));
    assert.equal(canonicalPathKey(launch.workingDir), canonicalPathKey(slotDir));
    assert.equal(launch.isolated, false);
    assert.equal(launch.slot, 'primary');

    assert.equal(canonicalPathKey(spawned[0].workingDir), canonicalPathKey(slotDir));
  } finally {
    sb.cleanup();
  }
});

test('isolated playbook: the session root is both the state dir and the worker workspace', async () => {
  const sb = makeSandbox();
  try {
    const { runner, spawned } = makeLaunchRunner(sb, isolatedPlaybook());

    await runner.launchWorker(item({ number: 5 }), 'isolated');

    const w = runner.active.get('item-1');
    const stateRoot = stateRootFor(sb, 5, w.sessionId);
    assert.equal(w.isolated, true);
    // The isolated worker's CWD is its own session root, so playbook conventions
    // that treat the launch directory as their workspace (e.g. a linked worktree
    // at <root>/repo) keep working exactly as before.
    assert.equal(canonicalPathKey(w.workingDir), canonicalPathKey(stateRoot));
    assert.equal(canonicalPathKey(spawned[0].workingDir), canonicalPathKey(stateRoot));

    const panDir = path.join(stateRoot, '.pan');
    assert.ok(existsSync(path.join(panDir, 'task.json')));
    const launch = JSON.parse(readFileSync(path.join(panDir, 'launch.json'), 'utf8'));
    assert.equal(launch.isolated, true);
    assert.equal(canonicalPathKey(launch.workingDir), canonicalPathKey(stateRoot));
  } finally {
    sb.cleanup();
  }
});

test('generated launcher addresses state files by absolute path and grants Copilot access to the state dir', async () => {
  const sb = makeSandbox();
  try {
    const repoDir = path.join(sb.dir, 'repo');
    mkdirSync(repoDir, { recursive: true });
    const { runner } = makeLaunchRunner(sb, fixedPlaybook(repoDir));

    await runner.launchWorker(item({ number: 9 }), 'fixed');
    const w = runner.active.get('item-1');
    const panDir = path.join(stateRootFor(sb, 9, w.sessionId), '.pan');
    const src = readFileSync(path.join(panDir, 'launch.mjs'), 'utf8');

    // The absolute state dir is baked in and every signal file is addressed
    // under it; no relative `.pan/...` path survives that would resolve inside
    // the repository CWD.
    assert.ok(src.includes(`const panDir = ${JSON.stringify(panDir)};`));
    assert.ok(src.includes("join(panDir, 'worker.running')"));
    assert.ok(src.includes("join(panDir, 'worker.stop')"));
    assert.ok(src.includes("join(panDir, 'worker.pid')"));
    assert.ok(src.includes("join(panDir, 'launch-prompt.txt')"));
    assert.doesNotMatch(src, /'\.pan\/worker\.running'/);
    assert.doesNotMatch(src, /'\.pan\/launch-prompt\.txt'/);

    // Copilot is granted file access to the out-of-tree state dir via --add-dir.
    assert.ok(src.includes('--add-dir'));
    assert.ok(src.includes(JSON.stringify(panDir)));

    // Stable env handles so the worker can name its state / working directory.
    assert.ok(src.includes('PAN_STATE_DIR'));
    assert.ok(src.includes('PAN_WORKING_DIRECTORY'));
  } finally {
    sb.cleanup();
  }
});

// ---- Rehydration / cleanup safety --------------------------------------------

// A Runner whose Project reads are stubbed, for driving rehydrate() offline.
function makeRehydrateRunner(sb, items, playbooks = new Map()) {
  const deps = {
    readAllItems: async () => items,
    readItemById: async (id) => items.find((i) => i.itemId === id) || null,
    setTextField: async () => {},
    setSelectField: async () => {},
    readDomainFile: async () => { throw new Error('no Domain pan.md'); },
  };
  return new Runner(baseCfg(sb), { fields: new Map() }, playbooks, deps);
}

// A slot-pooled playbook whose named slots map to the given directories.
function pooledPlaybook(slots) {
  return new Map([['pooled', {
    name: 'pooled', description: 'x', workingDirectory: null,
    slots: Object.entries(slots).map(([id, dir]) => ({ id, dir })), capacity: slots.length || 2, body: 'POOLED',
  }]]);
}

// Like makeRehydrateRunner but records every Project write and reflects it back
// into the in-memory items, so a test can assert what rehydrate committed (e.g. a
// restored claim) and a subsequent read observes it.
function makeRehydrateRunnerRW(sb, items) {
  const writes = [];
  const byId = new Map(items.map((i) => [i.itemId, i]));
  const deps = {
    readAllItems: async () => items,
    readItemById: async (id) => byId.get(id) || null,
    setTextField: async (_cfg, _meta, id, field, value) => {
      writes.push({ id, field, value: value ?? '' });
      if (byId.has(id)) byId.get(id).fields[field] = value ?? '';
    },
    setSelectField: async (_cfg, _meta, id, field, value) => {
      writes.push({ id, field, value });
      if (byId.has(id)) byId.get(id).fields[field] = value;
    },
    readDomainFile: async () => { throw new Error('no Domain pan.md'); },
  };
  const runner = new Runner(baseCfg(sb), { fields: new Map() }, new Map(), deps);
  return { runner, writes };
}
// `owned` controls whether the runner-ownership marker is written into
// launch.json (machine + task identity); an unowned/legacy root is one that
// carries no valid marker. `sessionId` defaults to a real minted UUID (the only
// shape rehydrate treats as a canonical root) and is returned so the caller can
// bind the matching Project item's session-id to it.
function seedStateRoot(sb, { number, sessionId = randomUUID(), itemId, workingDir, isolated, alive, result = null, owned = true, machine = MACHINE, markerSessionId = sessionId, slot = null, playbook = 'fixed' }) {
  const stateRoot = stateRootFor(sb, number, sessionId);
  const panDir = path.join(stateRoot, '.pan');
  mkdirSync(panDir, { recursive: true });
  const task = {
    itemId,
    number,
    title: `Task ${number}`,
    url: `https://github.com/example/domain/issues/${number}`,
    repo: 'example/domain',
    playbook,
  };
  writeFileSync(path.join(panDir, 'task.json'), JSON.stringify(task));
  const launch = owned
    ? { panRunner: true, version: 1, machine, identity: IDENTITY, itemId, number, sessionId: markerSessionId, isolated, workingDir, slot }
    : { sessionId: markerSessionId, isolated, workingDir, slot };
  writeFileSync(path.join(panDir, 'launch.json'), JSON.stringify(launch));
  if (alive) {
    writeFileSync(path.join(panDir, 'worker.running'), '');
    writeFileSync(path.join(panDir, 'worker.pid'), String(process.pid));
  }
  if (result != null) {
    writeFileSync(path.join(panDir, 'result.json'), JSON.stringify(result));
  }
  return { stateRoot, panDir, sessionId };
}

function projectItem({ itemId, number, status, machine, sessionId, claimedBy = '', leaseUntil = '' }) {
  return {
    itemId,
    issue: {
      number,
      title: `Task ${number}`,
      body: '',
      url: `https://github.com/example/domain/issues/${number}`,
      repo: 'example/domain',
    },
    fields: {
      [FIELD.status]: status,
      [FIELD.machine]: machine,
      [FIELD.sessionId]: sessionId,
      [FIELD.claimedBy]: claimedBy,
      [FIELD.leaseUntil]: leaseUntil,
      [FIELD.needsHumanSince]: '',
    },
  };
}

test('rehydrate prunes an inert state root but never the fixed/slot repository', async () => {
  const sb = makeSandbox();
  try {
    const repoDir = path.join(sb.dir, 'repo');
    mkdirSync(repoDir, { recursive: true });
    writeFileSync(path.join(repoDir, 'README.md'), 'repo sentinel');
    const { stateRoot } = seedStateRoot(sb, { number: 1, itemId: 'item-1', workingDir: repoDir, isolated: false, alive: false });

    // The task is gone from the Project and no worker is alive → inert.
    const runner = makeRehydrateRunner(sb, []);
    await runner.rehydrate();

    assert.equal(existsSync(stateRoot), false, 'the inert state root should be pruned');
    assert.equal(existsSync(repoDir), true, 'the repository must never be pruned');
    assert.equal(readFileSync(path.join(repoDir, 'README.md'), 'utf8'), 'repo sentinel');
  } finally {
    sb.cleanup();
  }
});

test('rehydrate preserves a paused slot-pooled state root and its repository', async () => {
  const sb = makeSandbox();
  try {
    const repoDir = path.join(sb.dir, 'repo');
    mkdirSync(repoDir, { recursive: true });
    const { stateRoot, sessionId } = seedStateRoot(sb, { number: 2, itemId: 'item-2', workingDir: repoDir, isolated: false, alive: false });

    // Paused, pinned to this machine via a composite `<machine>::<slot>` affinity.
    const paused = projectItem({ itemId: 'item-2', number: 2, status: 'paused', machine: MACHINE, sessionId });
    const runner = makeRehydrateRunner(sb, [paused]);
    await runner.rehydrate();

    assert.equal(existsSync(stateRoot), true, 'a paused state root must be preserved for resume');
    assert.equal(existsSync(repoDir), true);
    assert.equal(runner.active.has('item-2'), false, 'a paused task is not adopted as active');
    // Fixed/slot resume re-derives its working directory, so it is not indexed
    // as a resumable isolated workspace.
    assert.equal(runner.resumeWorkspaces.has('item-2'), false);
  } finally {
    sb.cleanup();
  }
});

test('rehydrate preserves an in-review isolated workspace for a future ready follow-up', async () => {
  const sb = makeSandbox();
  try {
    const { stateRoot, sessionId } = seedStateRoot(sb, {
      number: 12,
      itemId: 'item-12',
      workingDir: null,
      isolated: true,
      alive: false,
      playbook: 'isolated',
    });
    const inReview = projectItem({
      itemId: 'item-12',
      number: 12,
      status: 'in-review',
      machine: MACHINE,
      sessionId,
    });
    const runner = makeRehydrateRunner(sb, [inReview], isolatedPlaybook());

    await runner.rehydrate();

    assert.equal(existsSync(stateRoot), true);
    assert.equal(runner.resumeWorkspaces.get('item-12'), stateRoot);
    assert.equal(runner.active.has('item-12'), false);
  } finally {
    sb.cleanup();
  }
});

test('rehydrate adopts a live fixed/slot worker against its repository working directory', async () => {
  const sb = makeSandbox();
  try {
    const repoDir = path.join(sb.dir, 'repo');
    mkdirSync(repoDir, { recursive: true });
    const { stateRoot, sessionId } = seedStateRoot(sb, { number: 3, itemId: 'item-3', workingDir: repoDir, isolated: false, alive: true });

    const inProgress = projectItem({
      itemId: 'item-3', number: 3, status: 'in-progress', machine: MACHINE,
      sessionId, claimedBy: IDENTITY, leaseUntil: VALID_LEASE,
    });
    const runner = makeRehydrateRunner(sb, [inProgress]);
    await runner.rehydrate();

    const w = runner.active.get('item-3');
    assert.ok(w, 'a live fixed/slot worker should now be re-adopted for supervision');
    assert.equal(w.isolated, false);
    assert.notEqual(w.occupancyOnly, true);
    assert.equal(canonicalPathKey(w.workingDir), canonicalPathKey(repoDir));
    assert.equal(existsSync(stateRoot), true);
    assert.equal(existsSync(repoDir), true);
  } finally {
    sb.cleanup();
  }
});

test('rehydrate treats a legacy state root without launch.json as isolated', async () => {
  const sb = makeSandbox();
  try {
    // A pre-separation isolated workspace: task.json but no launch.json, and its
    // work lived in the root itself. Its name is still a canonical minted UUID
    // (real runners always minted one) — only the marker is absent.
    const sessionId = randomUUID();
    const stateRoot = stateRootFor(sb, 4, sessionId);
    const panDir = path.join(stateRoot, '.pan');
    mkdirSync(panDir, { recursive: true });
    writeFileSync(path.join(panDir, 'task.json'), JSON.stringify({
      itemId: 'item-4', number: 4, title: 'Task 4',
      url: 'https://github.com/example/domain/issues/4', repo: 'example/domain', playbook: 'isolated',
    }));

    const paused = projectItem({ itemId: 'item-4', number: 4, status: 'paused', machine: MACHINE, sessionId });
    const runner = makeRehydrateRunner(sb, [paused]);
    await runner.rehydrate();

    assert.equal(existsSync(stateRoot), true);
    // A legacy isolated workspace is indexed for resume by its root directory.
    assert.equal(canonicalPathKey(runner.resumeWorkspaces.get('item-4')), canonicalPathKey(stateRoot));
  } finally {
    sb.cleanup();
  }
});

test('rehydrate never scans or prunes a non-session-root directory under workspaceRoot', async () => {
  const sb = makeSandbox();
  try {
    // A checkout a user placed directly under workspaceRoot, still carrying a
    // legacy `.pan/` from before state separation. Its name does not match the
    // runner's `pan-<number>-<minted UUID>` scheme, so rehydrate must ignore it —
    // never adopt it, and above all never prune (delete) it.
    const repoLike = path.join(sb.workspaceRoot, 'meetingstage');
    const panDir = path.join(repoLike, '.pan');
    mkdirSync(panDir, { recursive: true });
    writeFileSync(path.join(repoLike, 'source.c'), 'int main(){}');
    writeFileSync(path.join(panDir, 'task.json'), JSON.stringify({
      itemId: 'item-9', number: 9, title: 'Task 9',
      url: 'https://github.com/example/domain/issues/9', repo: 'example/domain', playbook: 'fixed',
    }));
    writeFileSync(path.join(panDir, 'launch.json'), JSON.stringify({ sessionId: 'x', isolated: true, workingDir: repoLike, slot: null }));

    // Empty Project → the task looks inert, which for a real session root would
    // prune it. The name guard must keep this checkout untouched.
    const runner = makeRehydrateRunner(sb, []);
    await runner.rehydrate();

    assert.equal(existsSync(repoLike), true, 'a non-session-root checkout must never be pruned');
    assert.equal(readFileSync(path.join(repoLike, 'source.c'), 'utf8'), 'int main(){}');
  } finally {
    sb.cleanup();
  }
});

test('launchWorker refuses a resumed session-id that is not the exact minted UUID', async () => {
  const sb = makeSandbox();
  try {
    const repoDir = path.join(sb.dir, 'repo');
    mkdirSync(repoDir, { recursive: true });
    const { runner } = makeLaunchRunner(sb, fixedPlaybook(repoDir));

    // A tampered `session-id` full of `..`/separator segments. It is rejected on
    // its shape — before it is ever interpolated into a directory name — so it
    // can neither climb out of the workspace nor alias another session's root.
    const escapingId = Array(8).fill('..').join(path.sep) + path.sep + 'evil';
    await assert.rejects(
      runner.launchWorker(item({ status: 'paused', machine: MACHINE, sessionId: escapingId }), 'fixed'),
      /not a valid Pan session id/,
    );

    // It failed closed before creating any state directory.
    assert.equal(runner.active.size, 0);
    assert.deepEqual(readdirSync(sb.workspaceRoot), []);
  } finally {
    sb.cleanup();
  }
});

test('launchWorker refuses to resume onto a state root with an invalid/foreign marker', async () => {
  const sb = makeSandbox();
  try {
    const repoDir = path.join(sb.dir, 'repo');
    mkdirSync(repoDir, { recursive: true });
    const { runner } = makeLaunchRunner(sb, fixedPlaybook(repoDir));

    // The derived state root already exists but its (otherwise complete) marker
    // names a DIFFERENT task — the resume must not write over another session's
    // root, so it fails closed on the invalid marker.
    const sessionId = randomUUID();
    const panDir = path.join(stateRootFor(sb, 12, sessionId), '.pan');
    mkdirSync(panDir, { recursive: true });
    writeFileSync(path.join(panDir, 'launch.json'), JSON.stringify({
      panRunner: true, version: 1, machine: MACHINE, identity: IDENTITY,
      itemId: 'someone-else', number: 12, sessionId, isolated: false, workingDir: repoDir, slot: null,
    }));

    await assert.rejects(
      runner.launchWorker(item({ itemId: 'item-12', number: 12, status: 'paused', machine: MACHINE, sessionId }), 'fixed'),
      /invalid\/foreign marker/,
    );
  } finally {
    sb.cleanup();
  }
});

test('launchWorker refuses to resume when an unprocessed result.json is present', async () => {
  const sb = makeSandbox();
  try {
    const repoDir = path.join(sb.dir, 'repo');
    mkdirSync(repoDir, { recursive: true });
    const { runner } = makeLaunchRunner(sb, fixedPlaybook(repoDir));

    // The resumed root still carries a finished worker's result. Clearing it (as
    // the stale-signal cleanup would) loses the outcome, so the resume fails
    // closed and the result is preserved for the next rehydrate to finalize.
    const sessionId = randomUUID();
    const panDir = path.join(stateRootFor(sb, 31, sessionId), '.pan');
    mkdirSync(panDir, { recursive: true });
    writeFileSync(path.join(panDir, 'launch.json'), JSON.stringify({
      panRunner: true, version: 1, machine: MACHINE, identity: IDENTITY,
      itemId: 'item-31', number: 31, sessionId, isolated: false, workingDir: repoDir, slot: null,
    }));
    writeFileSync(path.join(panDir, 'result.json'), JSON.stringify({ outcome: 'done', summary: 'done' }));

    await assert.rejects(
      runner.launchWorker(item({ itemId: 'item-31', number: 31, status: 'paused', machine: MACHINE, sessionId }), 'fixed'),
      /unprocessed result\.json/,
    );
    assert.equal(existsSync(path.join(panDir, 'result.json')), true, 'the result must be preserved, not cleared');
  } finally {
    sb.cleanup();
  }
});

test('launchWorker refuses when the session state root would fall inside the working directory', async () => {
  const sb = makeSandbox();
  try {
    const repoDir = path.join(sb.dir, 'repo');
    mkdirSync(repoDir, { recursive: true });
    writeFileSync(path.join(repoDir, 'README.md'), 'repo sentinel');
    // Misconfiguration: workspaceRoot lives *inside* the fixed checkout, so the
    // session state root (and its .pan/) would land in the repository.
    const badWorkspaceRoot = path.join(repoDir, 'pan-state');
    mkdirSync(badWorkspaceRoot, { recursive: true });

    const deps = {
      readAllItems: async () => [], readItemById: async () => null,
      setTextField: async () => {}, setSelectField: async () => {},
      readDomainFile: async () => { throw new Error('none'); },
    };
    const runner = new Runner(baseCfg(sb, { workspaceRoot: badWorkspaceRoot }), { fields: new Map() }, fixedPlaybook(repoDir), deps);
    runner.spawnTerminal = async () => {};

    await assert.rejects(
      runner.launchWorker(item({ number: 13 }), 'fixed'),
      /overlaps the working directory/,
    );
    assert.equal(runner.active.size, 0);
    // The repository was never given a `.pan/`.
    assert.equal(existsSync(path.join(repoDir, '.pan')), false);
  } finally {
    sb.cleanup();
  }
});

test('loadConfig resolves a relative workspaceRoot to an absolute path', async () => {
  const sb = makeSandbox();
  try {
    const cfgPath = path.join(sb.dir, 'config.json');
    writeFileSync(cfgPath, JSON.stringify({
      domainRepo: 'owner/domain', project: 'owner/7', machine: 'box', identity: 'box-1',
      panCheckout: sb.dir, terminal: { kind: 'windows-terminal' },
      workspaceRoot: path.join('relative', 'ws'),
    }));

    const cfg = await loadConfig(cfgPath);
    assert.equal(path.isAbsolute(cfg.workspaceRoot), true, 'a relative workspaceRoot must be resolved absolute');
    assert.equal(cfg.workspaceRoot, path.resolve(path.join('relative', 'ws')));
  } finally {
    sb.cleanup();
  }
});

test('rehydrate never prunes a matching-name state root without a valid ownership marker', async () => {
  const sb = makeSandbox();
  try {
    const repoDir = path.join(sb.dir, 'repo');
    mkdirSync(repoDir, { recursive: true });
    writeFileSync(path.join(repoDir, 'README.md'), 'repo sentinel');

    // A canonically-named root carrying a `.pan/task.json` but NO runner
    // ownership marker (a user-copied or pre-marker legacy root).
    const { stateRoot: unmarked } = seedStateRoot(sb, {
      number: 41, itemId: 'item-41', workingDir: repoDir, isolated: false, alive: false, owned: false,
    });
    // And one whose marker names a DIFFERENT machine — also not ours to delete.
    const { stateRoot: foreignMachine } = seedStateRoot(sb, {
      number: 42, itemId: 'item-42', workingDir: repoDir, isolated: false, alive: false, machine: 'other-box',
    });

    // Empty Project → both look inert. A properly owned inert root would be
    // pruned (see the prune test above); these must not be.
    const runner = makeRehydrateRunner(sb, []);
    await runner.rehydrate();

    assert.equal(existsSync(unmarked), true, 'an unmarked/legacy root must never be pruned');
    assert.equal(existsSync(foreignMachine), true, 'a root marked for another machine must never be pruned');
    assert.equal(existsSync(repoDir), true);
  } finally {
    sb.cleanup();
  }
});

test('rehydrate keeps a live worker whose item was passively swept to paused, restoring its claim', async () => {
  const sb = makeSandbox();
  try {
    const repoDir = path.join(sb.dir, 'repo');
    mkdirSync(repoDir, { recursive: true });
    const { stateRoot, sessionId } = seedStateRoot(sb, {
      number: 20, itemId: 'item-20', workingDir: repoDir, isolated: false, alive: true,
    });
    // A passive lease sweep flipped it to paused, leaving our claim intact and
    // the lease expired/missing — the exact restorable state.
    const swept = projectItem({
      itemId: 'item-20', number: 20, status: 'paused', machine: MACHINE,
      sessionId, claimedBy: IDENTITY, leaseUntil: '',
    });
    const { runner, writes } = makeRehydrateRunnerRW(sb, [swept]);
    await runner.rehydrate();

    // The live worker is adopted so its fixed directory stays occupied and no
    // duplicate worker can be launched into it.
    const w = runner.active.get('item-20');
    assert.ok(w, 'a live worker swept to paused must be re-adopted, not dropped');
    assert.notEqual(w.occupancyOnly, true);
    assert.equal(canonicalPathKey(w.workingDir), canonicalPathKey(repoDir));
    // Its claim is restored to in-progress, with a confirming re-read, so
    // supervision keeps it and it leaves the resume-candidate pool.
    assert.ok(writes.some((x) => x.id === 'item-20' && x.field === FIELD.status && x.value === 'in-progress'));
    assert.ok(writes.some((x) => x.id === 'item-20' && x.field === FIELD.claimedBy && x.value === IDENTITY));
    assert.equal(existsSync(stateRoot), true);
    assert.equal(existsSync(repoDir), true);
  } finally {
    sb.cleanup();
  }
});

test('rehydrate reserves (not adopts) a live worker on a paused UNCLAIMED item', async () => {
  const sb = makeSandbox();
  try {
    const repoDir = path.join(sb.dir, 'repo');
    mkdirSync(repoDir, { recursive: true });
    const { sessionId } = seedStateRoot(sb, {
      number: 21, itemId: 'item-21', workingDir: repoDir, isolated: false, alive: true,
    });
    // Unclaimed paused is an ambiguous/manual pause, NOT a passive sweep, so we
    // must not restore/steal it — only reserve its directory.
    const paused = projectItem({
      itemId: 'item-21', number: 21, status: 'paused', machine: MACHINE,
      sessionId, claimedBy: '', leaseUntil: '',
    });
    const { runner, writes } = makeRehydrateRunnerRW(sb, [paused]);
    await runner.rehydrate();

    const w = runner.active.get('item-21');
    assert.ok(w, 'the live worker keeps its directory reserved');
    assert.equal(w.occupancyOnly, true, 'an unclaimed manual pause is reserved, not adopted');
    assert.equal(writes.length, 0, 'we must not write any field of an unclaimed paused item');
  } finally {
    sb.cleanup();
  }
});

test('rehydrate reserves a live worker claimed by another identity without stealing it', async () => {
  const sb = makeSandbox();
  try {
    const repoDir = path.join(sb.dir, 'repo');
    mkdirSync(repoDir, { recursive: true });
    const { sessionId } = seedStateRoot(sb, {
      number: 22, itemId: 'item-22', workingDir: repoDir, isolated: false, alive: true,
    });
    const foreign = projectItem({
      itemId: 'item-22', number: 22, status: 'in-progress', machine: MACHINE,
      sessionId, claimedBy: 'other-runner', leaseUntil: VALID_LEASE,
    });
    const { runner, writes } = makeRehydrateRunnerRW(sb, [foreign]);
    await runner.rehydrate();

    // Its directory is reserved (so no duplicate launch) but it is not stolen.
    const w = runner.active.get('item-22');
    assert.ok(w, 'a live foreign-claimed worker must still reserve its directory');
    assert.equal(w.occupancyOnly, true);
    assert.equal(writes.length, 0, 'we must not write any field of a foreign-claimed item');
  } finally {
    sb.cleanup();
  }
});

test('rehydrate reserves a live worker when the item transitions out from under the restore', async () => {
  const sb = makeSandbox();
  try {
    const repoDir = path.join(sb.dir, 'repo');
    mkdirSync(repoDir, { recursive: true });
    const { sessionId } = seedStateRoot(sb, {
      number: 23, itemId: 'item-23', workingDir: repoDir, isolated: false, alive: true,
    });
    // The startup snapshot looks like a restorable passive sweep...
    const snapshot = projectItem({
      itemId: 'item-23', number: 23, status: 'paused', machine: MACHINE,
      sessionId, claimedBy: IDENTITY, leaseUntil: '',
    });
    // ...but the immediate re-read shows another runner has since claimed it.
    const afterRace = projectItem({
      itemId: 'item-23', number: 23, status: 'in-progress', machine: MACHINE,
      sessionId, claimedBy: 'other-runner', leaseUntil: VALID_LEASE,
    });
    const writes = [];
    const deps = {
      readAllItems: async () => [snapshot],
      readItemById: async () => afterRace, // fresh truth differs from the snapshot
      setTextField: async (_c, _m, id, field, value) => { writes.push({ id, field, value }); },
      setSelectField: async (_c, _m, id, field, value) => { writes.push({ id, field, value }); },
      readDomainFile: async () => { throw new Error('no Domain pan.md'); },
    };
    const runner = new Runner(baseCfg(sb), { fields: new Map() }, new Map(), deps);
    await runner.rehydrate();

    const w = runner.active.get('item-23');
    assert.ok(w, 'the live worker still reserves its directory');
    assert.equal(w.occupancyOnly, true, 'a concurrent foreign claim must not be overwritten');
    assert.equal(writes.length, 0, 'we must not write over the newer Project state');
  } finally {
    sb.cleanup();
  }
});

test('rehydrate reserves a live worker when the restore cannot be confirmed', async () => {
  const sb = makeSandbox();
  try {
    const repoDir = path.join(sb.dir, 'repo');
    mkdirSync(repoDir, { recursive: true });
    const { sessionId } = seedStateRoot(sb, {
      number: 24, itemId: 'item-24', workingDir: repoDir, isolated: false, alive: true,
    });
    const swept = projectItem({
      itemId: 'item-24', number: 24, status: 'paused', machine: MACHINE,
      sessionId, claimedBy: IDENTITY, leaseUntil: '',
    });
    // Writes are accepted but never reflected (a partial write / lost update):
    // the confirming re-read keeps returning the original paused snapshot, so the
    // restore cannot be confirmed and the worker must fall back to reservation.
    const writes = [];
    const deps = {
      readAllItems: async () => [swept],
      readItemById: async () => swept, // never reflects the writes
      setTextField: async (_c, _m, id, field, value) => { writes.push({ id, field, value }); },
      setSelectField: async (_c, _m, id, field, value) => { writes.push({ id, field, value }); },
      readDomainFile: async () => { throw new Error('no Domain pan.md'); },
    };
    const runner = new Runner(baseCfg(sb), { fields: new Map() }, new Map(), deps);
    await runner.rehydrate();

    const w = runner.active.get('item-24');
    assert.ok(w, 'the live worker still reserves its directory');
    assert.equal(w.occupancyOnly, true, 'an unconfirmed restore must not adopt');
  } finally {
    sb.cleanup();
  }
});

test('rehydrate finalizes a pending result on a passively-swept paused item before preserving it', async () => {
  for (const alive of [false, true]) {
    const sb = makeSandbox();
    try {
      const repoDir = path.join(sb.dir, 'repo');
      mkdirSync(repoDir, { recursive: true });
      const num = alive ? 31 : 30;
      const { sessionId } = seedStateRoot(sb, {
        number: num, itemId: `item-${num}`, workingDir: repoDir,
        isolated: false, alive, result: { outcome: 'done', summary: 'done' },
      });
      // Passive sweep to paused: our claim retained AND the lease expired/missing
      // → still ours to finalize.
      const swept = projectItem({
        itemId: `item-${num}`, number: num, status: 'paused', machine: MACHINE,
        sessionId, claimedBy: IDENTITY, leaseUntil: '',
      });
      const runner = makeRehydrateRunner(sb, [swept]);
      const calls = [];
      runner.finalize = async (w, resultPath) => {
        calls.push({ itemId: w.itemId, resultPath, swept: w.finalizeFromPausedSweep });
        return true;
      };
      await runner.rehydrate();

      assert.equal(calls.length, 1, `alive=${alive}: the pending result must be finalized, not stranded as paused`);
      assert.equal(calls[0].itemId, `item-${num}`);
      assert.equal(calls[0].swept, true, 'it is recognized as a passive-sweep finalization');
      // It is never merely indexed for a resume that would later clear the result.
      assert.equal(runner.resumeWorkspaces.has(`item-${num}`), false);
    } finally {
      sb.cleanup();
    }
  }
});

test('rehydrate does NOT finalize a pending result on an UNCLAIMED (manual) paused item', async () => {
  const sb = makeSandbox();
  try {
    const repoDir = path.join(sb.dir, 'repo');
    mkdirSync(repoDir, { recursive: true });
    const { panDir, sessionId } = seedStateRoot(sb, {
      number: 33, itemId: 'item-33', workingDir: repoDir,
      isolated: false, alive: false, result: { outcome: 'done', summary: 'done' },
    });
    // Unclaimed paused = a manual/ambiguous pause, never a passive sweep.
    const manual = projectItem({
      itemId: 'item-33', number: 33, status: 'paused', machine: MACHINE,
      sessionId, claimedBy: '', leaseUntil: '',
    });
    const runner = makeRehydrateRunner(sb, [manual]);
    let finalized = false;
    runner.finalize = async () => { finalized = true; return true; };
    await runner.rehydrate();

    assert.equal(finalized, false, 'an unclaimed paused item must not be finalized');
    assert.equal(existsSync(path.join(panDir, 'result.json')), true, 'its result is preserved untouched');
  } finally {
    sb.cleanup();
  }
});

test('rehydrate does NOT finalize a result whose session no longer binds to the Project item', async () => {
  const sb = makeSandbox();
  try {
    const repoDir = path.join(sb.dir, 'repo');
    mkdirSync(repoDir, { recursive: true });
    // A stale session-A root (with a finished result) for item-50.
    const { panDir, stateRoot } = seedStateRoot(sb, {
      number: 50, itemId: 'item-50', workingDir: repoDir,
      isolated: false, alive: false, result: { outcome: 'done', summary: 'session A' },
    });
    // The live Project item is on a DIFFERENT (current) session B, claimed by us.
    const itemOnSessionB = projectItem({
      itemId: 'item-50', number: 50, status: 'in-progress', machine: MACHINE,
      sessionId: randomUUID(), claimedBy: IDENTITY, leaseUntil: VALID_LEASE,
    });
    const runner = makeRehydrateRunner(sb, [itemOnSessionB]);
    let finalized = false;
    runner.finalize = async () => { finalized = true; return true; };
    await runner.rehydrate();

    assert.equal(finalized, false, 'session A must never finalize the item now on session B');
    assert.equal(existsSync(path.join(panDir, 'result.json')), true, 'session A result is preserved, not consumed');
    assert.equal(existsSync(stateRoot), true, 'and its stale root is not deleted while it holds a result');
  } finally {
    sb.cleanup();
  }
});

test('rehydrate: a stale result root that sorts first never finalizes the current session', async () => {
  const sb = makeSandbox();
  try {
    const repoDir = path.join(sb.dir, 'repo');
    mkdirSync(repoDir, { recursive: true });
    // Two roots for the SAME item: a stale session-A root that HAS a result
    // (so it sorts ahead on the `hasResult` key) and the current session-B root
    // with no result. The Project item is on session B.
    const { panDir: panA, stateRoot: rootA } = seedStateRoot(sb, {
      number: 52, itemId: 'item-52', workingDir: repoDir,
      isolated: false, alive: false, result: { outcome: 'done', summary: 'stale A' },
    });
    const { sessionId: sidB } = seedStateRoot(sb, {
      number: 52, itemId: 'item-52', workingDir: repoDir, isolated: false, alive: false,
    });
    const itemOnB = projectItem({
      itemId: 'item-52', number: 52, status: 'paused', machine: MACHINE,
      sessionId: sidB, claimedBy: IDENTITY, leaseUntil: '',
    });
    const runner = makeRehydrateRunner(sb, [itemOnB]);
    let finalized = false;
    runner.finalize = async () => { finalized = true; return true; };
    await runner.rehydrate();

    assert.equal(finalized, false, 'the stale result root must not finalize the current session even sorted first');
    assert.equal(existsSync(path.join(panA, 'result.json')), true, 'the stale result is preserved');
    assert.equal(existsSync(rootA), true);
  } finally {
    sb.cleanup();
  }
});

test('rehydrate reserves the directory of a LIVE worker whose result is externally transitioned', async () => {
  const sb = makeSandbox();
  try {
    const repoDir = path.join(sb.dir, 'repo');
    mkdirSync(repoDir, { recursive: true });
    const { panDir, sessionId } = seedStateRoot(sb, {
      number: 34, itemId: 'item-34', workingDir: repoDir,
      isolated: false, alive: true, result: { outcome: 'done', summary: 'done' },
    });
    // A live launcher wrote a result, but the item is now claimed by another
    // runner → unfinalizable by us. Its directory must still be reserved.
    const foreign = projectItem({
      itemId: 'item-34', number: 34, status: 'in-progress', machine: MACHINE,
      sessionId, claimedBy: 'other-runner', leaseUntil: VALID_LEASE,
    });
    const runner = makeRehydrateRunner(sb, [foreign]);
    let finalized = false;
    runner.finalize = async () => { finalized = true; return true; };
    await runner.rehydrate();

    assert.equal(finalized, false, 'a foreign-claimed result is not finalized by us');
    const w = runner.active.get('item-34');
    assert.ok(w && w.occupancyOnly === true, 'the live external-result worker still reserves its directory');
    assert.equal(existsSync(path.join(panDir, 'result.json')), true, 'its result is preserved untouched');
  } finally {
    sb.cleanup();
  }
});

test('rehydrate never deletes a pending result that was externally transitioned', async () => {
  const sb = makeSandbox();
  try {
    const repoDir = path.join(sb.dir, 'repo');
    mkdirSync(repoDir, { recursive: true });
    const { stateRoot, panDir, sessionId } = seedStateRoot(sb, {
      number: 32, itemId: 'item-32', workingDir: repoDir,
      isolated: false, alive: false, result: { outcome: 'done', summary: 'done' },
    });
    // Now claimed by another runner → not ours to finalize.
    const foreign = projectItem({
      itemId: 'item-32', number: 32, status: 'paused', machine: MACHINE,
      sessionId, claimedBy: 'other-runner', leaseUntil: '',
    });
    const runner = makeRehydrateRunner(sb, [foreign]);
    let finalized = false;
    runner.finalize = async () => { finalized = true; return true; };
    await runner.rehydrate();

    assert.equal(finalized, false, 'a foreign-claimed result is not finalized by us');
    assert.equal(existsSync(path.join(panDir, 'result.json')), true, 'but its result is never deleted');
    assert.equal(existsSync(stateRoot), true);
  } finally {
    sb.cleanup();
  }
});

// ---- present-but-invalid markers authorize nothing -----------------

test('rehydrate does not adopt or finalize a root whose marker is malformed', async () => {
  const sb = makeSandbox();
  try {
    const repoDir = path.join(sb.dir, 'repo');
    mkdirSync(repoDir, { recursive: true });
    // A live worker + a finished result, but launch.json is present-yet-corrupt.
    const sessionId = randomUUID();
    const stateRoot = stateRootFor(sb, 61, sessionId);
    const panDir = path.join(stateRoot, '.pan');
    mkdirSync(panDir, { recursive: true });
    writeFileSync(path.join(panDir, 'task.json'), JSON.stringify({
      itemId: 'item-61', number: 61, title: 't', url: 'https://github.com/example/domain/issues/61', repo: 'example/domain', playbook: 'fixed',
    }));
    writeFileSync(path.join(panDir, 'launch.json'), '{ this is not valid json');
    writeFileSync(path.join(panDir, 'result.json'), JSON.stringify({ outcome: 'done', summary: 'done' }));
    writeFileSync(path.join(panDir, 'worker.running'), '');
    writeFileSync(path.join(panDir, 'worker.pid'), String(process.pid));

    const inProgress = projectItem({
      itemId: 'item-61', number: 61, status: 'in-progress', machine: MACHINE,
      sessionId, claimedBy: IDENTITY, leaseUntil: VALID_LEASE,
    });
    const runner = makeRehydrateRunner(sb, [inProgress]);
    let finalized = false;
    runner.finalize = async () => { finalized = true; return true; };
    await runner.rehydrate();

    assert.equal(runner.active.has('item-61'), false, 'a malformed marker must not authorize adoption');
    assert.equal(finalized, false, 'a malformed marker must not authorize finalization');
    assert.equal(existsSync(stateRoot), true, 'and the root is preserved (not deleted)');
    assert.equal(existsSync(path.join(panDir, 'result.json')), true);
  } finally {
    sb.cleanup();
  }
});

test('rehydrate does not adopt or finalize a root whose marker names another machine', async () => {
  const sb = makeSandbox();
  try {
    const repoDir = path.join(sb.dir, 'repo');
    mkdirSync(repoDir, { recursive: true });
    // A complete marker, but for a DIFFERENT machine → foreign → authorizes nothing.
    const { panDir, stateRoot } = seedStateRoot(sb, {
      number: 62, itemId: 'item-62', workingDir: repoDir, isolated: false,
      alive: true, machine: 'other-box', result: { outcome: 'done', summary: 'done' },
    });
    const readSessionId = JSON.parse(readFileSync(path.join(panDir, 'launch.json'), 'utf8')).sessionId;
    const foreignMarked = projectItem({
      itemId: 'item-62', number: 62, status: 'in-progress', machine: MACHINE,
      sessionId: readSessionId, claimedBy: IDENTITY, leaseUntil: VALID_LEASE,
    });
    const runner = makeRehydrateRunner(sb, [foreignMarked]);
    let finalized = false;
    runner.finalize = async () => { finalized = true; return true; };
    await runner.rehydrate();

    assert.equal(runner.active.has('item-62'), false, 'a foreign-machine marker must not authorize adoption');
    assert.equal(finalized, false, 'a foreign-machine marker must not authorize finalization');
    assert.equal(existsSync(stateRoot), true);
    assert.equal(existsSync(path.join(panDir, 'result.json')), true);
  } finally {
    sb.cleanup();
  }
});

// ---- finalize revalidates the fresh read before any write ----------

// A Runner whose finalize I/O is recorded, for driving finalize() directly.
function makeFinalizeRunner(sb, { fresh, reflect = false } = {}) {
  const calls = [];
  let live = fresh;
  const deps = {
    readAllItems: async () => [],
    readItemById: async () => live,
    setTextField: async (_c, _m, _id, field, value) => {
      calls.push(['setText', field, value]);
      if (reflect && live) live.fields[field] = value ?? '';
    },
    setSelectField: async (_c, _m, _id, field, value) => {
      calls.push(['setSelect', field, value]);
      if (reflect && live) live.fields[field] = value;
    },
    readDomainFile: async () => { throw new Error('none'); },
    gh: async () => { calls.push(['gh']); return ''; },
    ensureIssueComment: async () => { calls.push(['comment']); },
    ensureIssueClosed: async () => { calls.push(['close']); },
  };
  const runner = new Runner(baseCfg(sb), { fields: new Map() }, new Map(), deps);
  return { runner, calls };
}

function finalizeWorker(sb, { number, itemId, sessionId, slot = null, isolated = false }) {
  const stateRoot = stateRootFor(sb, number, sessionId);
  const panDir = path.join(stateRoot, '.pan');
  mkdirSync(panDir, { recursive: true });
  writeFileSync(path.join(panDir, 'result.json'), JSON.stringify({ outcome: 'done', summary: 'done' }));
  return {
    itemId, issueNumber: number, sessionId, slot, isolated, panDir,
    workingDir: stateRoot, url: `https://github.com/example/domain/issues/${number}`, repo: 'example/domain',
  };
}

test('finalize writes nothing when the live session-id no longer matches', async () => {
  const sb = makeSandbox();
  try {
    const sessionId = randomUUID();
    const w = finalizeWorker(sb, { number: 63, itemId: 'item-63', sessionId });
    // The live item is now a DIFFERENT session (a concurrent relaunch).
    const raced = projectItem({
      itemId: 'item-63', number: 63, status: 'in-progress', machine: MACHINE,
      sessionId: randomUUID(), claimedBy: IDENTITY, leaseUntil: VALID_LEASE,
    });
    const { runner, calls } = makeFinalizeRunner(sb, { fresh: raced });
    const finalized = await runner.finalize(w, path.join(w.panDir, 'result.json'));

    assert.equal(finalized, true, 'finalize resolves by stopping the worker, not retrying');
    assert.deepEqual(calls, [], 'no Project or Issue write when the live session changed');
    assert.equal(w.finished, true);
  } finally {
    sb.cleanup();
  }
});

test('finalize writes nothing when the live slot affinity drifted', async () => {
  const sb = makeSandbox();
  try {
    const sessionId = randomUUID();
    const w = finalizeWorker(sb, { number: 64, itemId: 'item-64', sessionId, slot: 'primary' });
    // Same session, but the composite slot moved primary → secondary.
    const raced = projectItem({
      itemId: 'item-64', number: 64, status: 'in-progress', machine: `${MACHINE}::secondary`,
      sessionId, claimedBy: IDENTITY, leaseUntil: VALID_LEASE,
    });
    const { runner, calls } = makeFinalizeRunner(sb, { fresh: raced });
    const finalized = await runner.finalize(w, path.join(w.panDir, 'result.json'));

    assert.equal(finalized, true);
    assert.deepEqual(calls, [], 'no write when the slot affinity no longer matches');
  } finally {
    sb.cleanup();
  }
});

test('finalize from a paused sweep writes nothing when the lease is still active', async () => {
  const sb = makeSandbox();
  try {
    const sessionId = randomUUID();
    const w = finalizeWorker(sb, { number: 65, itemId: 'item-65', sessionId });
    w.finalizeFromPausedSweep = true;
    // Paused + ours + same session, but the lease is NOT expired → not a sweep.
    const raced = projectItem({
      itemId: 'item-65', number: 65, status: 'paused', machine: MACHINE,
      sessionId, claimedBy: IDENTITY, leaseUntil: VALID_LEASE,
    });
    const { runner, calls } = makeFinalizeRunner(sb, { fresh: raced });
    const finalized = await runner.finalize(w, path.join(w.panDir, 'result.json'));

    assert.equal(finalized, true);
    assert.deepEqual(calls, [], 'a paused item with a live lease is not a swept worker');
  } finally {
    sb.cleanup();
  }
});

test('finalize commits the terminal status when the fresh read still matches', async () => {
  const sb = makeSandbox();
  try {
    const sessionId = randomUUID();
    const w = finalizeWorker(sb, { number: 66, itemId: 'item-66', sessionId });
    const live = projectItem({
      itemId: 'item-66', number: 66, status: 'in-progress', machine: MACHINE,
      sessionId, claimedBy: IDENTITY, leaseUntil: VALID_LEASE,
    });
    const { runner, calls } = makeFinalizeRunner(sb, { fresh: live, reflect: true });
    const finalized = await runner.finalize(w, path.join(w.panDir, 'result.json'));

    assert.equal(finalized, true);
    // It really wrote the terminal status and cleared the lease fields.
    assert.ok(calls.some((c) => c[0] === 'setSelect' && c[1] === FIELD.status && c[2] === 'done'));
    assert.ok(calls.some((c) => c[0] === 'setText' && c[1] === FIELD.claimedBy && c[2] === ''));
    assert.equal(w.finished, true);
  } finally {
    sb.cleanup();
  }
});

// ---- never follow a symlinked/junctioned session root --------------

test('rehydrate never follows a symlinked/junctioned session root', async (t) => {
  const sb = makeSandbox();
  try {
    // A real target OUTSIDE workspaceRoot that looks like a still-ours swept
    // session root with a finished result — following it would read/write and
    // finalize through the link, escaping workspaceRoot.
    const target = path.join(sb.dir, 'outside-target');
    const panDir = path.join(target, '.pan');
    mkdirSync(panDir, { recursive: true });
    const sessionId = randomUUID();
    writeFileSync(path.join(panDir, 'task.json'), JSON.stringify({
      itemId: 'item-70', number: 70, title: 't', url: 'https://github.com/example/domain/issues/70', repo: 'example/domain', playbook: 'fixed',
    }));
    writeFileSync(path.join(panDir, 'launch.json'), JSON.stringify({
      panRunner: true, version: 1, machine: MACHINE, identity: IDENTITY, itemId: 'item-70', number: 70, sessionId, isolated: false, workingDir: target, slot: null,
    }));
    writeFileSync(path.join(panDir, 'result.json'), JSON.stringify({ outcome: 'done', summary: 'done' }));
    // A directory link under workspaceRoot with a canonical name. `junction`
    // works on Windows without admin; on POSIX it makes a normal symlink.
    const linkPath = path.join(sb.workspaceRoot, `pan-70-${sessionId}`);
    let linked = true;
    try {
      symlinkSync(target, linkPath, 'junction');
    } catch {
      linked = false;
    }
    if (!linked) {
      t.skip('directory links are not permitted on this platform');
      return;
    }

    // The Project item MATCHES (same session, ours, swept) — so following the
    // link would finalize through it. The lstat guard must ignore the link.
    const swept = projectItem({
      itemId: 'item-70', number: 70, status: 'paused', machine: MACHINE,
      sessionId, claimedBy: IDENTITY, leaseUntil: '',
    });
    const runner = makeRehydrateRunner(sb, [swept]);
    let finalized = false;
    runner.finalize = async () => { finalized = true; return true; };
    await runner.rehydrate();

    assert.equal(finalized, false, 'a linked root must never be finalized through the link');
    assert.equal(runner.active.size, 0, 'a linked root is never adopted');
    assert.equal(existsSync(target), true, 'the link target must never be followed and removed');
    assert.equal(existsSync(path.join(panDir, 'result.json')), true, 'nor its contents');
  } finally {
    sb.cleanup();
  }
});

// ---- slot binding to the Project affinity --------------------------

test('rehydrate refuses to finalize a slot session whose Project slot drifted', async () => {
  const sb = makeSandbox();
  try {
    const primaryDir = path.join(sb.dir, 'slot-primary');
    const secondaryDir = path.join(sb.dir, 'slot-secondary');
    mkdirSync(primaryDir, { recursive: true });
    mkdirSync(secondaryDir, { recursive: true });
    // A slot-pooled session recorded in slot 'primary', with a finished result.
    const { panDir, stateRoot, sessionId } = seedStateRoot(sb, {
      number: 80, itemId: 'item-80', workingDir: primaryDir, isolated: false, slot: 'primary', playbook: 'pooled',
      alive: false, result: { outcome: 'done', summary: 'done' },
    });
    // The Project now pins the SAME session to a DIFFERENT slot.
    const drifted = projectItem({
      itemId: 'item-80', number: 80, status: 'paused', machine: `${MACHINE}::secondary`,
      sessionId, claimedBy: IDENTITY, leaseUntil: '',
    });
    const playbooks = pooledPlaybook({ primary: primaryDir, secondary: secondaryDir });
    const runner = makeRehydrateRunner(sb, [drifted], playbooks);
    let finalized = false;
    runner.finalize = async () => { finalized = true; return true; };
    await runner.rehydrate();

    assert.equal(finalized, false, 'an established session must not move between slot checkouts');
    assert.equal(existsSync(path.join(panDir, 'result.json')), true, 'its result is preserved');
    assert.equal(existsSync(stateRoot), true);
  } finally {
    sb.cleanup();
  }
});

test('rehydrate finalizes a slot session when the Project slot matches', async () => {
  const sb = makeSandbox();
  try {
    const primaryDir = path.join(sb.dir, 'slot-primary');
    mkdirSync(primaryDir, { recursive: true });
    const { sessionId } = seedStateRoot(sb, {
      number: 81, itemId: 'item-81', workingDir: primaryDir, isolated: false, slot: 'primary', playbook: 'pooled',
      alive: false, result: { outcome: 'done', summary: 'done' },
    });
    const swept = projectItem({
      itemId: 'item-81', number: 81, status: 'paused', machine: `${MACHINE}::primary`,
      sessionId, claimedBy: IDENTITY, leaseUntil: '',
    });
    const playbooks = pooledPlaybook({ primary: primaryDir });
    const runner = makeRehydrateRunner(sb, [swept], playbooks);
    const calls = [];
    runner.finalize = async (w) => { calls.push({ swept: w.finalizeFromPausedSweep }); return true; };
    await runner.rehydrate();

    assert.equal(calls.length, 1, 'a slot-matched swept result is finalized');
    assert.equal(calls[0].swept, true);
  } finally {
    sb.cleanup();
  }
});

test('launchWorker refuses a slot resume whose recorded slot differs from the Project affinity', async () => {
  const sb = makeSandbox();
  try {
    const primaryDir = path.join(sb.dir, 'slot-primary');
    const secondaryDir = path.join(sb.dir, 'slot-secondary');
    mkdirSync(primaryDir, { recursive: true });
    mkdirSync(secondaryDir, { recursive: true });
    const pooled = new Map([['pooled', {
      name: 'pooled', description: 'x', workingDirectory: null,
      slots: [{ id: 'primary', dir: primaryDir }, { id: 'secondary', dir: secondaryDir }], capacity: 2, body: 'B',
    }]]);
    const { runner } = makeLaunchRunner(sb, pooled);

    // The saved session ran in slot 'primary'...
    const sessionId = randomUUID();
    const panDir = path.join(stateRootFor(sb, 82, sessionId), '.pan');
    mkdirSync(panDir, { recursive: true });
    writeFileSync(path.join(panDir, 'launch.json'), JSON.stringify({
      panRunner: true, version: 1, machine: MACHINE, identity: IDENTITY,
      itemId: 'item-82', number: 82, sessionId, isolated: false, workingDir: primaryDir, slot: 'primary',
    }));

    // ...but the Project affinity now pins it to 'secondary'.
    await assert.rejects(
      runner.launchWorker(item({ itemId: 'item-82', number: 82, status: 'paused', machine: `${MACHINE}::secondary`, sessionId }), 'pooled'),
      /does not match the resume target/,
    );
  } finally {
    sb.cleanup();
  }
});

// ---- only ENOENT is "absent"; other read errors are present-invalid

test('rehydrate treats an unreadable launch.json (a directory) as present-invalid, not legacy-absent', async () => {
  const sb = makeSandbox();
  try {
    const repoDir = path.join(sb.dir, 'repo');
    mkdirSync(repoDir, { recursive: true });
    // A canonical root whose launch.json is a DIRECTORY → readFile fails with a
    // non-ENOENT error. It must be classified present-invalid (fail closed), NOT
    // absent (which would take the legacy path and finalize the result).
    const sessionId = randomUUID();
    const stateRoot = stateRootFor(sb, 90, sessionId);
    const panDir = path.join(stateRoot, '.pan');
    mkdirSync(panDir, { recursive: true });
    writeFileSync(path.join(panDir, 'task.json'), JSON.stringify({
      itemId: 'item-90', number: 90, title: 't', url: 'https://github.com/example/domain/issues/90', repo: 'example/domain', playbook: 'fixed',
    }));
    mkdirSync(path.join(panDir, 'launch.json'), { recursive: true });
    writeFileSync(path.join(panDir, 'result.json'), JSON.stringify({ outcome: 'done', summary: 'done' }));

    // A matching swept item — a legacy-absent root WOULD be finalized here.
    const swept = projectItem({
      itemId: 'item-90', number: 90, status: 'paused', machine: MACHINE,
      sessionId, claimedBy: IDENTITY, leaseUntil: '',
    });
    const runner = makeRehydrateRunner(sb, [swept]);
    let finalized = false;
    runner.finalize = async () => { finalized = true; return true; };
    await runner.rehydrate();

    assert.equal(finalized, false, 'a present-but-unreadable marker must not authorize finalization');
    assert.equal(existsSync(stateRoot), true, 'nor deletion');
    assert.equal(existsSync(path.join(panDir, 'result.json')), true);
  } finally {
    sb.cleanup();
  }
});

// ---- bind the saved checkout PATH, not only the slot id ----------

test('rehydrate refuses a slot session whose slot id was remapped to another checkout', async () => {
  const sb = makeSandbox();
  try {
    const oldDir = path.join(sb.dir, 'slot-old');
    const newDir = path.join(sb.dir, 'slot-new');
    mkdirSync(oldDir, { recursive: true });
    mkdirSync(newDir, { recursive: true });
    // A session recorded in slot 'primary' at oldDir, with a finished result.
    const { panDir, stateRoot, sessionId } = seedStateRoot(sb, {
      number: 91, itemId: 'item-91', workingDir: oldDir, isolated: false, slot: 'primary', playbook: 'pooled',
      alive: false, result: { outcome: 'done', summary: 'done' },
    });
    // Same slot id, same Project affinity — but the playbook now maps 'primary'
    // to a DIFFERENT checkout, so the session must not be moved onto it.
    const swept = projectItem({
      itemId: 'item-91', number: 91, status: 'paused', machine: `${MACHINE}::primary`,
      sessionId, claimedBy: IDENTITY, leaseUntil: '',
    });
    const playbooks = pooledPlaybook({ primary: newDir });
    const runner = makeRehydrateRunner(sb, [swept], playbooks);
    let finalized = false;
    runner.finalize = async () => { finalized = true; return true; };
    await runner.rehydrate();

    assert.equal(finalized, false, 'a same-slot-id remap to another checkout must not finalize/move the session');
    assert.equal(existsSync(path.join(panDir, 'result.json')), true, 'its result is preserved');
    assert.equal(existsSync(stateRoot), true);
  } finally {
    sb.cleanup();
  }
});

test('launchWorker refuses a slot resume whose slot now maps to a different checkout', async () => {
  const sb = makeSandbox();
  try {
    const oldDir = path.join(sb.dir, 'slot-old');
    const newDir = path.join(sb.dir, 'slot-new');
    mkdirSync(oldDir, { recursive: true });
    mkdirSync(newDir, { recursive: true });
    // The playbook maps slot 'primary' to newDir now.
    const pooled = new Map([['pooled', {
      name: 'pooled', description: 'x', workingDirectory: null,
      slots: [{ id: 'primary', dir: newDir }], capacity: 1, body: 'B',
    }]]);
    const { runner } = makeLaunchRunner(sb, pooled);

    // The saved session recorded slot 'primary' at the OLD checkout.
    const sessionId = randomUUID();
    const panDir = path.join(stateRootFor(sb, 92, sessionId), '.pan');
    mkdirSync(panDir, { recursive: true });
    writeFileSync(path.join(panDir, 'launch.json'), JSON.stringify({
      panRunner: true, version: 1, machine: MACHINE, identity: IDENTITY,
      itemId: 'item-92', number: 92, sessionId, isolated: false, workingDir: oldDir, slot: 'primary',
    }));

    await assert.rejects(
      runner.launchWorker(item({ itemId: 'item-92', number: 92, status: 'paused', machine: `${MACHINE}::primary`, sessionId }), 'pooled'),
      /maps to a different checkout/,
    );
  } finally {
    sb.cleanup();
  }
});
