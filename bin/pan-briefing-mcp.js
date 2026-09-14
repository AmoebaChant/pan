#!/usr/bin/env node

import readline from 'node:readline';
import { pathToFileURL } from 'node:url';
import { BriefingBroker, createBriefingHttpServer } from './pan-briefing-service.js';

const TOOLS = [
  {
    name: 'publish_briefing',
    description: 'Publish a complete Daily Briefing proposal to the local review web app.',
    inputSchema: {
      type: 'object',
      properties: {
        proposal: {
          type: 'object',
          description: 'Complete renderable briefing snapshot.',
          properties: {
            briefingId: { type: 'string' },
            revision: { type: 'integer', minimum: 1 },
            summary: { type: 'string' },
            tasks: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  title: { type: 'string' },
                  group: {
                    type: 'string',
                    enum: ['today', 'agent-starts', 'needs-attention', 'not-today'],
                    description: 'Which visible plan group contains this task.',
                  },
                  recommendation: {
                    type: 'string',
                    description: 'Short recommendation such as "Do today" or "Not today".',
                  },
                  reason: {
                    type: 'string',
                    description: 'Why Pan currently recommends this task for its group.',
                  },
                  planningGuidance: {
                    type: ['string', 'null'],
                    description: 'Durable situational guidance read from the task.',
                  },
                  feedbackResponse: {
                    type: ['string', 'null'],
                    description: 'Unambiguous explanation of how Pan incorporated prior feedback.',
                  },
                  currentDate: { type: ['string', 'null'] },
                  proposedDate: { type: ['string', 'null'] },
                  humanDateAction: {
                    type: 'string',
                    enum: ['keep', 'set', 'clear'],
                    description: 'Explicit human-attention date effect. Keep is a no-op; clear is destructive.',
                  },
                  agentAction: {
                    type: 'string',
                    enum: ['none', 'request-new', 'request-resume'],
                    description: 'Explicit agent-engagement effect; never implies a human date write.',
                  },
                  agentAuthorization: {
                    type: 'string',
                    enum: ['none', 'standing', 'approval-required', 'already-requested'],
                    description: 'Whether the request is standing-authorized, discretionary, or already queued.',
                  },
                  playbook: { type: ['string', 'null'] },
                  workMode: { type: ['string', 'null'] },
                  expectedOutcome: { type: ['string', 'null'] },
                  laterHumanCheckpoint: { type: ['string', 'null'] },
                  checkpointPriority: {
                    type: 'string',
                    enum: ['none', 'today', 'later'],
                  },
                  requestedHumanAction: { type: ['string', 'null'] },
                  terminalContext: { type: ['string', 'null'] },
                  url: { type: ['string', 'null'] },
                },
                required: ['id', 'title', 'group', 'recommendation', 'reason'],
                additionalProperties: true,
              },
            },
          },
          required: ['briefingId', 'revision', 'tasks'],
          additionalProperties: true,
        },
      },
      required: ['proposal'],
      additionalProperties: false,
    },
  },
  {
    name: 'await_briefing_review',
    description: 'Wait for the user to approve or submit one complete review of a published briefing.',
    inputSchema: {
      type: 'object',
      properties: {
        briefingId: { type: 'string' },
        revision: { type: 'integer', minimum: 1 },
      },
      required: ['briefingId', 'revision'],
      additionalProperties: false,
    },
  },
  {
    name: 'complete_briefing',
    description: 'Publish the verified final outcome after an approved Daily Briefing is applied.',
    inputSchema: {
      type: 'object',
      properties: {
        result: {
          type: 'object',
          description: 'Final confirmed outcome to display.',
          properties: {
            status: { type: 'string', enum: ['confirmed', 'partial', 'failed'] },
            summary: { type: 'string' },
            confirmedHumanPlan: { type: 'array' },
            agentsLaunched: { type: 'array' },
            agentsQueued: { type: 'array' },
            waitingWorkers: { type: 'array' },
            partialFailures: { type: 'array' },
          },
          required: ['status'],
          additionalProperties: true,
        },
      },
      required: ['result'],
      additionalProperties: false,
    },
  },
];

function parseArgs(argv) {
  const options = { host: '127.0.0.1', port: 4318, demo: false };
  let portSpecified = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--host') {
      options.host = argv[++index];
    } else if (argument === '--port') {
      options.port = Number.parseInt(argv[++index], 10);
      portSpecified = true;
    } else if (argument === '--demo') {
      options.demo = true;
    } else if (argument === '--help') {
      process.stdout.write(
        [
          'Usage: node bin/pan-briefing-mcp.js [--host 127.0.0.1] [--port 4318]',
          '       node bin/pan-briefing-mcp.js --demo [--port 4319]',
          '',
        ].join('\n'),
      );
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  if (!options.host) throw new Error('--host requires a value');
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) {
    throw new Error('--port must be an integer from 0 through 65535');
  }
  if (options.demo && !portSpecified) options.port = 4319;
  return options;
}

const DEMO_TASKS = [
  {
    id: 'demo:estimate',
    title: 'Review the contractor estimate',
    recommendation: 'today',
    group: 'today',
    reason: 'It blocks scheduling and was carried over from yesterday.',
    currentDate: '2026-09-06',
    proposedDate: '2026-09-06',
  },
  {
    id: 'demo:appointment',
    title: 'Schedule the annual veterinary appointments',
    recommendation: 'today',
    group: 'today',
    reason: 'The preferred clinic tends to fill several weeks ahead.',
    currentDate: null,
    proposedDate: '2026-09-06',
  },
  {
    id: 'demo:notes',
    title: 'Organize notes from the product feedback interviews',
    recommendation: 'not today',
    group: 'not-today',
    reason: 'Useful work, but it does not need to displace today’s commitments.',
    currentDate: '2026-09-06',
    proposedDate: null,
    planningGuidance: 'Do this next week, preferably on a quiet day.',
  },
  {
    id: 'demo:worker',
    title: 'Check the worker waiting on a deployment decision',
    recommendation: 'Review the worker checkpoint later',
    group: 'needs-attention',
    reason: 'The worker is waiting for an explicit deployment decision.',
    currentDate: null,
    proposedDate: null,
    humanDateAction: 'keep',
    agentAction: 'none',
    agentAuthorization: 'already-requested',
    checkpointPriority: 'later',
    requestedHumanAction: 'Approve or decline the prepared deployment.',
    terminalContext: 'Open the associated worker terminal on its owning machine.',
  },
  {
    id: 'demo:agent-candidate',
    title: 'Investigate an intermittent export failure',
    url: 'https://example.test/tasks/export-failure',
    recommendation: 'Start a new agent conversation',
    group: 'agent-starts',
    reason: 'It is clear, useful, unblocked work even though it has no date, label, or session.',
    currentDate: null,
    proposedDate: null,
    humanDateAction: 'keep',
    agentAction: 'request-new',
    agentAuthorization: 'approval-required',
    workMode: 'investigation conversation',
    expectedOutcome: 'A reproduced failure and a bounded implementation recommendation.',
    laterHumanCheckpoint: 'Uncertain; only if the investigation finds a consequential choice.',
  },
];

export function createDemoProposal(revision = 1, review = null) {
  const requested = new Map((review?.tasks ?? []).map((task) => [task.id, task]));
  const tasks = DEMO_TASKS.map((task) => {
    const response = requested.get(task.id);
    if (!response || response.decision === 'accept') return { ...task };
    return {
      ...task,
      group: task.group === 'today' ? 'not-today' : task.group,
      recommendation: task.group === 'today' ? 'not today' : task.recommendation,
      proposedDate: task.group === 'today' ? null : task.proposedDate,
      humanDateAction: task.group === 'today' ? 'clear' : task.humanDateAction,
      planningGuidance: response.feedback || task.planningGuidance || null,
      feedbackResponse: response.feedback
        ? `Your guidance was incorporated: "${response.feedback}"`
        : 'Pan reconsidered the prior recommendation based on your disagreement.',
    };
  });
  return {
    briefingId: 'demo-briefing',
    revision,
    today: '2026-09-06',
    summary: review
      ? `Demo revision ${revision} incorporates the submitted task markup and overall steering.`
      : 'A realistic sample briefing for iterating on the review experience without live task data.',
    tasks,
  };
}

export async function runDemoLoop(broker) {
  let proposal = createDemoProposal();
  while (true) {
    broker.publish(proposal);
    const review = await broker.waitForReview(proposal.briefingId, proposal.revision);
    if (review.action === 'approve') {
      broker.complete({
        status: 'confirmed',
        mode: 'demo',
        message: 'Demo proposal approved. No external systems were read or changed.',
        approvedRevision: proposal.revision,
      });
      return;
    }
    proposal = createDemoProposal(proposal.revision + 1, review);
  }
}

function toolResult(value, isError = false) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    ...(isError ? { isError: true } : {}),
  };
}

async function callTool(broker, name, args) {
  if (name === 'publish_briefing') {
    return toolResult(broker.publish(args?.proposal));
  }
  if (name === 'await_briefing_review') {
    const review = await broker.waitForReview(args?.briefingId, args?.revision);
    return toolResult(review);
  }
  if (name === 'complete_briefing') {
    return toolResult(broker.complete(args?.result));
  }
  return toolResult({ error: `unknown tool: ${name}` }, true);
}

export function runMcpProtocol({
  broker,
  input = process.stdin,
  output = process.stdout,
  logger = console.error,
}) {
  const lines = readline.createInterface({ input, crlfDelay: Infinity });

  async function handle(message) {
    if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') return;
    if (message.method.startsWith('notifications/')) return;

    let result;
    try {
      if (message.method === 'initialize') {
        result = {
          protocolVersion: message.params?.protocolVersion ?? '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'pan-briefing', version: '0.1.0' },
          instructions: [
            'For Daily Briefing proposals, evaluate the complete eligible backlog and group each visible task as today, agent-starts, needs-attention, or not-today.',
            'Immediately after publishing any proposal or revision, show the user the clickable local review URL before calling await_briefing_review.',
            'If the user asks a side question while a revision awaits review, answer it and then resume await_briefing_review for that same revision unless the user explicitly pauses, cancels, or redirects the briefing.',
            'Make that recommendation before publishing: the user reviews your judgment and must not be given an undecided accept-or-postpone queue.',
            'Treat existing task dates as planning evidence rather than authoritative assignments for today.',
            'Reconsider every eligible nonterminal task every day, including future-dated, undated, unlabeled, and sessionless tasks.',
            'Use explicit humanDateAction, agentAction, agentAuthorization, and checkpointPriority effects. Missing agent date action never clears or sets a human date.',
            'Agent starts identify new versus resumed engagement, playbook or work mode, expected outcome, and honest later human checkpoint expectation.',
            'Treat vague deferral feedback as durable situational planning guidance stored in the authoritative task description or body under a Pan planning guidance: marker, not as permission to choose an arbitrary future date.',
            'Use feedbackResponse to state unambiguously how prior feedback changed the recommendation; never say the user accepted a recommendation they disagreed with.',
          ].join(' '),
        };
      } else if (message.method === 'ping') {
        result = {};
      } else if (message.method === 'tools/list') {
        result = { tools: TOOLS };
      } else if (message.method === 'tools/call') {
        result = await callTool(
          broker,
          message.params?.name,
          message.params?.arguments ?? {},
        );
      } else {
        output.write(`${JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32601, message: `method not found: ${message.method}` },
        })}\n`);
        return;
      }
      if (message.id !== undefined) {
        output.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`);
      }
    } catch (error) {
      if (message.method === 'tools/call' && message.id !== undefined) {
        output.write(`${JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          result: toolResult({ error: error.message }, true),
        })}\n`);
      } else if (message.id !== undefined) {
        output.write(`${JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32603, message: error.message },
        })}\n`);
      } else {
        logger(error);
      }
    }
  }

  lines.on('line', (line) => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      logger(`Ignoring invalid MCP JSON: ${error.message}`);
      return;
    }
    void handle(message);
  });

  return {
    close() {
      lines.close();
    },
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const broker = new BriefingBroker();
  const httpService = createBriefingHttpServer(broker);
  const address = await httpService.listen(options);
  console.error(`Pan briefing UI${options.demo ? ' demo' : ''}: ${address.url}`);
  if (options.demo) {
    void runDemoLoop(broker).catch((error) => {
      console.error(`pan-briefing demo: ${error.message}`);
    });
  } else {
    runMcpProtocol({ broker });
  }

  const shutdown = async () => {
    await httpService.close();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`pan-briefing: ${error.message}`);
    process.exitCode = 1;
  });
}
