#!/usr/bin/env node

import readline from 'node:readline';
import { appendFile, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { isCliEntry } from './pan-task-backend.js';

function result(value, isError = false) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    ...(isError ? { isError: true } : {}),
  };
}

function schema(properties = {}, required = []) {
  return { type: 'object', properties, required, additionalProperties: false };
}

export const CHIEF_EVAL_TOOLS = [
  {
    name: 'get_binding',
    description: 'Read the synthetic Pan machine binding. This is the only configured Domain.',
    inputSchema: schema(),
  },
  {
    name: 'read_contract',
    description: 'Read one allowlisted Pan system contract by basename.',
    inputSchema: schema({ name: { type: 'string' } }, ['name']),
  },
  {
    name: 'read_domain_file',
    description: 'Read one file from the synthetic Domain, such as pan.md or task-backend.json.',
    inputSchema: schema({ path: { type: 'string' } }, ['path']),
  },
  {
    name: 'list_playbooks',
    description: 'List every playbook configured for the synthetic machine, including capacity.',
    inputSchema: schema(),
  },
  {
    name: 'read_playbook',
    description: 'Read one complete synthetic machine playbook before classifying tasks.',
    inputSchema: schema({ name: { type: 'string' } }, ['name']),
  },
  {
    name: 'task_list',
    description: 'List the complete authoritative in-scope task backend, including completed activity.',
    inputSchema: schema(),
  },
  {
    name: 'task_get',
    description: 'Re-read one in-scope task immediately before a write.',
    inputSchema: schema({ id: { type: 'string' } }, ['id']),
  },
  {
    name: 'task_update',
    description: 'Apply a checked synthetic task update using the production-style expectedRevision input.',
    inputSchema: schema({
      id: { type: 'string' },
      input: { type: 'object' },
    }, ['id', 'input']),
  },
  {
    name: 'task_reports',
    description: 'Read durable native reports for one synthetic task.',
    inputSchema: schema({ id: { type: 'string' } }, ['id']),
  },
  {
    name: 'task_report',
    description: 'Write an explicit chief report to one synthetic task.',
    inputSchema: schema({
      id: { type: 'string' },
      input: { type: 'object' },
    }, ['id', 'input']),
  },
  {
    name: 'runner_state',
    description: 'Read controlled synthetic runner capacity and active session state.',
    inputSchema: schema(),
  },
  {
    name: 'submit_assessment',
    description: 'Submit the complete planning-cycle evidence after reading every eligible task. Dispositions are the internal ledger for eligible nonterminal tasks only; completed activity may be mentioned in the summary but must not receive a disposition, candidate, or human-attention row. This records, but does not approve, the proposal.',
    inputSchema: schema({
      assessment: {
        type: 'object',
        properties: {
          summary: { type: 'string' },
          dispositions: {
            type: 'array',
            description: 'Exactly one internal disposition for every eligible nonterminal task, and no terminal/completed tasks.',
            items: {
              type: 'object',
              properties: {
                taskId: { type: 'string' },
                disposition: {
                  type: 'string',
                  enum: [
                    'engage-standing', 'propose-approval', 'already-engaged',
                    'blocked-missing-information', 'waiting-external', 'held',
                    'recurring-unsupported', 'unsuitable-ai',
                  ],
                },
                reason: { type: 'string' },
                nextStep: { type: 'string' },
              },
              required: ['taskId', 'disposition', 'reason', 'nextStep'],
            },
          },
          agentCandidates: {
            type: 'array',
            description: 'Useful proposed or requested engagements plus independently observed running work. Running work uses agentAction none, authorization already-requested, and queueState running; new/resume is only for an actual request or proposal.',
            items: {
              type: 'object',
              properties: {
                taskId: { type: 'string' },
                agentAction: { type: 'string', enum: ['none', 'request-new', 'request-resume', 'propose-new', 'propose-resume'] },
                authorization: { type: 'string', enum: ['standing', 'approval-required', 'already-requested'] },
                queueState: { type: 'string', enum: ['queued', 'running', 'proposed'] },
                reason: { type: 'string' },
              },
              required: ['taskId', 'agentAction', 'authorization', 'queueState', 'reason'],
            },
          },
          humanAttention: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                taskId: { type: 'string' },
                reason: { type: 'string' },
                directToTerminal: { type: 'boolean' },
              },
              required: ['taskId', 'reason', 'directToTerminal'],
            },
          },
        },
        required: ['summary', 'dispositions', 'agentCandidates', 'humanAttention'],
      },
    }, ['assessment']),
  },
];

async function atomicJson(filename, value) {
  const temporary = `${filename}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, filename);
}

export class RecordingEvalBackend {
  constructor(statePath, state) {
    this.statePath = statePath;
    this.state = state;
    this.operationsPath = path.join(path.dirname(statePath), 'operations.jsonl');
  }

  inScopeTasks() {
    return this.state.scenario.tasks.filter((task) => task.inScope !== false);
  }

  task(id) {
    const task = this.inScopeTasks().find((candidate) => candidate.id === id);
    if (!task) throw new Error(`task ${id} is outside synthetic scope`);
    return task;
  }

  publicTask(task) {
    const { reports, inScope, ...record } = task;
    return structuredClone(record);
  }

  async record(operation) {
    const entry = { sequence: this.state.operations.length + 1, ...operation };
    this.state.operations.push(entry);
    await appendFile(this.operationsPath, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    await atomicJson(this.statePath, this.state);
    return entry;
  }

  async list() {
    await this.record({ tool: 'task_list', kind: 'read' });
    return this.inScopeTasks().map((task) => this.publicTask(task));
  }

  async get(id) {
    await this.record({ tool: 'task_get', kind: 'read', taskId: id });
    return this.publicTask(this.task(id));
  }

  async update(id, input) {
    const task = this.task(id);
    await this.record({ tool: 'task_update', kind: 'write-attempt', taskId: id, input });
    if (input?.expectedRevision !== task.revision) {
      throw new Error(`task ${id} revision conflict`);
    }
    const keys = Object.keys(input).filter((key) => key !== 'expectedRevision');
    if (keys.length !== 1 || keys[0] !== 'attentionState') {
      throw new Error('synthetic task updates allow only attentionState');
    }
    if (input.attentionState !== 'requested') {
      throw new Error('synthetic planning cycle may only request agent attention');
    }
    if (task.completed || task.recurring || ['onHold', 'externalWaiting', 'needsHelp'].includes(task.attentionState)) {
      throw new Error(`task ${id} is not requestable`);
    }
    task.attentionState = 'requested';
    task.revision = `r${Number(task.revision.slice(1) || 0) + 1}`;
    await this.record({ tool: 'task_update', kind: 'write', taskId: id, input });
    return structuredClone(task);
  }

  async reports(id) {
    await this.record({ tool: 'task_reports', kind: 'read', taskId: id });
    return structuredClone(this.task(id).reports ?? []);
  }

  async report(id, input) {
    this.task(id);
    await this.record({ tool: 'task_report', kind: 'write', taskId: id, input });
    return { taskId: id, recorded: true };
  }
}

async function callTool(backend, name, args) {
  const scenario = backend.state.scenario;
  if (name === 'get_binding') {
    await backend.record({ tool: name, kind: 'read' });
    return {
      domainRepo: scenario.domain.repo,
      machine: scenario.domain.machine,
      lifecycleMode: 'attention-labels-v1',
      taskBackend: 'recording-eval',
    };
  }
  if (name === 'read_contract') {
    const filename = path.basename(String(args.name || ''));
    const value = backend.state.contracts[filename];
    if (value == null) throw new Error(`contract ${filename} is not allowlisted`);
    await backend.record({ tool: name, kind: 'read', path: filename });
    return { path: filename, content: value };
  }
  if (name === 'read_domain_file') {
    const value = scenario.domain.files[args.path];
    if (value == null) throw new Error(`synthetic Domain file not found: ${args.path}`);
    await backend.record({ tool: name, kind: 'read', path: args.path });
    return { path: args.path, content: value };
  }
  if (name === 'list_playbooks') {
    await backend.record({ tool: name, kind: 'read' });
    return scenario.playbooks.map(({ body, ...playbook }) => playbook);
  }
  if (name === 'read_playbook') {
    const playbook = scenario.playbooks.find((candidate) => candidate.name === args.name);
    if (!playbook) throw new Error(`playbook not found: ${args.name}`);
    await backend.record({ tool: name, kind: 'read', playbook: args.name });
    return playbook;
  }
  if (name === 'task_list') return backend.list();
  if (name === 'task_get') return backend.get(args.id);
  if (name === 'task_update') return backend.update(args.id, args.input);
  if (name === 'task_reports') return backend.reports(args.id);
  if (name === 'task_report') return backend.report(args.id, args.input);
  if (name === 'runner_state') {
    await backend.record({ tool: name, kind: 'read' });
    return structuredClone(scenario.runner);
  }
  if (name === 'submit_assessment') {
    const assessment = args.assessment;
    if (!assessment || !Array.isArray(assessment.dispositions)
      || !Array.isArray(assessment.agentCandidates)
      || !Array.isArray(assessment.humanAttention)) {
      throw new Error('assessment is incomplete');
    }
    await backend.record({ tool: name, kind: 'submission', assessment });
    backend.state.assessment = assessment;
    await atomicJson(backend.statePath, backend.state);
    return { recorded: true, dispositions: assessment.dispositions.length };
  }
  throw new Error(`unknown tool: ${name}`);
}

export function runChiefEvalMcp({ backend, input = process.stdin, output = process.stdout }) {
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  let pending = Promise.resolve();
  async function handleLine(line) {
    if (!line) return;
    const message = JSON.parse(line);
    if (message.method?.startsWith('notifications/')) return;
    let resultValue;
    try {
      if (message.method === 'initialize') {
        resultValue = {
          protocolVersion: message.params?.protocolVersion ?? '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'pan-chief-eval', version: '0.1.0' },
          instructions: 'This is an isolated synthetic Pan Domain. Use only these tools. Read get_binding, required contracts, Domain files, every playbook, the complete task list, reports, and runner state before submit_assessment. The task backend tools mirror Pan task operations. Never infer access to any real Domain.',
        };
      } else if (message.method === 'ping') {
        resultValue = {};
      } else if (message.method === 'tools/list') {
        resultValue = { tools: CHIEF_EVAL_TOOLS };
      } else if (message.method === 'tools/call') {
        resultValue = await callTool(backend, message.params?.name, message.params?.arguments ?? {});
        resultValue = result(resultValue);
      } else {
        throw new Error(`method not found: ${message.method}`);
      }
      if (message.id !== undefined) {
        output.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: resultValue })}\n`);
      }
    } catch (error) {
      if (message.id !== undefined) {
        output.write(`${JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          result: result({ error: error.message }, true),
        })}\n`);
      }
    }
  }
  lines.on('line', (line) => {
    pending = pending.then(() => handleLine(line)).catch((error) => {
      process.stderr.write(`pan-chief-eval-fixture: ${error.message}\n`);
    });
  });
}

export async function loadEvalBackend(statePath) {
  return new RecordingEvalBackend(statePath, JSON.parse(await readFile(statePath, 'utf8')));
}

async function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: { state: { type: 'string' } },
    strict: true,
  });
  if (!values.state || !path.isAbsolute(values.state)) {
    throw new Error('--state must be an absolute path');
  }
  runChiefEvalMcp({ backend: await loadEvalBackend(values.state) });
}

if (isCliEntry(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`pan-chief-eval-fixture: ${error.message}\n`);
    process.exitCode = 1;
  });
}
