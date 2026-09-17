import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { GitHubTaskBackend } from '../bin/pan-github-task-backend.js';
import {
  pollRunner,
  validateRunnerConfig,
} from '../bin/pan-backend-runner.js';

class MemoryGitHubTransport {
  constructor() {
    this.items = [];
    this.comments = new Map();
    this.nextIssue = 1;
  }

  async initialize() {}

  async listItems() {
    return this.items;
  }

  async createIssue({ title, body }) {
    const number = this.nextIssue++;
    return {
      node_id: `issue-${number}`,
      number,
      title,
      body,
      html_url: `https://github.com/example/domain/issues/${number}`,
    };
  }

  async addProjectItem(contentId) {
    const number = Number(contentId.slice('issue-'.length));
    const item = {
      id: `item-${number}`,
      fieldValues: { nodes: [] },
      content: {
        id: contentId,
        number,
        title: `Task ${number}`,
        body: '',
        url: `https://github.com/example/domain/issues/${number}`,
        state: 'OPEN',
        stateReason: null,
        createdAt: '2026-09-16T00:00:00Z',
        updatedAt: '2026-09-16T00:00:00Z',
        closedAt: null,
        repository: { nameWithOwner: 'example/domain' },
      },
    };
    this.items.push(item);
    return { id: item.id };
  }

  itemForNumber(number) {
    return this.items.find((item) => item.content.number === Number(number));
  }

  async updateIssue(number, changes) {
    const item = this.itemForNumber(number);
    if (changes.title !== undefined) item.content.title = changes.title;
    if (changes.body !== undefined) item.content.body = changes.body;
    if (changes.state === 'open') {
      item.content.state = 'OPEN';
      item.content.stateReason = null;
      item.content.closedAt = null;
    }
    if (changes.state === 'closed') {
      item.content.state = 'CLOSED';
      item.content.stateReason = changes.state_reason === 'completed'
        ? 'COMPLETED'
        : 'NOT_PLANNED';
      item.content.closedAt = '2026-09-16T01:00:00Z';
    }
    item.content.updatedAt = '2026-09-16T01:00:00Z';
    return item.content;
  }

  async updateField(itemId, name, value) {
    const item = this.items.find((candidate) => candidate.id === itemId);
    item.fieldValues.nodes = item.fieldValues.nodes.filter(
      (field) => field.field.name !== name,
    );
    if (value !== '') {
      item.fieldValues.nodes.push({
        field: { name },
        ...(name === 'Status' || name === 'priority' || name === 'agent-status'
          ? { name: value }
          : name === 'next-action-date' || name === 'deadline'
            ? { date: value }
            : { text: value }),
      });
    }
  }

  async addComment(number, body) {
    const comments = this.comments.get(Number(number)) ?? [];
    const comment = {
      id: comments.length + 1,
      body,
      created_at: '2026-09-16T02:00:00Z',
      updated_at: '2026-09-16T02:00:00Z',
      html_url: `https://github.com/example/domain/issues/${number}#issuecomment-${comments.length + 1}`,
      user: { login: 'tester' },
    };
    comments.push(comment);
    this.comments.set(Number(number), comments);
    return comment;
  }

  async listComments(number) {
    return this.comments.get(Number(number)) ?? [];
  }
}

async function createBackend() {
  const transport = new MemoryGitHubTransport();
  const backend = await new GitHubTaskBackend({
    backend: 'github',
    repository: 'example/domain',
    projectOwner: 'example',
    projectNumber: 1,
  }, { transport }).initialize();
  return { backend, transport };
}

test('GitHub CRUD uses only the small task and session contract', async () => {
  const { backend } = await createBackend();
  const created = await backend.create({
    title: 'Ship the simplification',
    description: 'Keep the task record plain.',
    priority: 'high',
    nextActionDate: '2026-09-18',
    deadline: '2026-09-30',
    playbook: 'pan',
    workstream: 'pan',
  });
  assert.deepEqual(
    Object.keys(created).filter((key) => [
      'owner',
      'nextAction',
      'executionAuthorized',
      'dependencies',
      'workerState',
      'claimGeneration',
      'resourceSemantics',
      'revision',
    ].includes(key)),
    [],
  );
  assert.equal(created.status, 'open');
  assert.equal(created.agentStatus, '');

  const requested = await backend.update(created.id, { agentStatus: 'requested' });
  assert.equal(requested.agentStatus, 'requested');
  assert.equal(requested.sessionId, '');

  const completed = await backend.update(created.id, { status: 'done' });
  assert.equal(completed.status, 'done');
  assert.equal(completed.agentStatus, 'requested');
  assert.equal(completed.issueStateReason, 'COMPLETED');

  const reopened = await backend.reopen(created.id);
  assert.equal(reopened.status, 'open');
  assert.equal(reopened.issueState, 'OPEN');

  const rejected = await backend.complete(created.id, { outcome: 'rejected' });
  assert.equal(rejected.status, 'rejected');
  assert.equal(rejected.issueStateReason, 'NOT_PLANNED');

  await backend.comment(created.id, { content: 'Progress is descriptive, not a transition.' });
  assert.equal((await backend.get(created.id)).status, 'rejected');
  assert.deepEqual(
    (await backend.comments(created.id)).map((comment) => comment.content),
    ['Progress is descriptive, not a transition.'],
  );
});

test('runner creates, resumes, and closes the same session independently of work status', async () => {
  const { backend } = await createBackend();
  const task = await backend.create({
    title: 'Done task can still open',
    status: 'done',
    playbook: 'pan',
    agentStatus: 'requested',
  });
  const root = await mkdtemp(path.join(os.tmpdir(), 'pan-simple-runner-'));
  const config = validateRunnerConfig({
    backendConfig: path.join(root, 'backend.json'),
    stateRoot: path.join(root, 'state'),
    workingDirectory: root,
    machine: 'test-machine',
    launchCommand: ['copilot', '--model', 'gpt-5.6-sol', '--agent', 'pan-worker'],
  });
  const loadedDomain = {
    playbooks: new Map([['pan', {
      name: 'pan',
      description: 'Test',
      workingDirectory: root,
      text: '# Pan',
    }]]),
    domainInstructions: '# Domain',
    domainRevision: 'reviewed-sha',
  };
  const livePids = new Set();
  const launches = [];
  let nextPid = 5000;
  const dependencies = {
    processIsAlive: (pid) => livePids.has(pid),
    launchProcess: async ({ sessionId }) => {
      const pid = nextPid++;
      livePids.add(pid);
      launches.push({ pid, sessionId });
      return { pid, processStart: `start-${pid}` };
    },
    stopProcess: async (pid) => {
      livePids.delete(pid);
    },
  };

  const first = await pollRunner({
    backend,
    config,
    loadedDomain,
    dependencies,
  });
  assert.deepEqual(first.launched, [task.id]);
  const running = await backend.get(task.id);
  assert.equal(running.status, 'done');
  assert.equal(running.agentStatus, 'running');
  assert.match(running.sessionId, /^[0-9a-f-]{36}$/);

  const second = await pollRunner({
    backend,
    config,
    loadedDomain,
    dependencies,
  });
  assert.deepEqual(second.launched, []);
  assert.equal(launches.length, 1);

  await backend.update(task.id, { status: 'open' });
  await backend.update(task.id, { status: 'done' });
  await pollRunner({ backend, config, loadedDomain, dependencies });
  assert.equal(livePids.has(launches[0].pid), true);
  assert.equal((await backend.get(task.id)).agentStatus, 'running');

  const run = JSON.parse(await readFile(
    path.join(config.stateRoot, 'tasks', encodeURIComponent(task.id), 'run.json'),
    'utf8',
  ));
  await writeFile(
    path.join(config.stateRoot, 'tasks', encodeURIComponent(task.id), 'worker-release.json'),
    '',
  );
  await pollRunner({ backend, config, loadedDomain, dependencies });
  const closed = await backend.get(task.id);
  assert.equal(closed.status, 'done');
  assert.equal(closed.agentStatus, '');
  assert.equal(closed.sessionId, run.sessionId);

  await backend.update(task.id, { agentStatus: 'requested' });
  await pollRunner({ backend, config, loadedDomain, dependencies });
  assert.equal(launches.length, 2);
  assert.equal(launches[1].sessionId, launches[0].sessionId);

  await rm(root, { recursive: true, force: true });
});

test('default runner launch opens the saved session interactively', async () => {
  const { backend } = await createBackend();
  const savedSessionId = '11111111-2222-4333-8444-555555555555';
  const task = await backend.create({
    title: 'Keep the worker open',
    playbook: 'pan',
    agentStatus: 'requested',
    sessionId: savedSessionId,
  });
  const root = await mkdtemp(path.join(process.cwd(), '.pan-default-launch-'));
  const expectedSystemDir = fileURLToPath(new URL('../system', import.meta.url));
  const workingDirectory = path.join(root, 'work');
  await mkdir(workingDirectory);
  const configuredArgs = ['--model', 'gpt-5.6-sol', '--agent', 'pan-worker'];
  const config = validateRunnerConfig({
    backendConfig: path.join(root, 'backend.json'),
    stateRoot: path.join(root, 'state'),
    workingDirectory,
    machine: 'test-machine',
    launchCommand: ['copilot', ...configuredArgs],
  });
  const loadedDomain = {
    playbooks: new Map([['pan', {
      name: 'pan',
      description: 'Test',
      workingDirectory,
      text: '# Pan',
    }]]),
    domainInstructions: '# Domain',
    domainRevision: 'reviewed-sha',
  };
  const launches = [];
  let unrefCalled = false;
  const child = new EventEmitter();
  child.pid = 8000;
  child.unref = () => {
    unrefCalled = true;
  };
  const inheritedSystemDir = process.env.PAN_SYSTEM_DIR;
  process.env.PAN_SYSTEM_DIR = path.join(root, 'incorrect-system');

  try {
    const result = await pollRunner({
      backend,
      config,
      loadedDomain,
      dependencies: {
        spawn: (command, args, options) => {
          launches.push({ command, args, options });
          queueMicrotask(() => child.emit('spawn'));
          return child;
        },
      },
    });

    assert.deepEqual(result.launched, [task.id]);
    assert.equal(launches.length, 1);
    assert.equal(launches[0].command, 'copilot');
    assert.deepEqual(launches[0].args.slice(0, configuredArgs.length), configuredArgs);
    assert.deepEqual(
      launches[0].args.slice(configuredArgs.length, configuredArgs.length + 2),
      ['--session-id', savedSessionId],
    );
    assert.equal(launches[0].args.includes('--prompt'), false);
    const interactiveIndex = launches[0].args.indexOf('--interactive');
    assert.equal(interactiveIndex, configuredArgs.length + 2);
    assert.match(
      launches[0].args[interactiveIndex + 1],
      new RegExp(`Work on Pan task ${task.id}: ${task.title}`),
    );
    assert.equal(launches[0].options.cwd, workingDirectory);
    assert.equal(launches[0].options.env.PAN_SYSTEM_DIR, expectedSystemDir);
    assert.equal(launches[0].options.env.PAN_SESSION_ID, savedSessionId);
    assert.equal(launches[0].options.env.PAN_TASK_ID, task.id);
    assert.deepEqual(
      {
        detached: launches[0].options.detached,
        stdio: launches[0].options.stdio,
        windowsHide: launches[0].options.windowsHide,
      },
      { detached: true, stdio: 'ignore', windowsHide: false },
    );
    assert.equal(unrefCalled, true);

    const savedTask = await backend.get(task.id);
    assert.equal(savedTask.sessionId, savedSessionId);
    const run = JSON.parse(await readFile(
      path.join(config.stateRoot, 'tasks', encodeURIComponent(task.id), 'run.json'),
      'utf8',
    ));
    assert.equal(run.sessionId, savedSessionId);
  } finally {
    if (inheritedSystemDir === undefined) {
      delete process.env.PAN_SYSTEM_DIR;
    } else {
      process.env.PAN_SYSTEM_DIR = inheritedSystemDir;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test('runner config reserves runner-managed session and prompt options', () => {
  const base = {
    backendConfig: path.resolve('backend.json'),
    stateRoot: path.resolve('state'),
    machine: 'test-machine',
  };
  const conflicts = [
    ['--session-id', 'session-id'],
    ['--session-id=session-id'],
    ['--resume', 'session-id'],
    ['--resume=session-id'],
    ['-r', 'session-id'],
    ['-rsession-id'],
    ['--continue'],
    ['--continue=true'],
    ['--prompt', 'custom prompt'],
    ['--prompt=custom prompt'],
    ['-p', 'custom prompt'],
    ['-pcustom prompt'],
    ['--interactive', 'custom prompt'],
    ['--interactive=custom prompt'],
    ['-i', 'custom prompt'],
    ['-icustom prompt'],
  ];
  for (const args of conflicts) {
    assert.throws(
      () => validateRunnerConfig({
        ...base,
        launchCommand: ['copilot', ...args],
      }),
      /must not override the runner-managed session or prompt/,
    );
  }

  const launchCommand = [
    'copilot',
    '--model=gpt-5.6-sol',
    '-xattached',
    '--agent',
    'pan-worker',
  ];
  assert.deepEqual(
    validateRunnerConfig({ ...base, launchCommand }).launchCommand,
    launchCommand,
  );
});

test('blank Agent metadata does not close a live managed process', async () => {
  const { backend } = await createBackend();
  const task = await backend.create({
    title: 'Explicit release',
    playbook: 'pan',
    agentStatus: 'requested',
  });
  const root = await mkdtemp(path.join(os.tmpdir(), 'pan-simple-release-'));
  await mkdir(path.join(root, 'work'));
  const config = validateRunnerConfig({
    backendConfig: path.join(root, 'backend.json'),
    stateRoot: path.join(root, 'state'),
    workingDirectory: path.join(root, 'work'),
    machine: 'test-machine',
    launchCommand: ['copilot'],
  });
  const loadedDomain = {
    playbooks: new Map([['pan', {
      name: 'pan',
      description: 'Test',
      workingDirectory: path.join(root, 'work'),
      text: '# Pan',
    }]]),
    domainInstructions: '# Domain',
    domainRevision: 'reviewed-sha',
  };
  const live = new Set();
  const stopped = [];
  await pollRunner({
    backend,
    config,
    loadedDomain,
    dependencies: {
      processIsAlive: (pid) => live.has(pid),
      launchProcess: async () => {
        live.add(6000);
        return { pid: 6000, processStart: 'start' };
      },
      stopProcess: async (pid) => {
        stopped.push(pid);
        live.delete(pid);
      },
    },
  });
  await backend.update(task.id, { agentStatus: '' });
  await pollRunner({
    backend,
    config,
    loadedDomain,
    dependencies: {
      processIsAlive: (pid) => live.has(pid),
      stopProcess: async (pid) => {
        stopped.push(pid);
        live.delete(pid);
      },
    },
  });
  assert.deepEqual(stopped, []);
  assert.equal(live.has(6000), true);
  assert.equal((await backend.get(task.id)).agentStatus, 'running');

  live.delete(6000);
  await pollRunner({
    backend,
    config,
    loadedDomain,
    dependencies: {
      processIsAlive: (pid) => live.has(pid),
      stopProcess: async (pid) => {
        stopped.push(pid);
        live.delete(pid);
      },
    },
  });
  assert.deepEqual(stopped, []);
  assert.equal((await backend.get(task.id)).agentStatus, '');
  await rm(root, { recursive: true, force: true });
});

test('runner launches every requested task without duplicating managed tasks', async () => {
  const { backend } = await createBackend();
  const first = await backend.create({
    title: 'First request',
    playbook: 'pan',
    agentStatus: 'requested',
  });
  const second = await backend.create({
    title: 'Second request',
    playbook: 'pan',
    agentStatus: 'requested',
  });
  const root = await mkdtemp(path.join(os.tmpdir(), 'pan-simple-parallel-'));
  await mkdir(path.join(root, 'work'));
  const config = validateRunnerConfig({
    backendConfig: path.join(root, 'backend.json'),
    stateRoot: path.join(root, 'state'),
    workingDirectory: path.join(root, 'work'),
    machine: 'test-machine',
    launchCommand: ['copilot'],
  });
  const loadedDomain = {
    playbooks: new Map([['pan', {
      name: 'pan',
      description: 'Test',
      workingDirectory: path.join(root, 'work'),
      text: '# Pan',
    }]]),
    domainInstructions: '# Domain',
    domainRevision: 'reviewed-sha',
  };
  const live = new Set();
  let nextPid = 7000;
  const dependencies = {
    processIsAlive: (pid) => live.has(pid),
    launchProcess: async () => {
      const pid = nextPid++;
      live.add(pid);
      return { pid, processStart: `start-${pid}` };
    },
  };

  const launched = await pollRunner({
    backend,
    config,
    loadedDomain,
    dependencies,
  });
  assert.deepEqual(launched.launched, [first.id, second.id]);

  const repeated = await pollRunner({
    backend,
    config,
    loadedDomain,
    dependencies,
  });
  assert.deepEqual(repeated.launched, []);
  assert.equal(live.size, 2);
  await rm(root, { recursive: true, force: true });
});
