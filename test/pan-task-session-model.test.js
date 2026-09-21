import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { GitHubTaskBackend } from '../bin/pan-github-task-backend.js';
import { runTaskCli } from '../bin/pan-task.js';
import {
  acquireRunnerLock,
  findNewCopilotSessionId,
  missingPlaybookRepairInstructions,
  pollRunner,
  resolveRequestedPlaybook,
  runRunner,
  validateRunnerConfig,
  waitForPollTrigger,
} from '../bin/pan-backend-runner.js';
import {
  loadBackendPlaybooks,
  loadBackendWorkstream,
} from '../bin/pan-backend-playbooks.js';

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

  async getItem(itemId) {
    return this.items.find((item) => item.id === itemId) ?? null;
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
  assert.equal(created.nextStep, '');

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

test('pan-task CLI forwards nextStep through update, get, and list', async () => {
  const transport = new MemoryGitHubTransport();
  const config = {
    backend: 'github',
    repository: 'example/domain',
    projectOwner: 'example',
    projectNumber: 1,
  };
  const backend = await new GitHubTaskBackend(config, { transport }).initialize();
  const created = await backend.create({
    title: 'Publish the reviewed change',
  });
  const dependencies = { backendConfig: config, transport };

  const updated = await runTaskCli([
    '--config',
    'unused.json',
    'update',
    created.id,
    '--input',
    '{"nextStep":"PR published - ready for review"}',
  ], dependencies);
  assert.equal(updated.nextStep, 'PR published - ready for review');
  assert.equal(updated.id, created.id);
  assert.equal(updated.sessionId, '');

  const fetched = await runTaskCli([
    '--config',
    'unused.json',
    'get',
    created.itemId,
  ], dependencies);
  assert.equal(fetched.nextStep, 'PR published - ready for review');

  const listed = await runTaskCli([
    '--config',
    'unused.json',
    'list',
  ], dependencies);
  assert.deepEqual(
    listed.map((task) => ({ id: task.id, nextStep: task.nextStep })),
    [{ id: created.id, nextStep: 'PR published - ready for review' }],
  );
});

test('task outcome alone keeps a session open and release preserves outcome and session', async () => {
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
  const stopped = [];
  let nextPid = 5000;
  const createdSessionId = '11111111-2222-4333-8444-555555555555';
  const dependencies = {
    processIsAlive: (pid) => livePids.has(pid),
    launchProcess: async ({ sessionId }) => {
      const pid = nextPid++;
      livePids.add(pid);
      launches.push({ pid, sessionId });
      return {
        pid,
        processStart: `start-${pid}`,
        sessionId: sessionId || createdSessionId,
      };
    },
    stopProcess: async (pid) => {
      stopped.push(pid);
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
  assert.equal(running.sessionId, createdSessionId);
  assert.equal(launches[0].sessionId, '');

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
  assert.deepEqual(stopped, [launches[0].pid]);
  assert.equal(closed.status, 'done');
  assert.equal(closed.agentStatus, '');
  assert.equal(closed.sessionId, run.sessionId);

  await backend.update(task.id, { agentStatus: 'requested' });
  await pollRunner({ backend, config, loadedDomain, dependencies });
  assert.equal(launches.length, 2);
  assert.equal(launches[1].sessionId, createdSessionId);

  await rm(root, { recursive: true, force: true });
});

test('new session discovery polls immediately and stops when workspace metadata appears', async () => {
  const copilotHome = await mkdtemp(path.join(os.tmpdir(), 'pan-copilot-home-'));
  const sessionsRoot = path.join(copilotHome, 'session-state');
  const existingId = '11111111-1111-4111-8111-111111111111';
  const createdId = '22222222-2222-4222-8222-222222222222';
  const sessionName = 'pan-worker-issue-1';
  await mkdir(path.join(sessionsRoot, existingId), { recursive: true });
  await writeFile(
    path.join(sessionsRoot, existingId, 'workspace.yaml'),
    `id: ${existingId}\nname: ${sessionName}\n`,
  );
  let delays = 0;
  try {
    const found = await findNewCopilotSessionId({
      env: {},
      knownSessionIds: new Set([existingId]),
      sessionName,
    }, {
      copilotHome,
      sessionDiscoveryAttempts: 3,
      inspectDelay: async () => {
        delays += 1;
        await mkdir(path.join(sessionsRoot, createdId));
        await writeFile(
          path.join(sessionsRoot, createdId, 'workspace.yaml'),
          `id: ${createdId}\nname: ${sessionName}\n`,
        );
      },
    });
    assert.equal(found, createdId);
    assert.equal(delays, 1);
  } finally {
    await rm(copilotHome, { recursive: true, force: true });
  }
});

test('default runner launch lets Copilot create and identify a fresh session', async () => {
  const { backend } = await createBackend();
  const task = await backend.create({
    title: 'Start promptly',
    playbook: 'pan',
    agentStatus: 'requested',
  });
  const root = await mkdtemp(path.join(process.cwd(), '.pan-fresh-launch-'));
  const copilotHome = path.join(root, 'copilot-home');
  const sessionsRoot = path.join(copilotHome, 'session-state');
  const workingDirectory = path.join(root, 'work');
  const createdSessionId = '33333333-3333-4333-8333-333333333333';
  await mkdir(sessionsRoot, { recursive: true });
  await mkdir(workingDirectory);
  const config = validateRunnerConfig({
    backendConfig: path.join(root, 'backend.json'),
    stateRoot: path.join(root, 'state'),
    workingDirectory,
    machine: 'test-machine',
    launchCommand: ['copilot', '--model', 'gpt-5.6-sol', '--agent', 'pan-worker'],
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
  const child = new EventEmitter();
  child.pid = 8001;
  child.unref = () => {};

  try {
    const result = await pollRunner({
      backend,
      config,
      loadedDomain,
      dependencies: {
        copilotHome,
        platform: 'win32',
        execFile: async (command, args, options) => {
          assert.equal(command, 'powershell.exe');
          assert.equal(args.includes('-NonInteractive'), true);
          assert.equal(options.env.PAN_WORKER_PROCESS_MARKER, 'pan-worker-issue-1');
          return { stdout: '8101' };
        },
        inspectDelay: async () => {
          throw new Error('fresh launch should not wait after metadata is available');
        },
        spawn: (command, args, options) => {
          launches.push({ command, args, options });
          queueMicrotask(async () => {
            const launchSpec = JSON.parse(options.env.PAN_WINDOWS_WORKER_LAUNCH);
            const sessionName = launchSpec.args[
              launchSpec.args.indexOf('--name') + 1
            ];
            await mkdir(path.join(sessionsRoot, createdSessionId));
            await writeFile(
              path.join(sessionsRoot, createdSessionId, 'workspace.yaml'),
              `id: ${createdSessionId}\nname: ${sessionName}\n`,
            );
            child.emit('spawn');
          });
          return child;
        },
      },
    });

    assert.deepEqual(result.launched, [task.id]);
    assert.equal(launches.length, 1);
    const launchSpec = JSON.parse(
      launches[0].options.env.PAN_WINDOWS_WORKER_LAUNCH,
    );
    assert.equal(launches[0].args.includes('--session-id'), false);
    assert.equal(launches[0].args.includes('--name'), false);
    assert.equal(launchSpec.args.includes('--session-id'), false);
    assert.equal(launchSpec.args.includes('--name'), true);
    assert.equal(
      launchSpec.args[launchSpec.args.indexOf('--name') + 1],
      'pan-worker-issue-1',
    );
    assert.equal('PAN_SESSION_ID' in launches[0].options.env, false);
    const savedTask = await backend.get(task.id);
    assert.equal(savedTask.sessionId, createdSessionId);
    const taskRoot = path.join(
      config.stateRoot,
      'tasks',
      encodeURIComponent(task.id),
    );
    const snapshot = JSON.parse(await readFile(path.join(taskRoot, 'task.json'), 'utf8'));
    const run = JSON.parse(await readFile(path.join(taskRoot, 'run.json'), 'utf8'));
    assert.equal(snapshot.sessionId, createdSessionId);
    assert.equal(run.sessionId, createdSessionId);
    assert.equal(run.pid, 8101);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('default runner launch opens the saved session interactively', async () => {
  const { backend, transport } = await createBackend();
  const savedSessionId = '11111111-2222-4333-8444-555555555555';
  const created = await backend.create({
    title: 'Keep the "worker" open',
    playbook: 'pan',
    agentStatus: 'requested',
    sessionId: savedSessionId,
  });
  transport.items[0].content.title = 'Keep the "worker" open';
  const task = await backend.get(created.id);
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
        platform: 'win32',
        execFile: async (command, args, options) => {
          assert.equal(command, 'powershell.exe');
          assert.equal(args.includes('-NonInteractive'), true);
          assert.equal(options.env.PAN_WORKER_PROCESS_MARKER, savedSessionId);
          return { stdout: '8100' };
        },
        spawn: (command, args, options) => {
          launches.push({ command, args, options });
          queueMicrotask(() => child.emit('spawn'));
          return child;
        },
      },
    });

    assert.deepEqual(result.launched, [task.id]);
    assert.equal(launches.length, 1);
    assert.equal(launches[0].command, 'wt.exe');
    assert.deepEqual(launches[0].args.slice(0, 4), ['-w', 'new', 'nt', '--title']);
    assert.match(launches[0].args[4], /^Pan worker #1 /);
    assert.deepEqual(
      launches[0].args.slice(5, 12),
      [
        '-d',
        workingDirectory,
        'powershell.exe',
        '-NoLogo',
        '-NoProfile',
        '-EncodedCommand',
        launches[0].args[11],
      ],
    );
    const encodedScript = Buffer.from(
      launches[0].args[11],
      'base64',
    ).toString('utf16le');
    assert.match(encodedScript, /PAN_WINDOWS_WORKER_LAUNCH/);
    const launchSpec = JSON.parse(
      launches[0].options.env.PAN_WINDOWS_WORKER_LAUNCH,
    );
    assert.equal(launchSpec.command, 'copilot');
    assert.deepEqual(launchSpec.args.slice(0, configuredArgs.length), configuredArgs);
    assert.equal(launchSpec.args[configuredArgs.length], '--allow-all-paths');
    assert.deepEqual(
      launchSpec.args.slice(
        configuredArgs.length + 1,
        configuredArgs.length + 3,
      ),
      ['--add-dir', workingDirectory],
    );
    assert.deepEqual(
      launchSpec.args.slice(
        configuredArgs.length + 3,
        configuredArgs.length + 5,
      ),
      ['--session-id', savedSessionId],
    );
    assert.equal(launchSpec.args.includes('--name'), false);
    assert.equal(launchSpec.args.includes('--prompt'), false);
    const interactiveIndex = launchSpec.args.indexOf('--interactive');
    assert.equal(interactiveIndex, configuredArgs.length + 5);
    const prompt = launchSpec.args[interactiveIndex + 1];
    assert.match(
      prompt,
      new RegExp(`Work on Pan task ${task.id}: ${task.title}`),
    );
    assert.match(prompt, /\n/);
    assert.match(prompt, /"worker"/);
    assert.equal(launches[0].args.includes(prompt), false);
    assert.match(prompt, /persist the final task comment/i);
    assert.match(prompt, /set the justified work status to done or rejected/i);
    assert.match(prompt, /Re-read the live task and comments to verify/i);
    assert.match(prompt, /as the final action, create the exact empty .*worker-release\.json/i);
    assert.match(prompt, /Do not create the release file while waiting for the user/i);
    assert.match(prompt, /Changing the task work status alone does not close this session/i);
    assert.doesNotMatch(prompt, /only when .*early close/i);
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
    assert.equal(run.pid, 8100);
  } finally {
    if (inheritedSystemDir === undefined) {
      delete process.env.PAN_SYSTEM_DIR;
    } else {
      process.env.PAN_SYSTEM_DIR = inheritedSystemDir;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test('runner console reports startup and each poll summary', async () => {
  const { backend } = await createBackend();
  const root = await mkdtemp(path.join(os.tmpdir(), 'pan-runner-log-'));
  const configPath = path.join(root, 'runner.json');
  await writeFile(configPath, JSON.stringify({
    backendConfig: path.join(root, 'backend.json'),
    stateRoot: path.join(root, 'state'),
    workingDirectory: root,
    machine: 'test-machine',
    launchCommand: ['copilot'],
  }));
  const logs = [];
  try {
    const result = await runRunner(['--config', configPath, '--once'], {
      backend,
      loadBackendPlaybooks: async () => ({
        defaultPlaybook: {
          name: 'default',
          description: 'Test',
          workingDirectory: root,
          text: '# Default',
        },
        playbooks: new Map(),
        domainInstructions: '# Domain',
        domainRevision: 'reviewed-sha',
      }),
      log: (message) => logs.push(message),
    });
    assert.equal(result.observed, 0);
    assert.match(logs[0], /^runner started: machine=test-machine /);
    assert.equal(logs[1], 'press Enter to poll now');
    assert.equal(logs[2], 'polling task backend');
    assert.equal(
      logs[3],
      'poll complete: observed=0 requested=0 live=0 launched=0 closed=0 skipped=0',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('runner waits for its interval or an Enter-triggered poll', async () => {
  const input = new EventEmitter();
  let timerCallback;
  let cleared;
  const manual = waitForPollTrigger(300000, {
    input,
    setTimer: (callback) => {
      timerCallback = callback;
      return 42;
    },
    clearTimer: (timer) => {
      cleared = timer;
    },
  });
  input.emit('data', '\r');
  assert.equal(await manual, 'manual');
  assert.equal(cleared, 42);

  const timer = waitForPollTrigger(300000, {
    input,
    setTimer: (callback) => {
      queueMicrotask(callback);
      return 43;
    },
    clearTimer: () => {},
  });
  assert.equal(await timer, 'timer');
  assert.equal(input.listenerCount('data'), 0);
  assert.equal(typeof timerCallback, 'function');
});

test('runner defaults to a five-minute polling interval', () => {
  const root = path.resolve('runner-defaults');
  const config = validateRunnerConfig({
    backendConfig: path.join(root, 'backend.json'),
    stateRoot: path.join(root, 'state'),
    machine: 'test-machine',
    launchCommand: ['copilot'],
  });
  assert.equal(config.pollIntervalSeconds, 300);
});

test('manual polling starts a new five-minute interval', async () => {
  const { backend } = await createBackend();
  const root = await mkdtemp(path.join(os.tmpdir(), 'pan-runner-manual-poll-'));
  const configPath = path.join(root, 'runner.json');
  await writeFile(configPath, JSON.stringify({
    backendConfig: path.join(root, 'backend.json'),
    stateRoot: path.join(root, 'state'),
    workingDirectory: root,
    machine: 'test-machine',
    pollIntervalSeconds: 300,
    launchCommand: ['copilot'],
  }));
  const logs = [];
  const waits = [];
  let now = 1000;
  let waitCount = 0;
  try {
    await assert.rejects(
      runRunner(['--config', configPath], {
        backend,
        loadBackendPlaybooks: async () => ({
          defaultPlaybook: {
            name: 'default',
            description: 'Test',
            workingDirectory: root,
            text: '# Default',
          },
          playbooks: new Map(),
          domainInstructions: '# Domain',
          domainRevision: 'reviewed-sha',
        }),
        log: (message) => logs.push(message),
        now: () => now,
        waitForPollTrigger: async (milliseconds) => {
          waits.push(milliseconds);
          waitCount += 1;
          if (waitCount === 1) {
            now = 2000;
            return 'manual';
          }
          throw new Error('stop test runner');
        },
      }),
      /stop test runner/,
    );
    assert.deepEqual(waits, [300000, 300000]);
    assert.equal(logs.includes('manual poll requested'), true);
    assert.equal(
      logs.filter((message) => message === 'polling task backend').length,
      2,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('non-Windows runner launch inherits its interactive terminal', async () => {
  const { backend } = await createBackend();
  const task = await backend.create({
    title: 'Use the current terminal',
    agentStatus: 'requested',
  });
  const root = await mkdtemp(path.join(process.cwd(), '.pan-posix-launch-'));
  const workingDirectory = path.join(root, 'work');
  await mkdir(workingDirectory);
  const config = validateRunnerConfig({
    backendConfig: path.join(root, 'backend.json'),
    stateRoot: path.join(root, 'state'),
    workingDirectory,
    machine: 'test-machine',
    launchCommand: ['copilot'],
  });
  const child = new EventEmitter();
  child.pid = 8200;
  child.unref = () => {};
  let launch;
  try {
    await pollRunner({
      backend,
      config,
      loadedDomain: {
        defaultPlaybook: {
          name: 'default',
          description: 'Test',
          workingDirectory,
          text: '# Default',
        },
        playbooks: new Map(),
        domainInstructions: '# Domain',
        domainRevision: 'reviewed-sha',
      },
      dependencies: {
        platform: 'linux',
        listCopilotSessionIds: async () => new Set(),
        findNewCopilotSessionId: async () =>
          '77777777-7777-4777-8777-777777777777',
        spawn: (command, args, options) => {
          launch = { command, args, options };
          queueMicrotask(() => child.emit('spawn'));
          return child;
        },
      },
    });
    assert.equal(launch.command, 'copilot');
    assert.equal(launch.args.includes('--allow-all-paths'), true);
    assert.deepEqual(
      launch.args.slice(launch.args.indexOf('--add-dir'), launch.args.indexOf('--add-dir') + 2),
      ['--add-dir', workingDirectory],
    );
    assert.equal(launch.options.stdio, 'inherit');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('runner lock excludes a second live runner and replaces a stale lock', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pan-runner-lock-'));
  try {
    const release = await acquireRunnerLock(root, {
      processIsAlive: (pid) => pid === process.pid,
    });
    await assert.rejects(
      acquireRunnerLock(root, {
        processIsAlive: (pid) => pid === process.pid,
      }),
      /another runner is already active/,
    );
    await release();

    await writeFile(
      path.join(root, 'runner.lock'),
      `${JSON.stringify({ pid: 999999 })}\n`,
    );
    const releaseAfterStale = await acquireRunnerLock(root, {
      processIsAlive: () => false,
    });
    await releaseAfterStale();
    await assert.rejects(readFile(path.join(root, 'runner.lock')), { code: 'ENOENT' });
  } finally {
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
    ['--add-dir', path.resolve('other-work')],
    [`--add-dir=${path.resolve('other-work')}`],
    ['--allow-all-paths'],
    ['--allow-all-paths=true'],
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
    ['--name', 'custom name'],
    ['--name=custom name'],
    ['-n', 'custom name'],
    ['-ncustom name'],
  ];
  for (const args of conflicts) {
    assert.throws(
      () => validateRunnerConfig({
        ...base,
        launchCommand: ['copilot', ...args],
      }),
      /must not override runner-managed launch options/,
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
        return {
          pid: 6000,
          processStart: 'start',
          sessionId: '44444444-4444-4444-8444-444444444444',
        };
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
  const descriptiveOnly = await backend.create({
    title: 'Descriptive next step only',
    playbook: 'pan',
    nextStep: 'Awaiting a user decision',
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
      return {
        pid,
        processStart: `start-${pid}`,
        sessionId: `55555555-5555-4555-8555-${String(pid).padStart(12, '0')}`,
      };
    },
  };

  const launched = await pollRunner({
    backend,
    config,
    loadedDomain,
    dependencies,
  });
  assert.deepEqual(launched.launched, [first.id, second.id]);
  assert.equal((await backend.get(descriptiveOnly.id)).agentStatus, '');

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

test('runner resolver uses the default for blank and absent named assignments', () => {
  const root = path.resolve('configured-work');
  const defaultPlaybook = {
    name: 'default-playbook',
    description: 'General task work',
    workingDirectory: null,
    text: '# General',
  };
  const specialist = {
    name: 'delivery',
    description: 'Specialist delivery',
    workingDirectory: root,
    text: '# Delivery',
  };
  const loadedDomain = {
    defaultPlaybook,
    playbooks: new Map([['delivery', specialist]]),
  };
  const config = { workingDirectory: root };

  assert.deepEqual(
    resolveRequestedPlaybook('', loadedDomain, config),
    {
      available: true,
      playbook: defaultPlaybook,
      requestedName: '',
      source: 'default',
    },
  );
  assert.equal(
    resolveRequestedPlaybook('delivery', loadedDomain, config).playbook,
    specialist,
  );
  assert.deepEqual(
    resolveRequestedPlaybook('missing', loadedDomain, config),
    {
      available: true,
      playbook: defaultPlaybook,
      requestedName: 'missing',
      source: 'missing-default',
    },
  );
  const invalid = {
    name: 'broken',
    description: 'Broken specialist',
    workingDirectory: null,
    text: '# Broken',
  };
  assert.deepEqual(
    resolveRequestedPlaybook('broken', {
      defaultPlaybook,
      playbooks: new Map([['broken', invalid]]),
    }, { workingDirectory: '' }),
    {
      available: false,
      requestedName: 'broken',
      reason: 'playbook broken needs workingDirectory or runner workingDirectory',
      source: 'assigned',
    },
  );
});

test('missing-playbook repair instructions identify remote Domain provenance and configured alternatives', () => {
  const root = path.resolve('configured-work');
  const text = missingPlaybookRepairInstructions({
    requestedName: 'missing-specialist',
    loadedDomain: {
      defaultPlaybook: {
        name: 'default-playbook',
        description: 'General task work',
        workingDirectory: null,
        text: '# General',
      },
      playbooks: new Map([
        ['delivery', {
          name: 'delivery',
          description: 'Deliver a reviewed change',
          workingDirectory: root,
          text: '# Delivery',
        }],
      ]),
      domainRevision: 'loaded-sha',
    },
    config: {
      domainRepo: 'example/domain',
      domainRevision: 'configured-sha',
      workingDirectory: root,
    },
  });

  assert.match(text, /"missing-specialist" is unavailable on this runner/);
  assert.match(text, /Configured playbook definitions in this runner profile/);
  assert.match(text, /Clear the assignment to use the general default \(configured launch directory:/);
  assert.match(text, /delivery \(configured launch directory:.*configured-work\): Deliver a reviewed change/);
  assert.match(text, /report profile configuration, not runtime readiness/);
  assert.doesNotMatch(text, /currently usable|ready to run/i);
  assert.match(text, /Domain source: example\/domain/);
  assert.match(text, /Pinned Domain revision: configured-sha/);
  assert.match(text, /Loaded Domain instructions revision: loaded-sha/);
  assert.match(text, /Make this repair conversation the first task interaction/);
});

test('missing named requests open one repair-oriented default session without rewriting the task', async () => {
  const { backend } = await createBackend();
  const savedSessionId = '99999999-2222-4333-8444-555555555555';
  const task = await backend.create({
    title: 'Use a missing specialist',
    playbook: 'missing-specialist',
    agentStatus: 'requested',
    sessionId: savedSessionId,
  });
  const root = await mkdtemp(path.join(os.tmpdir(), 'pan-missing-default-'));
  const config = validateRunnerConfig({
    backendConfig: path.join(root, 'backend.json'),
    stateRoot: path.join(root, 'state'),
    workingDirectory: root,
    domainPath: path.join(root, 'reviewed-domain'),
    machine: 'test-machine',
    launchCommand: ['copilot'],
  });
  const loadedDomain = {
    defaultPlaybook: {
      name: 'default-playbook',
      description: 'General task work',
      workingDirectory: null,
      text: '# General',
    },
    playbooks: new Map([
      ['delivery', {
        name: 'delivery',
        description: 'Deliver a reviewed change',
        workingDirectory: root,
        text: '# Delivery',
      }],
      ['broken', {
        name: 'broken',
        description: 'Invalid local playbook',
        workingDirectory: 'relative',
        text: '# Broken',
      }],
      ['ghost', {
        name: 'ghost',
        description: 'Missing cwd definition',
        workingDirectory: path.join(root, 'does-not-exist'),
        text: '# Ghost',
      }],
    ]),
    domainInstructions: '# Domain',
    domainRevision: 'reviewed-sha',
  };
  const launches = [];
  const dependencies = {
    launchProcess: async (options) => {
      launches.push(options);
      return { pid: 9100, processStart: 'start' };
    },
    processIsAlive: () => false,
  };

  const launched = await pollRunner({
    backend,
    config,
    loadedDomain,
    dependencies,
  });
  assert.deepEqual(launched.launched, [task.id]);
  assert.deepEqual(launched.skipped, []);
  assert.equal(launches.length, 1);
  assert.equal(launches[0].sessionId, savedSessionId);
  const running = await backend.get(task.id);
  assert.equal(running.playbook, 'missing-specialist');
  assert.equal(running.sessionId, savedSessionId);
  assert.equal(running.agentStatus, 'running');

  const taskRoot = path.join(
    config.stateRoot,
    'tasks',
    encodeURIComponent(task.id),
  );
  const snapshotTask = JSON.parse(
    await readFile(path.join(taskRoot, 'task.json'), 'utf8'),
  );
  const playbookSnapshot = await readFile(
    path.join(taskRoot, 'playbook.md'),
    'utf8',
  );
  assert.equal(snapshotTask.playbook, 'missing-specialist');
  assert.match(playbookSnapshot, /Requested playbook unavailable on this runner/);
  assert.match(playbookSnapshot, /"missing-specialist" is unavailable on this runner/);
  assert.match(playbookSnapshot, /delivery \(configured launch directory:/);
  assert.doesNotMatch(playbookSnapshot, /broken: Invalid local playbook/);
  assert.ok(playbookSnapshot.includes(
    `- ghost (configured launch directory: ${path.join(root, 'does-not-exist')}): Missing cwd definition`,
  ));
  assert.match(playbookSnapshot, /profile configuration, not runtime readiness/);
  assert.doesNotMatch(playbookSnapshot, /currently usable|ready to run/i);
  assert.match(playbookSnapshot, /Domain source: local path .*reviewed-domain/);
  assert.match(playbookSnapshot, /Domain revision: reviewed-sha/);
  assert.match(playbookSnapshot, /Clear the assignment to use the general default \(configured launch directory:/);
  assert.match(playbookSnapshot, /Ask whether to clear or correct/);
  assert.match(playbookSnapshot, /Wait in this open session/);
  assert.match(playbookSnapshot, /Do not rewrite the task playbook/);
  assert.match(launches[0].prompt, /requested playbook "missing-specialist" is unavailable/);

  const repeated = await pollRunner({
    backend,
    config,
    loadedDomain,
    dependencies,
  });
  assert.deepEqual(repeated.launched, []);
  assert.equal(launches.length, 1);
  await rm(root, { recursive: true, force: true });
});

test('default playbook snapshots task context, workstream guidance, and configured cwd', async () => {
  const { backend } = await createBackend();
  const task = await backend.create({
    title: 'Discuss completed work',
    status: 'done',
    workstream: 'planning',
    agentStatus: 'requested',
  });
  const root = await mkdtemp(path.join(os.tmpdir(), 'pan-default-context-'));
  const domain = path.join(root, 'domain');
  const work = path.join(root, 'work');
  await mkdir(path.join(domain, 'playbooks', 'test-machine'), { recursive: true });
  await mkdir(path.join(domain, 'workstreams', 'planning'), { recursive: true });
  await mkdir(work);
  await writeFile(
    path.join(domain, 'playbooks', 'test-machine', 'delivery.md'),
    '---\nname: delivery\ndescription: Delivery\n---\n# Delivery\n',
  );
  await writeFile(path.join(domain, 'pan.md'), '# Domain instructions\n');
  await writeFile(
    path.join(domain, 'workstreams', 'planning', 'README.md'),
    '# Planning guidance\n',
  );
  const config = validateRunnerConfig({
    backendConfig: path.join(root, 'backend.json'),
    domainPath: domain,
    stateRoot: path.join(root, 'state'),
    workingDirectory: work,
    machine: 'test-machine',
    launchCommand: ['copilot'],
  });
  const loadedDomain = await loadBackendPlaybooks(config);
  const launches = [];

  const result = await pollRunner({
    backend,
    config,
    loadedDomain,
    dependencies: {
      launchProcess: async (options) => {
        launches.push(options);
        return {
          pid: 9200,
          processStart: 'start',
          sessionId: '66666666-6666-4666-8666-666666666666',
        };
      },
      processIsAlive: () => false,
    },
  });

  assert.deepEqual(result.launched, [task.id]);
  assert.equal(launches[0].cwd, work);
  const taskRoot = path.join(
    config.stateRoot,
    'tasks',
    encodeURIComponent(task.id),
  );
  const defaultText = await readFile(path.join(taskRoot, 'playbook.md'), 'utf8');
  assert.match(
    defaultText,
    /opening a done or rejected task may be for\s+discussion or follow-up/i,
  );
  assert.match(
    defaultText,
    /pan-task --config \$env:PAN_TASK_BACKEND_CONFIG update \$env:PAN_TASK_ID --input/,
  );
  assert.match(
    defaultText,
    /pan-task --config "\$PAN_TASK_BACKEND_CONFIG" update "\$PAN_TASK_ID" --input/,
  );
  assert.doesNotMatch(
    defaultText,
    /Requested playbook unavailable on this runner/,
  );
  assert.equal(
    await readFile(path.join(taskRoot, 'workstream.md'), 'utf8'),
    '# Planning guidance\n',
  );
  assert.match(
    launches[0].prompt,
    /Read workstream guidance .* when that snapshot is non-empty/,
  );
  assert.deepEqual(
    await loadBackendWorkstream(config, '', {}),
    { path: '', text: '', revision: null },
  );
  await rm(root, { recursive: true, force: true });
});
