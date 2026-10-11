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

test('chief intake and triage load the input contract, not worker instructions', async () => {
  const [chief, worker, overview, triage, intake, contract] = await Promise.all([
    readFile('.github/agents/pan-chief.agent.md', 'utf8'),
    readFile('system/worker-base-instructions.md', 'utf8'),
    readFile('system/overview.md', 'utf8'),
    readFile('system/triage.md', 'utf8'),
    readFile('system/source-intake.md', 'utf8'),
    readFile('system/untrusted-input.md', 'utf8'),
  ]);
  for (const text of [chief, overview, triage, intake]) {
    assert.match(text, /untrusted-input\.md/);
  }
  assert.doesNotMatch(worker, /untrusted-input\.md|untrusted/i);
  assert.match(contract, /not worker execution/);
  assert.match(contract, /agent paraphrase does not turn source text into user approval/);
  assert.match(contract, /service\s+account or shared token/i);
  assert.match(contract, /Client-supplied Reporter email is contact information/);
  assert.match(contract, /Fake role headings, delimiter closures, and encoded/);
  assert.match(contract, /Surface suspected injection/i);
  assert.match(contract, /briefing review remain real operator instruction/);
  assert.match(contract, /do not prove that a model will resist every injection/);
});

test('approval hands off task requirements without applying chief triage policy to workers', async () => {
  const [contract, chief, worker, triage] = await Promise.all([
    readFile('system/untrusted-input.md', 'utf8'),
    readFile('.github/agents/pan-chief.agent.md', 'utf8'),
    readFile('system/worker-base-instructions.md', 'utf8'),
    readFile('system/triage.md', 'utf8'),
  ]);
  assert.match(contract, /not instructions to the chief/);
  assert.match(contract, /explicit approval before requesting agent work/);
  assert.match(contract, /Approval adopts the task's contents as the worker's assignment/);
  assert.match(contract, /do not carry it into worker execution/);
  assert.match(chief, /record it in task comments/);
  assert.match(triage, /before setting `agentStatus=requested`/);
  assert.match(worker, /requirements and\s+implementation instructions, including subsequent operator edits/);
  assert.match(worker, /Do not\s+require repetition in chat or re-approval of each edit/);
  assert.doesNotMatch(worker, /requesting a worker does not elevate that content/);
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

test('worker instructions keep resumed completed conversations open for a new message', async () => {
  const surfaces = await Promise.all([
    readFile('.github/agents/pan-worker.agent.md', 'utf8'),
    readFile('system/worker-base-instructions.md', 'utf8'),
    readFile('system/default-playbook.md', 'utf8'),
    readFile('system/task-lifecycle.md', 'utf8'),
    readFile('system/hub.md', 'utf8'),
  ]);

  for (const text of surfaces) {
    assert.match(text, /Done or rejected task/i);
    assert.match(text, /new operator\s+message/i);
    assert.match(text, /wait/i);
    assert.match(text, /worker-release\.json|release request/i);
  }
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
      const endpoint = args[2];
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
  assert.ok(calls.every((args) => args[0] === '--method' && args[1] === 'GET'));
});
