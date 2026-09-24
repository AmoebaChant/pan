import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runChief } from '../bin/pan-chief.js';

const newId = '5534a7e6-648f-4ea3-abcd-1996d76df051';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pan-chief-fresh-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filename = path.join(root, 'binding.json');
  const config = {
    domainRepo: 'owner/domain',
    panCheckout: root,
    chiefCopilotHome: path.join(root, 'home'),
    chiefSessionName: 'pan-chief-owner-domain',
    chiefSessionId: 'old-session-id',
    taskBackendConfig: path.join(root, 'backend.json'),
    chiefArgs: [
      '--agent', 'pan-chief', '--interactive', 'Remember the previous conversation.',
      '--allow-all-tools', '--disallow-temp-dir',
    ],
  };
  const source = `${JSON.stringify(config, null, 2)}\n`;
  await writeFile(filename, source);
  return {
    root, filename, config, source,
    argv: ['fresh', '--config', filename],
    dependencies: {
      randomUUID: () => newId,
      execFile: async () => ({ stdout: '' }),
    },
  };
}

function childProcess(callback = () => {}) {
  const child = new EventEmitter();
  setImmediate(async () => {
    child.emit('spawn');
    try {
      await callback();
      child.emit('exit', 0, null);
    } catch (error) {
      child.emit('error', error);
    }
  });
  return child;
}

test('fresh previews neutral startup and does not change the binding', async (t) => {
  const f = await fixture(t);
  const built = await runChief([...f.argv, '--print-command'], f.dependencies);
  assert.equal(built.args[built.args.indexOf('--session-id') + 1], newId);
  assert.equal(built.args[built.args.indexOf('--model') + 1], 'gpt-5.6-sol');
  assert.equal(built.args[built.args.indexOf('--interactive') + 1],
    'You are the chief-of-staff Pan agent for Domain owner/domain.');
  assert.equal(built.args.filter((arg) => arg === '--agent').length, 1);
  assert.ok(!built.args.includes('Remember the previous conversation.'));
  assert.ok(built.args.includes('--allow-all-tools'));
  assert.equal(built.env.COPILOT_HOME, f.config.chiefCopilotHome);
  assert.equal(built.env.PAN_CHECKOUT, f.root);
  assert.equal(await readFile(f.filename, 'utf8'), f.source);
  assert.deepEqual(await readdir(f.root), ['binding.json']);
});

test('fresh changes the canonical id before spawn and retains old history and settings', async (t) => {
  const f = await fixture(t);
  const history = path.join(f.config.chiefCopilotHome, 'session-state', 'old-session-id');
  await mkdir(history, { recursive: true });
  await writeFile(path.join(history, 'events.jsonl'), 'old history\n');
  let launched;
  await runChief(f.argv, {
    ...f.dependencies,
    spawn: (command, args, options) => {
      launched = { command, args, options };
      return childProcess(async () => {
        const saved = JSON.parse(await readFile(f.filename, 'utf8'));
        assert.equal(saved.chiefSessionId, newId);
        assert.equal(saved.taskBackendConfig, f.config.taskBackendConfig);
        assert.ok(saved.chiefArgs.includes('--disallow-temp-dir'));
        assert.ok(!saved.chiefArgs.includes('Remember the previous conversation.'));
      });
    },
  });
  assert.equal(launched.options.env.PAN_CONFIG, f.filename);
  assert.equal(launched.options.env.PAN_CHECKOUT, f.root);
  assert.equal(await readFile(`${f.filename}.before-fresh-${newId}`, 'utf8'), f.source);
  assert.equal(await readFile(path.join(history, 'events.jsonl'), 'utf8'), 'old history\n');
  await assert.rejects(readFile(path.join(f.config.chiefCopilotHome, 'pan-chief-start.lock')),
    { code: 'ENOENT' });
  const resume = await runChief(['resume', '--config', f.filename, '--print-command']);
  assert.equal(resume.args[resume.args.indexOf('--session-id') + 1], newId);
});

test('fresh refuses an existing live chief without changing its binding', async (t) => {
  const f = await fixture(t);
  await assert.rejects(runChief(f.argv, {
    ...f.dependencies,
    execFile: async () => ({ stdout: 'copilot --session-id old-session-id\n' }),
    spawn: () => assert.fail('must not spawn'),
  }), /still running/);
  assert.equal(await readFile(f.filename, 'utf8'), f.source);
  assert.ok(!(await readdir(f.root)).some((name) => name.includes('before-fresh')));
});

test('fresh restores the original binding if spawning fails', async (t) => {
  for (const synchronous of [true, false]) {
    const f = await fixture(t);
    await assert.rejects(runChief(f.argv, {
      ...f.dependencies,
      spawn: () => {
        if (synchronous) throw new Error('missing executable');
        const child = new EventEmitter();
        setImmediate(() => child.emit('error', new Error('missing executable')));
        return child;
      },
    }), /missing executable/);
    assert.equal(await readFile(f.filename, 'utf8'), f.source);
  }
});

test('fresh preserves its new association after a spawned CLI exits unsuccessfully', async (t) => {
  const f = await fixture(t);
  await assert.rejects(runChief(f.argv, {
    ...f.dependencies,
    spawn: () => {
      const child = new EventEmitter();
      setImmediate(() => {
        child.emit('spawn');
        child.emit('exit', 1, null);
      });
      return child;
    },
  }), /Copilot exited 1/);
  assert.equal(JSON.parse(await readFile(f.filename, 'utf8')).chiefSessionId, newId);
});

test('fresh serializes launch preparation and refuses conversation-selection overrides', async (t) => {
  const f = await fixture(t);
  await mkdir(f.config.chiefCopilotHome);
  await writeFile(path.join(f.config.chiefCopilotHome, 'pan-chief-start.lock'), 'other\n');
  await assert.rejects(runChief(f.argv, f.dependencies), /already in progress/);
  assert.equal(await readFile(f.filename, 'utf8'), f.source);
  await writeFile(f.filename, JSON.stringify({ ...f.config, chiefArgs: ['--resume=other'] }));
  await assert.rejects(runChief([...f.argv, '--print-command'], f.dependencies),
    /cannot use --resume/);
});

test('fresh refuses concurrent binding edits and cleans up a failed atomic replacement', async (t) => {
  const f = await fixture(t);
  await assert.rejects(runChief(f.argv, {
    ...f.dependencies,
    execFile: async () => {
      await writeFile(f.filename, `${f.source}\n`);
      return { stdout: '' };
    },
    spawn: () => assert.fail('must not spawn'),
  }), /binding changed/);
  assert.equal(await readFile(f.filename, 'utf8'), `${f.source}\n`);

  await assert.rejects(runChief(f.argv, {
    ...f.dependencies,
    rename: async () => { throw new Error('replacement refused'); },
    spawn: () => assert.fail('must not spawn'),
  }), /replacement refused/);
  assert.equal(await readFile(f.filename, 'utf8'), `${f.source}\n`);
  assert.ok(!(await readdir(f.root)).some((name) => name.endsWith('.tmp')));
});
