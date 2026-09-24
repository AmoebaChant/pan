#!/usr/bin/env node

import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { isCliEntry } from './pan-task-backend.js';

function requireString(config, field) {
  const value = String(config[field] ?? '').trim();
  if (!value) throw new Error(`${field} is required`);
  return value;
}

function workspaceField(text, field) {
  const match = new RegExp(`^${field}:\\s*(.+?)\\s*$`, 'm').exec(text);
  return match?.[1] || null;
}

export async function findChiefSessions(config, dependencies = {}) {
  const read = dependencies.readFile || readFile;
  const list = dependencies.readdir || readdir;
  const copilotHome = path.resolve(config.chiefCopilotHome || path.join(os.homedir(), '.copilot'));
  const sessionsRoot = path.join(copilotHome, 'session-state');
  let entries;
  try {
    entries = await list(sessionsRoot, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw new Error(`cannot inventory Copilot sessions at ${sessionsRoot}: ${error.message}`);
  }
  const matches = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const filename = path.join(sessionsRoot, entry.name, 'workspace.yaml');
    let workspace;
    try {
      workspace = await read(filename, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw new Error(`cannot inspect Copilot session ${entry.name}: ${error.message}`);
    }
    const id = workspaceField(workspace, 'id');
    const name = workspaceField(workspace, 'name');
    if (name?.toLowerCase() === config.chiefSessionName.toLowerCase()) {
      matches.push({ id, name, filename });
    }
  }
  return matches;
}

export async function resolveChiefAction(action, config, dependencies = {}) {
  if (action === 'fresh') {
    return {
      action,
      config: {
        ...config,
        chiefSessionId: (dependencies.randomUUID || randomUUID)(),
        chiefArgs: freshChiefArgs(config),
      },
    };
  }
  if (action === 'start') {
    if (String(config.chiefSessionId || '').trim()) {
      throw new Error(
        `chief session ${config.chiefSessionId} is already configured; use resume`,
      );
    }
    const matches = await findChiefSessions(config, dependencies);
    if (matches.length > 0) {
      throw new Error(
        `chief session name ${config.chiefSessionName} already exists`
        + ` (${matches.map((match) => match.id || 'unknown-id').join(', ')});`
        + ' record its exact id and use resume',
      );
    }
    return { action, config };
  }
  if (action !== 'resume') throw new Error('action must be start, resume, or fresh');
  if (String(config.chiefSessionId || '').trim()) return { action, config };
  const matches = await findChiefSessions(config, dependencies);
  if (matches.length !== 1 || !matches[0].id) {
    throw new Error(
      `cannot resolve exactly one persisted chief session named ${config.chiefSessionName};`
      + ` found ${matches.length}`,
    );
  }
  return { action, config: { ...config, chiefSessionId: matches[0].id } };
}

function freshChiefArgs(config) {
  const args = config.chiefArgs ?? [];
  const retained = [];
  const replaced = new Set(['--agent', '--interactive', '-i', '--name', '--session-id']);
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index].split('=')[0];
    if (['--resume', '--continue', '-p', '--prompt'].includes(option)) {
      throw new Error(`fresh chief cannot use ${option} in chiefArgs`);
    }
    if (replaced.has(option)) {
      if (!args[index].includes('=')) index += 1;
    } else {
      retained.push(args[index]);
    }
  }
  return [
    ...retained,
    '--agent', 'pan-chief',
    '--interactive', `You are the chief-of-staff Pan agent for Domain ${requireString(config, 'domainRepo')}.`,
  ];
}

async function assertChiefStopped(config, dependencies) {
  const id = String(config.chiefSessionId || '').trim();
  if (!id) throw new Error('fresh requires a configured chiefSessionId; use start for initial setup');
  const run = dependencies.execFile || promisify(execFile);
  const { stdout } = process.platform === 'win32'
    ? await run('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_Process | ForEach-Object { $_.CommandLine }',
    ])
    : await run('ps', ['-ax', '-o', 'command=']);
  if (stdout.split(/\r?\n/).some((command) =>
    command.includes(id) && /--(?:session-id|resume)(?:=|\s)/.test(command))) {
    throw new Error('the current chief is still running; exit its terminal before using fresh');
  }
}

export function buildChiefCommand(action, config) {
  if (!['start', 'resume', 'fresh'].includes(action)) {
    throw new Error('action must be start, resume, or fresh');
  }
  const domainRepo = requireString(config, 'domainRepo');
  const checkout = path.resolve(requireString(config, 'panCheckout'));
  const sessionName = requireString(config, 'chiefSessionName');
  const configPath = path.resolve(requireString(config, 'configPath'));
  const command = String(config.copilotCommand || 'copilot');
  const directories = new Set([
    path.dirname(configPath),
    path.join(os.homedir(), '.config', 'pan'),
    ...(config.additionalDirectories ?? []).map((directory) => path.resolve(directory)),
  ]);
  const args = [
    '-C', checkout,
    '--model', 'gpt-5.6-sol',
    ...(config.chiefArgs ?? []),
  ];
  for (const directory of directories) {
    args.push('--add-dir', directory);
  }
  if (action === 'start') {
    args.push(
      '--agent', 'pan-chief',
      '--name', sessionName,
      '--interactive',
      `You are the chief-of-staff Pan agent for Domain ${domainRepo}.`,
    );
  } else {
    const sessionId = requireString(config, 'chiefSessionId');
    args.push('--session-id', sessionId);
    if (action === 'fresh') args.push('--name', sessionName);
  }
  return {
    command,
    args,
    cwd: checkout,
    env: {
      ...process.env,
      PAN_CONFIG: configPath,
      PAN_CHECKOUT: checkout,
      ...(config.chiefCopilotHome
        ? { COPILOT_HOME: path.resolve(config.chiefCopilotHome) }
        : {}),
    },
  };
}

export async function runChief(argv, dependencies = {}) {
  const action = argv[0];
  const { values } = parseArgs({
    args: argv.slice(1),
    options: {
      config: { type: 'string' },
      'print-command': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
  });
  if (values.help) return { help: true };
  if (!values.config) throw new Error('--config is required');
  const configPath = path.resolve(values.config);
  const read = dependencies.readFile || readFile;
  const source = await read(configPath, 'utf8');
  const config = JSON.parse(source);
  const resolved = await resolveChiefAction(
    action,
    { ...config, configPath },
    dependencies,
  );
  const built = buildChiefCommand(resolved.action, resolved.config);
  if (values['print-command']) return built;
  let startLock = null;
  if (action === 'start' || action === 'fresh') {
    const copilotHome = path.resolve(
      config.chiefCopilotHome || path.join(os.homedir(), '.copilot'),
    );
    const lockPath = path.join(copilotHome, 'pan-chief-start.lock');
    try {
      await (dependencies.mkdir || mkdir)(copilotHome, { recursive: true, mode: 0o700 });
      startLock = await (dependencies.open || open)(lockPath, 'wx', 0o600);
      await startLock.writeFile(`${process.pid}\n`);
    } catch (error) {
      if (error.code === 'EEXIST') {
        throw new Error(`another pan-chief start is already in progress (${lockPath})`);
      }
      throw error;
    }
  }
  async function releaseLock() {
    if (!startLock) return;
    const lock = startLock;
    startLock = null;
    await lock.close();
    const copilotHome = path.resolve(
      config.chiefCopilotHome || path.join(os.homedir(), '.copilot'),
    );
    await rm(path.join(copilotHome, 'pan-chief-start.lock'), { force: true });
  }
  const write = dependencies.writeFile || writeFile;
  const replace = dependencies.rename || rename;
  const newConfig = { ...config, chiefSessionId: resolved.config.chiefSessionId,
    chiefArgs: resolved.config.chiefArgs };
  const replacement = `${JSON.stringify(newConfig, null, 2)}\n`;
  const pendingPath = `${configPath}.fresh-${resolved.config.chiefSessionId}.tmp`;
  let pendingOwned = false;
  let bindingChanged = false;
  let didSpawn = false;
  const launch = dependencies.spawn || spawn;
  try {
    if (action === 'fresh') {
      await assertChiefStopped(config, dependencies);
      if (await read(configPath, 'utf8') !== source) {
        throw new Error('machine binding changed during fresh launch; retry after reconciling it');
      }
      await write(`${configPath}.before-fresh-${resolved.config.chiefSessionId}`, source,
        { flag: 'wx', mode: 0o600 });
      await write(pendingPath, replacement, { flag: 'wx', mode: 0o600 });
      pendingOwned = true;
      await replace(pendingPath, configPath);
      pendingOwned = false;
      bindingChanged = true;
    }
    const child = launch(built.command, built.args, {
      cwd: built.cwd,
      env: built.env,
      stdio: 'inherit',
    });
    const completion = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => {
        if (code === 0) resolve({ action, sessionName: config.chiefSessionName });
        else reject(new Error(`Copilot exited ${code ?? signal ?? 'unknown'}`));
      });
    });
    if (action !== 'fresh') return await completion;
    const started = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('spawn', () => {
        didSpawn = true;
        releaseLock().then(resolve, reject);
      });
    });
    const [result] = await Promise.all([completion, started]);
    return result;
  } catch (error) {
    if (bindingChanged && !didSpawn) {
      if (await read(configPath, 'utf8') !== replacement) {
        throw new Error(`fresh launch failed and the binding changed; restore from its before-fresh backup: ${error.message}`);
      }
      await write(pendingPath, source, { flag: 'wx', mode: 0o600 });
      pendingOwned = true;
      await replace(pendingPath, configPath);
      pendingOwned = false;
    }
    throw error;
  } finally {
    try {
      if (pendingOwned) await rm(pendingPath);
    } finally {
      await releaseLock();
    }
  }
}

if (isCliEntry(import.meta.url)) {
  runChief(process.argv.slice(2))
    .then((result) => {
      if (result?.help) {
        process.stdout.write('Usage: pan-chief <start|resume|fresh> --config <machine-binding.json>\n');
      } else if (result) {
        process.stdout.write(`${JSON.stringify({ ok: true, result })}\n`);
      }
    })
    .catch((error) => {
      process.stderr.write(`${JSON.stringify({ ok: false, error: { message: error.message } })}\n`);
      process.exitCode = 1;
    });
}
