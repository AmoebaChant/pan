import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {
  loadBackendPlaybooks,
  resolvePlaybookWorkingDirectory,
  splitPlaybookFrontMatter,
  validateBackendPlaybook,
} from '../bin/pan-backend-playbooks.js';

test('packaged worker remains selectable by its runner-facing agent name', async () => {
  const worker = await readFile('.github/agents/pan-worker.agent.md', 'utf8');
  const { front } = splitPlaybookFrontMatter(worker);

  assert.equal(front.name, 'pan-worker');
  assert.equal(front['user-invocable'], 'true');
});

test('packaged chief, worker, and compatibility roles use the simple model', async () => {
  const chief = await readFile('.github/agents/pan-chief.agent.md', 'utf8');
  const worker = await readFile('.github/agents/pan-worker.agent.md', 'utf8');
  const alias = await readFile('.github/agents/pan.agent.md', 'utf8');
  assert.match(chief, /Work Status and Agent status are independent/);
  assert.match(chief, /including for Done or rejected tasks/);
  assert.match(worker, /exactly one task/i);
  assert.match(worker, /Do not spawn subagents/i);
  assert.match(alias, /exactly as `pan-chief`/);
});

test('worker instructions release after verified completion and not while waiting', async () => {
  const surfaces = await Promise.all([
    readFile('.github/agents/pan-worker.agent.md', 'utf8'),
    readFile('system/worker-base-instructions.md', 'utf8'),
    readFile('system/default-playbook.md', 'utf8'),
    readFile('system/task-lifecycle.md', 'utf8'),
  ]);

  for (const text of surfaces) {
    assert.match(text, /worker-release\.json/);
    assert.match(text, /final action/);
    assert.match(text, /waiting/);
    assert.doesNotMatch(text, /only when .*early close/i);
  }
  assert.match(surfaces[1], /persist the final task comment/i);
  assert.match(surfaces[1], /re-read the live task and comments/i);
  assert.match(surfaces[1], /done.*or.*rejected/i);
  assert.match(surfaces[3], /Changing work status.*does not stop a running session/i);
});

test('playbooks select instructions and an explicit working directory only', () => {
  const playbook = validateBackendPlaybook('build.md', [
    '---',
    'name: build',
    'description: Build the product',
    `workingDirectory: ${path.resolve('work', 'product')}`,
    '---',
    '# Build',
  ].join('\n'));
  assert.equal(
    resolvePlaybookWorkingDirectory(playbook, {}),
    path.resolve('work', 'product'),
  );
  assert.equal(Object.hasOwn(playbook, 'capacity'), false);
  assert.equal(Object.hasOwn(playbook, 'slots'), false);
});

test('remote Domain loading requires and uses an explicit revision', async () => {
  const calls = [];
  const content = (text) => Buffer.from(text).toString('base64');
  await assert.rejects(
    loadBackendPlaybooks({
      domainRepo: 'owner/domain',
      machine: 'machine-a',
    }, { ghJson: async () => [] }),
    /domainRevision is required/,
  );
  const loaded = await loadBackendPlaybooks({
    domainRepo: 'owner/domain',
    domainRevision: 'reviewed-sha',
    machine: 'machine-a',
  }, {
    ghJson: async (args) => {
      calls.push(args);
      const endpoint = args[0];
      if (endpoint.endsWith('/playbooks/machine-a')) {
        return [{ type: 'file', name: 'build.md' }];
      }
      if (endpoint.endsWith('/build.md')) {
        return {
          type: 'file',
          sha: 'playbook-sha',
          content: content(
            `---\nname: build\ndescription: Build\nworkingDirectory: ${path.resolve('work')}\n---\nDo it.\n`,
          ),
        };
      }
      return {
        type: 'file',
        sha: 'domain-sha',
        content: content('# Domain\n'),
      };
    },
  });
  assert.equal(loaded.domainRevision, 'domain-sha');
  assert.ok(calls.every((args) => args.includes('ref=reviewed-sha')));
});
