import assert from 'node:assert/strict';
import test from 'node:test';
import { CANONICAL_FIELDS } from '../bin/pan-project-schema.js';
import { loadProjectMeta, reportSchemaDrift, startAfterLoad } from '../bin/pan-runner.js';

// The module starts the runner only as a CLI entry point, so these tests reach
// its startup decisions through exports with no network and no real Runner.

// A resolved metadata map in the shape startAfterLoad consumes. Deleting a field
// or dropping an option models a Project that has drifted from the contract.
function metaFields(overrides = {}) {
  const dataTypeFor = { 'single-select': 'SINGLE_SELECT', text: 'TEXT', date: 'DATE' };
  const fields = new Map();
  for (const spec of CANONICAL_FIELDS) {
    const options = spec.type === 'single-select'
      ? new Map(spec.options.map((name) => [name, `opt-${name}`]))
      : null;
    fields.set(spec.name, { dataType: dataTypeFor[spec.type], options });
  }
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) fields.delete(name);
    else fields.set(name, value);
  }
  return { fields };
}

// Collect stderr written during fn, restoring the stream afterward.
function captureStderr(fn) {
  const original = process.stderr.write.bind(process.stderr);
  let out = '';
  process.stderr.write = (chunk) => {
    out += chunk;
    return true;
  };
  try {
    fn();
  } finally {
    process.stderr.write = original;
  }
  return out;
}

// Leave the process's signal listeners as the test found them.
async function withSignalCleanup(fn) {
  const before = {
    SIGINT: process.listeners('SIGINT').slice(),
    SIGTERM: process.listeners('SIGTERM').slice(),
  };
  try {
    return await fn();
  } finally {
    for (const sig of ['SIGINT', 'SIGTERM']) {
      for (const listener of process.listeners(sig)) {
        if (!before[sig].includes(listener)) process.removeListener(sig, listener);
      }
    }
  }
}

const CONFIG = {
  domainRepoSlug: 'example/domain',
  project: { owner: 'example', number: 7 },
  machine: 'test-machine',
  identity: 'test-machine-runner-1',
  terminalKind: 'macos-terminal',
  workerPermissions: 'standard',
};

test('reportSchemaDrift emits the concrete problems and the recovery path', () => {
  const lines = [];
  const blocked = reportSchemaDrift(
    ['missing text field "session-id"', 'single-select field "owner" is missing option "agent"'],
    (line) => lines.push(line),
  );
  assert.equal(blocked, true);
  const text = lines.join('\n');
  assert.match(text, /missing text field "session-id"/);
  assert.match(text, /single-select field "owner" is missing option "agent"/);
  assert.match(text, /reconcile Project schema/);
  assert.match(text, /restart the runner/);
  assert.match(text, /Open Pan chat/);
});

test('reportSchemaDrift is silent and does not block a current schema', () => {
  const lines = [];
  const blocked = reportSchemaDrift([], (line) => lines.push(line));
  assert.equal(blocked, false);
  assert.deepEqual(lines, []);
});

test('normal startup fails fast on drift without instantiating the runner', async () => {
  let madeRunner = false;
  const makeRunner = () => {
    madeRunner = true;
    throw new Error('runner must not be instantiated when the schema has drifted');
  };

  let code;
  const stderr = captureStderr(() => {
    const result = startAfterLoad({
      cfg: CONFIG,
      meta: metaFields({ 'session-id': undefined }),
      playbooks: new Map(),
      args: { 'validate-config': false, once: false },
      makeRunner,
    });
    result.then((c) => { code = c; });
  });

  await Promise.resolve();
  assert.equal(code, 1);
  assert.equal(madeRunner, false);
  assert.match(stderr, /Project schema is out of date/);
  assert.match(stderr, /missing text field "session-id"/);
  assert.match(stderr, /reconcile Project schema/);
  assert.match(stderr, /restart the runner/);
});

test('--validate-config validates a clean schema and returns without polling', async () => {
  let madeRunner = false;
  const code = await startAfterLoad({
    cfg: CONFIG,
    meta: metaFields(),
    playbooks: new Map([['isolated', {}]]),
    args: { 'validate-config': true, once: false },
    makeRunner: () => { madeRunner = true; return {}; },
  });
  assert.equal(code, 0);
  assert.equal(madeRunner, false);
});

test('a clean schema proceeds to the poll loop exactly once', async () => {
  await withSignalCleanup(async () => {
    let loopArgs;
    const runner = {
      requestDrain() {},
      pokeNow() {},
      loop(opts) { loopArgs = opts; return Promise.resolve(); },
    };
    let calls = 0;
    const code = await startAfterLoad({
      cfg: CONFIG,
      meta: metaFields(),
      playbooks: new Map(),
      args: { 'validate-config': false, once: true },
      makeRunner: () => { calls += 1; return runner; },
    });
    assert.equal(code, 0);
    assert.equal(calls, 1);
    assert.deepEqual(loopArgs, { once: true });
  });
});

// A single Project field page in the shape gh returns for the metadata query.
function fieldPage(ownerType, id, nodes, pageInfo) {
  return { data: { [ownerType]: { projectV2: { id, fields: { nodes, pageInfo } } } } };
}

test('loadProjectMeta reads a single field page without a second request', async () => {
  const calls = [];
  const ghJson = async (args) => {
    calls.push(args);
    return fieldPage(
      'user',
      'PVT_1',
      [{ __typename: 'ProjectV2Field', id: 'f-machine', name: 'machine', dataType: 'TEXT' }],
      { hasNextPage: false, endCursor: null },
    );
  };
  const meta = await loadProjectMeta(
    { project: { owner: 'octo', number: 4 } },
    { ghJson, resolveOwnerType: async () => 'user' },
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].some((a) => String(a).startsWith('cursor=')), false);
  assert.equal(meta.projectId, 'PVT_1');
  assert.equal(meta.fields.get('machine').dataType, 'TEXT');
});

test('loadProjectMeta follows the field cursor across pages and merges them', async () => {
  const pages = [
    fieldPage(
      'organization',
      'PVT_2',
      [{
        __typename: 'ProjectV2SingleSelectField',
        id: 'f-status',
        name: 'Status',
        options: [{ id: 'o-ready', name: 'ready' }],
      }],
      { hasNextPage: true, endCursor: 'CUR_1' },
    ),
    fieldPage(
      'organization',
      'PVT_2',
      [{ __typename: 'ProjectV2Field', id: 'f-session', name: 'session-id', dataType: 'TEXT' }],
      { hasNextPage: false, endCursor: null },
    ),
  ];
  const calls = [];
  let i = 0;
  const ghJson = async (args) => {
    calls.push(args);
    return pages[i++];
  };
  const meta = await loadProjectMeta(
    { project: { owner: 'octo-org', number: 9 } },
    { ghJson, resolveOwnerType: async () => 'organization' },
  );
  assert.equal(calls.length, 2);
  assert.equal(calls[0].includes('cursor=CUR_1'), false);
  assert.equal(calls[1].includes('cursor=CUR_1'), true);
  assert.equal(meta.projectId, 'PVT_2');
  assert.equal(meta.fields.get('Status').options.get('ready'), 'o-ready');
  assert.equal(meta.fields.get('session-id').dataType, 'TEXT');
});

test('loadProjectMeta fails clearly when the Project is gone on a later page', async () => {
  const pages = [
    fieldPage(
      'user',
      'PVT_3',
      [{ __typename: 'ProjectV2Field', id: 'f-a', name: 'machine', dataType: 'TEXT' }],
      { hasNextPage: true, endCursor: 'CUR_X' },
    ),
    { data: { user: { projectV2: null } } },
  ];
  let i = 0;
  const ghJson = async () => pages[i++];
  await assert.rejects(
    loadProjectMeta(
      { project: { owner: 'octo', number: 12 } },
      { ghJson, resolveOwnerType: async () => 'user' },
    ),
    /Project octo\/12 not found/,
  );
});
