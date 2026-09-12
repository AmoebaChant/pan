#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { isCliEntry } from './pan-task-backend.js';

function requireString(config, field) {
  const value = String(config[field] ?? '').trim();
  if (!value) throw new Error(`${field} is required`);
  return value;
}

export function buildChiefCommand(action, config) {
  if (!['start', 'resume'].includes(action)) {
    throw new Error('action must be start or resume');
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
    args.push(config.chiefSessionId
      ? '--session-id'
      : `--resume=${sessionName}`);
    if (config.chiefSessionId) args.push(String(config.chiefSessionId));
  }
  return {
    command,
    args,
    cwd: checkout,
    env: {
      ...process.env,
      PAN_CONFIG: configPath,
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
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  const built = buildChiefCommand(action, { ...config, configPath });
  if (values['print-command']) return built;
  const launch = dependencies.spawn || spawn;
  const child = launch(built.command, built.args, {
    cwd: built.cwd,
    env: built.env,
    stdio: 'inherit',
  });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve({ action, sessionName: config.chiefSessionName });
      else reject(new Error(`Copilot exited ${code ?? signal ?? 'unknown'}`));
    });
  });
}

if (isCliEntry(import.meta.url)) {
  runChief(process.argv.slice(2))
    .then((result) => {
      if (result?.help) {
        process.stdout.write('Usage: pan-chief <start|resume> --config <machine-binding.json>\n');
      } else if (result) {
        process.stdout.write(`${JSON.stringify({ ok: true, result })}\n`);
      }
    })
    .catch((error) => {
      process.stderr.write(`${JSON.stringify({ ok: false, error: { message: error.message } })}\n`);
      process.exitCode = 1;
    });
}
