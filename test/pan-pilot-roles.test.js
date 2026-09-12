import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {
  buildChiefCommand,
  findChiefSessions,
  resolveChiefAction,
  runChief,
} from '../bin/pan-chief.js';
import {
  loadBackendPlaybooks,
  resolvePlaybookWorkspace,
  validateBackendPlaybook,
} from '../bin/pan-backend-playbooks.js';
import { planBackendTasks } from '../bin/pan-backend-runner.js';

test('chief command starts and resumes one named Sol session with domain-only prompt', () => {
  const config = {
    configPath: '/private/pan.json',
    domainRepo: 'owner/domain',
    panCheckout: '/checkout/pan',
    chiefSessionName: 'pan-chief-owner-domain',
  };
  const start = buildChiefCommand('start', config);
  assert.deepEqual(start.args.slice(0, 4), [
    '-C', '/checkout/pan', '--model', 'gpt-5.6-sol',
  ]);
  assert.ok(start.args.includes('/private'));
  assert.ok(start.args.includes('pan-chief'));
  assert.equal(start.args.at(-1), 'You are the chief-of-staff Pan agent for Domain owner/domain.');
  assert.equal(start.env.PAN_CONFIG, '/private/pan.json');

  const exact = buildChiefCommand('resume', {
    ...config,
    chiefSessionId: '21c40bf8-ab24-4c62-9a76-26e999e6089b',
  });
  assert.ok(exact.args.includes('--session-id'));
  assert.ok(exact.args.includes('21c40bf8-ab24-4c62-9a76-26e999e6089b'));
});

test('chief start refuses a configured session id without spawning', async () => {
  await assert.rejects(
    resolveChiefAction('start', {
      chiefSessionName: 'pan-chief-owner-domain',
      chiefSessionId: 'canonical-id',
    }),
    /already configured; use resume/,
  );
});

test('chief start refusal occurs before the launcher can spawn', async () => {
  let spawned = false;
  await assert.rejects(runChief(['start', '--config', '/binding.json'], {
    readFile: async () => JSON.stringify({
      domainRepo: 'owner/domain',
      panCheckout: '/checkout/pan',
      chiefSessionName: 'pan-chief-owner-domain',
      chiefSessionId: 'canonical-id',
    }),
    spawn: () => {
      spawned = true;
      throw new Error('must not spawn');
    },
  }), /already configured; use resume/);
  assert.equal(spawned, false);
});

test('chief start refuses an exact persisted name and first-ever start remains valid', async () => {
  const config = {
    chiefSessionName: 'pan-chief-owner-domain',
    chiefCopilotHome: '/copilot-home',
  };
  const existing = {
    readdir: async () => [{ name: 'existing-id', isDirectory: () => true }],
    readFile: async () => [
      'id: existing-id',
      'name: pan-chief-owner-domain',
    ].join('\n'),
  };
  assert.deepEqual(await findChiefSessions(config, existing), [{
    id: 'existing-id',
    name: 'pan-chief-owner-domain',
    filename: path.join('/copilot-home', 'session-state', 'existing-id', 'workspace.yaml'),
  }]);
  await assert.rejects(resolveChiefAction('start', config, existing), /already exists/);

  const first = await resolveChiefAction('start', config, {
    readdir: async () => {
      const error = new Error('missing');
      error.code = 'ENOENT';
      throw error;
    },
  });
  assert.equal(first.action, 'start');
});

test('chief resume resolves one exact persisted id and rejects ambiguity', async () => {
  const config = {
    chiefSessionName: 'pan-chief-owner-domain',
    chiefCopilotHome: '/copilot-home',
  };
  const one = await resolveChiefAction('resume', config, {
    readdir: async () => [{ name: 'canonical-id', isDirectory: () => true }],
    readFile: async () => 'id: canonical-id\nname: pan-chief-owner-domain\n',
  });
  assert.equal(one.config.chiefSessionId, 'canonical-id');
  assert.throws(
    () => buildChiefCommand('resume', {
      ...config,
      domainRepo: 'owner/domain',
      panCheckout: '/checkout/pan',
      configPath: '/binding.json',
    }),
    /chiefSessionId is required/,
  );
  await assert.rejects(resolveChiefAction('resume', config, {
    readdir: async () => [
      { name: 'one', isDirectory: () => true },
      { name: 'two', isDirectory: () => true },
    ],
    readFile: async (filename) =>
      `id: ${path.basename(path.dirname(filename))}\nname: pan-chief-owner-domain\n`,
  }), /found 2/);
});

test('packaged chief, worker, and compatibility agent roles are distinct', async () => {
  const chief = await readFile('.github/agents/pan-chief.agent.md', 'utf8');
  const worker = await readFile('.github/agents/pan-worker.agent.md', 'utf8');
  const alias = await readFile('.github/agents/pan.agent.md', 'utf8');
  assert.match(chief, /do not execute tasks/i);
  assert.match(worker, /exactly one task/i);
  assert.match(worker, /Do not spawn\s+subagents/i);
  assert.match(alias, /compatibility alias/i);
});

test('playbook validation and workspace resolution support fixed, pooled, and isolated work', () => {
  const fixed = validateBackendPlaybook('fixed.md', [
    '---', 'name: fixed', 'description: Fixed', 'capacity: 1',
    'workingDirectory: /work/fixed', '---', '# Fixed',
  ].join('\n'));
  assert.equal(
    resolvePlaybookWorkspace(fixed, '1', { occupiedSlots: new Map() }).workingDirectory,
    path.resolve('/work/fixed'),
  );

  const pooled = validateBackendPlaybook('pooled.md', [
    '---', 'name: pooled', 'description: Pooled', 'capacity: 2',
    'workspaceSlots:', '  first: /work/one', '  second: /work/two',
    '---', '# Pooled',
  ].join('\n'));
  assert.deepEqual(
    resolvePlaybookWorkspace(pooled, '2', {
      occupiedSlots: new Map([['pooled', new Set(['first'])]]),
    }),
    { workingDirectory: path.resolve('/work/two'), workspaceSlot: 'second' },
  );

  const isolated = validateBackendPlaybook('isolated.md', [
    '---', 'name: isolated', 'description: Isolated', 'capacity: 1',
    'workingDirectory: null', '---', '# Isolated',
  ].join('\n'));
  assert.equal(
    resolvePlaybookWorkspace(isolated, 'task/id', {
      occupiedSlots: new Map(), workspaceRoot: '/work/root',
    }).workingDirectory,
    path.resolve('/work/root/task%2Fid'),
  );
});

test('live Domain loader validates every machine playbook and records blob identities', async () => {
  const content = (text) => Buffer.from(text).toString('base64');
  const result = await loadBackendPlaybooks({
    domainRepo: 'owner/domain',
    machine: 'machine-a',
  }, {
    ghJson: async (args) => {
      const endpoint = args[0];
      if (endpoint.endsWith('/playbooks/machine-a')) {
        return [{ type: 'file', name: 'build.md' }];
      }
      if (endpoint.endsWith('/playbooks/machine-a/build.md')) {
        return {
          type: 'file',
          sha: 'playbook-sha',
          content: content('---\nname: build\ndescription: Build\ncapacity: 1\nworkingDirectory: /work\n---\nDo it.\n'),
        };
      }
      return { type: 'file', sha: 'domain-sha', content: content('# Domain\n') };
    },
  });
  assert.equal(result.playbooks.get('build').sha, 'playbook-sha');
  assert.equal(result.domainSha, 'domain-sha');
});

test('planning preserves backend order and enforces playbook and global capacity', async () => {
  const playbooks = new Map([
    ['build', {
      name: 'build', capacity: 1, workingDirectory: '/work/build', slots: null,
    }],
    ['disabled', {
      name: 'disabled', capacity: 0, workingDirectory: '/work/disabled', slots: null,
    }],
  ]);
  const base = {
    status: 'ready-for-ai', nextAction: 'execute', executionAuthorized: true,
    dependencies: [], worker: null, recurring: false,
  };
  const result = await planBackendTasks({
    tasks: [
      { ...base, id: 'first', playbook: 'build' },
      { ...base, id: 'second', playbook: 'build' },
      { ...base, id: 'third', playbook: 'missing' },
      { ...base, id: 'fourth', playbook: 'disabled' },
    ],
    inventory: { live: [], stale: [], uncertain: [], unexpected: [] },
    config: { maxConcurrent: 3, workspaceRoot: '/isolated' },
    playbooks,
  });
  assert.deepEqual(result.plans.map((plan) => plan.task.id), ['first']);
  assert.deepEqual(result.skipped.map((entry) => entry.id), ['second', 'third', 'fourth']);
});
