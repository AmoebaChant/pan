import assert from 'node:assert/strict';
import test from 'node:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { fork } from 'node:child_process';
import path from 'node:path';
import {
  acquireLaunchLock,
  atomicWriteJson,
  createAttempt,
  defaultStateRoot,
  inspectProcess,
  parseWindowsProcessIdentityOutput,
  recoverAttemptCreation,
  releaseLaunchLock,
  scanAttempts,
  windowsProcessIdentityScript,
} from '../bin/pan-runner-runtime.js';

function sandbox() {
  const dir = mkdtempSync(path.join(process.cwd(), '.pan-runtime-test-'));
  const panDir = path.join(dir, '.pan');
  mkdirSync(panDir, { recursive: true });
  return { dir, panDir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function lockChild() {
  return fork(new URL('./fixtures/launch-lock-child.js', import.meta.url), {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
}

function nextChildMessage(child, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`child ${child.pid} did not complete within ${timeoutMs}ms`));
    }, timeoutMs);
    const onMessage = (message) => {
      cleanup();
      resolve(message);
    };
    const onExit = (code, signal) => {
      cleanup();
      reject(new Error(`child ${child.pid} exited before reporting (${code ?? signal})`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.off('message', onMessage);
      child.off('exit', onExit);
    };
    child.once('message', onMessage);
    child.once('exit', onExit);
  });
}

function childExit(child, timeoutMs = 10000) {
  if (child.exitCode != null || child.signalCode != null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`child ${child.pid} did not exit within ${timeoutMs}ms`)),
      timeoutMs,
    );
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

const EXPECTED = {
  sessionId: '11111111-1111-4111-8111-111111111111',
  itemId: 'PVTI_test',
  number: 25,
  machine: 'box',
  identity: 'box-runner-1',
};

async function seedAttempt(panDir, { pid, processStart, exited = false } = {}) {
  const created = await createAttempt(panDir, {
    ...EXPECTED,
    isolated: false,
    workingDir: path.join(process.cwd(), 'repo'),
    slot: null,
  });
  if (processStart) {
    await atomicWriteJson(path.join(created.attemptDir, 'owner.json'), {
      panRunnerOwner: true,
      version: 1,
      launchId: created.launchId,
      pid,
      processStart,
    });
  }
  if (exited) {
    await atomicWriteJson(path.join(created.attemptDir, 'exit.json'), {
      panRunnerExit: true,
      version: 1,
      launchId: created.launchId,
      exitedAt: new Date().toISOString(),
    });
  }
  return created;
}

test('durable state defaults follow each platform and are namespaced per runner', () => {
  const mac = defaultStateRoot('my-machine', 'runner-a', {
    platform: 'darwin',
    home: '/Users/me',
    env: {},
  });

  const linux = defaultStateRoot('my-machine', 'runner-a', {
    platform: 'linux',
    home: '/home/me',
    env: {},
  });
  const xdg = defaultStateRoot('my-machine', 'runner-a', {
    platform: 'linux',
    home: '/home/me',
    env: { XDG_STATE_HOME: '/state' },
  });
  const windows = defaultStateRoot('my-machine', 'runner-a', {
    platform: 'win32',
    home: 'C:\\Users\\me',
    env: { LOCALAPPDATA: 'D:\\Local' },
  });

  assert.match(mac, /^\/Users\/me\/Library\/Application Support\/Pan\/my-machine-/);
  assert.match(linux, /^\/home\/me\/\.local\/state\/pan\/my-machine-/);
  assert.match(xdg, /^\/state\/pan\/my-machine-/);
  assert.match(windows, /^D:\\Local\\Pan\\my-machine-/);
  assert.notEqual(
    defaultStateRoot('my-machine', 'runner-a', { platform: 'linux', home: '/home/me', env: {} }),
    defaultStateRoot('my-machine', 'runner-b', { platform: 'linux', home: '/home/me', env: {} }),
  );
});

test('the current launcher process has a repeatable start identity', async () => {
  const first = await inspectProcess(process.pid);
  const second = await inspectProcess(process.pid);
  assert.equal(first.state, 'live');
  assert.equal(second.state, 'live');
  assert.ok(first.identity);
  assert.equal(second.identity, first.identity);
});

test('Windows process identity parsing is canonical and keeps command metadata separate', async () => {
  const processStart = '638925947991234567';
  const command = 'node.exe launch.mjs --flag="line1\\nline2"\nchild metadata';
  const stdout = JSON.stringify({ processStart, command });
  const parsed = parseWindowsProcessIdentityOutput(stdout);
  assert.deepEqual(parsed, {
    identity: `win32:${processStart}`,
    command,
  });

  let invoked = null;
  const observed = await inspectProcess(process.pid, {
    platform: 'win32',
    run: async (executable, args) => {
      invoked = { executable, args };
      return { code: 0, stdout, stderr: '' };
    },
  });
  assert.equal(invoked.executable, 'powershell.exe');
  assert.equal(invoked.args.at(-1), windowsProcessIdentityScript(process.pid));
  assert.match(invoked.args.at(-1), /InvariantCulture/);
  assert.match(invoked.args.at(-1), /ConvertTo-Json/);
  assert.doesNotMatch(invoked.args.at(-1), /\\n/);
  assert.equal(observed.identity, `win32:${processStart}`);
  assert.equal(observed.command, command);
  assert.doesNotMatch(observed.identity, /node|launch|\\n|child/);

  const sb = sandbox();
  try {
    const attempt = await seedAttempt(sb.panDir, {
      pid: process.pid,
      processStart: parsed.identity,
    });
    const scan = await scanAttempts(sb.panDir, EXPECTED, {
      inspect: async () => observed,
    });
    assert.equal(scan.currentLaunchId, attempt.launchId);
    assert.equal(scan.live[0].owner.processStart, observed.identity);
    assert.equal(scan.live[0].observed.command, command);
  } finally {
    sb.cleanup();
  }
});

test('attempt liveness does not depend on worker.running', async () => {
  const sb = sandbox();
  try {
    const attempt = await seedAttempt(sb.panDir, { pid: 101, processStart: 'start-a' });
    assert.equal(existsSync(path.join(attempt.attemptDir, 'worker.running')), false);

    const scan = await scanAttempts(sb.panDir, EXPECTED, {
      inspect: async () => ({ state: 'live', identity: 'start-a' }),
    });
    assert.deepEqual(scan.live.map((entry) => entry.launchId), [attempt.launchId]);
    assert.equal(scan.uncertain.length, 0);
  } finally {
    sb.cleanup();
  }
});

test('PID reuse makes the recorded attempt dead rather than live', async () => {
  const sb = sandbox();
  try {
    await seedAttempt(sb.panDir, { pid: 202, processStart: 'original-start' });
    const scan = await scanAttempts(sb.panDir, EXPECTED, {
      inspect: async () => ({ state: 'live', identity: 'reused-start' }),
    });
    assert.equal(scan.live.length, 0);
    assert.equal(scan.dead.length, 1);
    assert.match(scan.dead[0].reason, /reused/);
  } finally {
    sb.cleanup();
  }
});

test('unverifiable ownership fails closed and overlapping live attempts remain distinct', async () => {
  const sb = sandbox();
  try {
    const first = await seedAttempt(sb.panDir, { pid: 301, processStart: 'start-301' });
    const second = await seedAttempt(sb.panDir, { pid: 302, processStart: 'start-302' });
    writeFileSync(path.join(first.attemptDir, 'needs-human.json'), '{"question":"first"}');
    writeFileSync(path.join(second.attemptDir, 'result.json'), '{"outcome":"done"}');

    const overlap = await scanAttempts(sb.panDir, EXPECTED, {
      inspect: async (pid) => ({ state: 'live', identity: `start-${pid}` }),
    });
    assert.equal(overlap.live.length, 2);
    assert.notEqual(overlap.live[0].signalDir, overlap.live[1].signalDir);

    const uncertain = await scanAttempts(sb.panDir, EXPECTED, {
      inspect: async (pid) => (
        pid === 301
          ? { state: 'unknown', reason: 'permission denied' }
          : { state: 'dead', reason: 'gone' }
      ),
    });
    assert.equal(uncertain.uncertain.length, 1);
    assert.equal(uncertain.live.length, 0);
  } finally {
    sb.cleanup();
  }
});

test('launch lock refuses a live owner and ignores stale generations without deleting replacements', async () => {
  const sb = sandbox();
  try {
    const inspect = async (pid) => {
      if (pid === 401) return { state: 'live', identity: 'runner-start' };
      if (pid === 402) return { state: 'live', identity: 'runner-two-start' };
      return { state: 'dead', reason: 'gone' };
    };
    const first = await acquireLaunchLock(sb.panDir, { inspect, pid: 401 });
    await assert.rejects(
      acquireLaunchLock(sb.panDir, { inspect, pid: 402 }),
      /held by live runner PID 401/,
    );
    await releaseLaunchLock(first);

    const lockDir = path.join(sb.panDir, 'launch.lock');
    mkdirSync(lockDir, { recursive: true });
    const staleToken = '22222222-2222-4222-8222-222222222222';
    writeFileSync(path.join(lockDir, `${staleToken}.json`), JSON.stringify({
      panRunnerLaunchLock: true,
      version: 1,
      token: staleToken,
      pid: 999,
      processStart: 'old',
      sequence: '000000000000000000000001',
      state: 'held',
    }));
    const replacement = await acquireLaunchLock(sb.panDir, { inspect, pid: 401 });
    const record = JSON.parse(readFileSync(replacement.claimPath, 'utf8'));
    assert.equal(record.token, replacement.token);
    assert.equal(
      existsSync(path.join(lockDir, `${staleToken}.json`)),
      true,
      'stale generations are immutable evidence, never a shared pathname to delete',
    );
    await releaseLaunchLock(replacement);
  } finally {
    sb.cleanup();
  }
});

test('launch lock has at most one winner under stale-takeover contention', async () => {
  const sb = sandbox();
  try {
    const lockDir = path.join(sb.panDir, 'launch.lock');
    mkdirSync(lockDir, { recursive: true });
    const staleToken = '33333333-3333-4333-8333-333333333333';
    writeFileSync(path.join(lockDir, `${staleToken}.json`), JSON.stringify({
      panRunnerLaunchLock: true,
      version: 1,
      token: staleToken,
      pid: 999999,
      processStart: 'stale',
      sequence: '000000000000000000000001',
      state: 'held',
    }));

    for (let round = 0; round < 100; round += 1) {
      const inspect = async (pid) => (
        pid === 999999
          ? { state: 'dead', reason: 'gone' }
          : { state: 'live', identity: `start-${pid}` }
      );
      let active = 0;
      let maxActive = 0;
      let successes = 0;
      const settled = await Promise.allSettled(
        Array.from({ length: 16 }, async (_, index) => {
          const lock = await acquireLaunchLock(sb.panDir, { inspect, pid: 1000 + index });
          successes += 1;
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise((resolve) => setTimeout(resolve, 1));
          active -= 1;
          await releaseLaunchLock(lock);
        }),
      );
      assert.ok(settled.some((result) => result.status === 'fulfilled'));
      assert.ok(successes >= 1, `round ${round} produced no successful acquisitions`);
      assert.equal(maxActive, 1, `round ${round} admitted ${maxActive} simultaneous holders`);
    }
  } finally {
    sb.cleanup();
  }
});

test('launch lock elects exactly one winner across 48 real processes', async () => {
  const sb = sandbox();
  const children = [];
  try {
    for (let index = 0; index < 48; index += 1) children.push(lockChild());
    const outcomes = children.map((child) => nextChildMessage(child, 20000));
    for (const child of children) child.send({ type: 'start', panDir: sb.panDir });
    const messages = await Promise.all(outcomes);
    const winners = messages
      .map((message, index) => ({ message, child: children[index] }))
      .filter(({ message }) => message.type === 'acquired');
    assert.equal(winners.length, 1, `expected one winner, got ${JSON.stringify(messages)}`);
    assert.equal(messages.filter((message) => message.type === 'failed').length, 47);

    const released = nextChildMessage(winners[0].child);
    winners[0].child.send({ type: 'release' });
    assert.equal((await released).type, 'released');
    await Promise.all(children.map((child) => childExit(child)));
  } finally {
    for (const child of children) {
      if (child.exitCode == null && child.signalCode == null) child.kill('SIGKILL');
    }
    sb.cleanup();
  }
});

test('launch lock recovers after real contender and holder crashes', async () => {
  const sb = sandbox();
  const children = [];
  try {
    const crashedContender = lockChild();
    children.push(crashedContender);
    const paused = nextChildMessage(crashedContender);
    crashedContender.send({
      type: 'start',
      panDir: sb.panDir,
      pauseAt: 'claim-written',
    });
    assert.equal((await paused).type, 'paused');
    crashedContender.kill('SIGKILL');
    await childExit(crashedContender);

    const crashedHolder = lockChild();
    children.push(crashedHolder);
    const acquired = nextChildMessage(crashedHolder);
    crashedHolder.send({ type: 'start', panDir: sb.panDir });
    assert.equal((await acquired).type, 'acquired');
    crashedHolder.kill('SIGKILL');
    await childExit(crashedHolder);

    const replacement = lockChild();
    children.push(replacement);
    const recovered = nextChildMessage(replacement);
    replacement.send({ type: 'start', panDir: sb.panDir });
    assert.equal((await recovered).type, 'acquired');
    const released = nextChildMessage(replacement);
    replacement.send({ type: 'release' });
    assert.equal((await released).type, 'released');
    await childExit(replacement);
  } finally {
    for (const child of children) {
      if (child.exitCode == null && child.signalCode == null) child.kill('SIGKILL');
    }
    sb.cleanup();
  }
});

test('ordinary attempt creation repairs every interrupted durable boundary', async () => {
  for (const boundary of [
    'before-manifest',
    'after-manifest',
    'after-attempt-directory',
    'after-attempt-metadata',
  ]) {
    const sb = sandbox();
    try {
      const metadata = {
        ...EXPECTED,
        isolated: false,
        workingDir: path.join(process.cwd(), 'repo'),
        slot: null,
      };
      await assert.rejects(
        createAttempt(sb.panDir, metadata, {
          checkpoint: async (current) => {
            if (current === boundary) throw new Error(`injected ${boundary} failure`);
          },
        }),
        new RegExp(`injected ${boundary} failure`),
      );
      const repaired = await createAttempt(sb.panDir, metadata);
      const repeated = await recoverAttemptCreation(sb.panDir, metadata);
      assert.ok(repeated);
      assert.equal(repeated.launchId, repaired.launchId);
      assert.equal(existsSync(path.join(repaired.attemptDir, 'attempt.json')), true);
      const manifest = JSON.parse(readFileSync(path.join(sb.panDir, 'attempts.json'), 'utf8'));
      assert.deepEqual(manifest.attempts.map((entry) => entry.launchId), [repaired.launchId]);
      assert.equal(manifest.attempts[0].kind, 'launch');
      assert.equal(manifest.attempts[0].creationKey, 'launch:1');
    } finally {
      sb.cleanup();
    }
  }
});

test('concurrent ordinary creators converge on one recoverable launch operation', async () => {
  const sb = sandbox();
  try {
    const metadata = {
      ...EXPECTED,
      isolated: false,
      workingDir: path.join(process.cwd(), 'repo'),
      slot: null,
    };
    let arrived = 0;
    let releaseCreators;
    const creatorsReady = new Promise((resolve) => { releaseCreators = resolve; });
    const checkpoint = async (boundary) => {
      if (boundary !== 'before-manifest') return;
      arrived += 1;
      if (arrived === 24) releaseCreators();
      await creatorsReady;
    };
    const settled = await Promise.allSettled(
      Array.from({ length: 24 }, () => createAttempt(sb.panDir, metadata, { checkpoint })),
    );
    assert.equal(
      settled.filter((result) => result.status === 'fulfilled').length,
      24,
      JSON.stringify(settled.filter((result) => result.status === 'rejected')),
    );

    const recovered = await recoverAttemptCreation(sb.panDir, metadata);
    assert.ok(recovered);
    const manifest = JSON.parse(readFileSync(path.join(sb.panDir, 'attempts.json'), 'utf8'));
    assert.equal(manifest.attempts.length, 1);
    assert.equal(manifest.currentLaunchId, recovered.launchId);
    assert.deepEqual(
      new Set(
        settled
          .filter((result) => result.status === 'fulfilled')
          .map((result) => result.value.launchId),
      ),
      new Set([recovered.launchId]),
    );
  } finally {
    sb.cleanup();
  }
});

test('durable attempt directories and files are private on POSIX', async (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX permission bits do not apply on Windows');
    return;
  }
  const sb = sandbox();
  try {
    const attempt = await seedAttempt(sb.panDir, {
      pid: process.pid,
      processStart: (await inspectProcess(process.pid)).identity,
    });
    assert.equal(statSync(path.join(sb.panDir, 'runs')).mode & 0o777, 0o700);
    assert.equal(statSync(attempt.attemptDir).mode & 0o777, 0o700);
    for (const file of [
      path.join(sb.panDir, 'attempts.json'),
      path.join(attempt.attemptDir, 'attempt.json'),
      path.join(attempt.attemptDir, 'owner.json'),
    ]) {
      assert.equal(statSync(file).mode & 0o777, 0o600, file);
    }
  } finally {
    sb.cleanup();
  }
});

test('attempt manifest fails closed when a recorded attempt directory is deleted', async () => {
  const sb = sandbox();
  try {
    const attempt = await seedAttempt(sb.panDir, { pid: 501, processStart: 'start-501' });
    rmSync(attempt.attemptDir, { recursive: true, force: true });

    const scan = await scanAttempts(sb.panDir, EXPECTED, {
      inspect: async () => ({ state: 'dead', reason: 'gone' }),
    });
    assert.equal(scan.uncertain.length, 1);
    assert.equal(scan.uncertain[0].launchId, attempt.launchId);
    assert.match(scan.uncertain[0].reason, /manifest.*missing from runs/);
  } finally {
    sb.cleanup();
  }
});

test('attempt manifest fails closed when a recorded attempt directory is renamed', async () => {
  const sb = sandbox();
  try {
    const attempt = await seedAttempt(sb.panDir, { pid: 502, processStart: 'start-502' });
    const replacementId = '44444444-4444-4444-8444-444444444444';
    renameSync(attempt.attemptDir, path.join(path.dirname(attempt.attemptDir), replacementId));

    const scan = await scanAttempts(sb.panDir, EXPECTED, {
      inspect: async () => ({ state: 'dead', reason: 'gone' }),
    });
    assert.equal(scan.uncertain.length, 2);
    assert.ok(scan.uncertain.some((entry) => entry.launchId === attempt.launchId));
    assert.ok(scan.uncertain.some((entry) => entry.launchId === replacementId));
  } finally {
    sb.cleanup();
  }
});

test('attempt manifest fails closed on malformed children and missing runs structure', async () => {
  const sb = sandbox();
  try {
    await seedAttempt(sb.panDir, { pid: 503, processStart: 'start-503' });
    writeFileSync(path.join(sb.panDir, 'runs', 'not-an-attempt'), 'corrupt');
    let scan = await scanAttempts(sb.panDir, EXPECTED, {
      inspect: async () => ({ state: 'dead', reason: 'gone' }),
    });
    assert.ok(scan.uncertain.some((entry) => /unexpected entry/.test(entry.reason)));

    rmSync(path.join(sb.panDir, 'runs'), { recursive: true, force: true });
    scan = await scanAttempts(sb.panDir, EXPECTED, {
      inspect: async () => ({ state: 'dead', reason: 'gone' }),
    });
    assert.equal(scan.uncertain.length, 1);
    assert.match(scan.uncertain[0].reason, /runs directory is unreadable/);
  } finally {
    sb.cleanup();
  }
});
