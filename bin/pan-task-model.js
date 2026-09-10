const HUMAN_ACTIONS = new Set(['clarify', 'discuss', 'approve', 'review', 'act']);
const LIFECYCLE = new Map([
  ['ready-for-human', HUMAN_ACTIONS],
  ['ready-for-ai', new Set(['execute'])],
  ['ai-executing', new Set(['execute'])],
  ['external-waiting', new Set(['wait'])],
  ['deliberate-hold', new Set(['hold'])],
  ['done', new Set(['none'])],
  ['rejected', new Set(['none'])],
]);

export const OUTCOME_STATES = [...LIFECYCLE.keys()];
export const NEXT_ACTIONS = [
  'clarify',
  'discuss',
  'approve',
  'review',
  'act',
  'execute',
  'wait',
  'hold',
  'none',
];
export const WORKER_STATES = [
  'idle',
  'starting',
  'running',
  'waiting-human',
  'checkpointed',
  'paused',
  'uncertain',
  'stopped',
];

export const CURRENT_ACTION_START = '<!-- pan-current-next-action:start -->';
export const CURRENT_ACTION_END = '<!-- pan-current-next-action:end -->';

export function isHumanAction(action) {
  return HUMAN_ACTIONS.has(action);
}

export function validLifecyclePair(status, action) {
  return LIFECYCLE.get(status)?.has(action) ?? false;
}

export function assertLifecyclePair(status, action) {
  if (!validLifecyclePair(status, action)) {
    throw new Error(`invalid task lifecycle pair: ${status || '(empty)'}/${action || '(empty)'}`);
  }
}

export function parseRevision(value) {
  if (value === '' || value == null) return 0;
  if (!/^(0|[1-9]\d*)$/.test(String(value))) {
    throw new Error(`task-revision must be a non-negative decimal integer (got ${JSON.stringify(value)})`);
  }
  const revision = Number(value);
  if (!Number.isSafeInteger(revision)) {
    throw new Error('task-revision exceeds the safe integer range');
  }
  return revision;
}

function cleanLine(value, maxLength) {
  return String(value ?? '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

export function renderCurrentActionBlock({
  status,
  action,
  detail,
  revision,
  updatedAt,
}) {
  assertLifecyclePair(status, action);
  const parsedRevision = parseRevision(revision);
  const updated = new Date(updatedAt);
  if (Number.isNaN(updated.valueOf())) throw new Error('updatedAt must be a valid timestamp');
  const actionDetail = cleanLine(detail, 2000);
  if (!actionDetail && status !== 'done' && status !== 'rejected') {
    throw new Error('current next-action detail must be non-empty for nonterminal work');
  }
  return [
    CURRENT_ACTION_START,
    '## Current next action',
    '',
    `- State: ${status}`,
    `- Action: ${action}`,
    `- Detail: ${actionDetail || (status === 'done' ? 'Outcome complete.' : 'Outcome rejected.')}`,
    `- Revision: ${parsedRevision}`,
    `- Updated: ${updated.toISOString()}`,
    CURRENT_ACTION_END,
  ].join('\n');
}

export function parseCurrentActionBlock(body) {
  const source = String(body ?? '');
  const start = source.indexOf(CURRENT_ACTION_START);
  const end = source.indexOf(CURRENT_ACTION_END);
  if (start < 0 && end < 0) return null;
  if (start < 0 || end < start) throw new Error('Issue has a malformed current-next-action block');
  if (source.indexOf(CURRENT_ACTION_START, start + CURRENT_ACTION_START.length) >= 0) {
    throw new Error('Issue has duplicate current-next-action blocks');
  }
  if (source.indexOf(CURRENT_ACTION_END, end + CURRENT_ACTION_END.length) >= 0) {
    throw new Error('Issue has duplicate current-next-action blocks');
  }
  const block = source.slice(start, end + CURRENT_ACTION_END.length);
  const field = (name) => {
    const match = new RegExp(`^- ${name}:\\s*(.*)$`, 'mi').exec(block);
    return match?.[1]?.trim() ?? '';
  };
  const parsed = {
    status: field('State'),
    action: field('Action'),
    detail: field('Detail'),
    revision: parseRevision(field('Revision')),
    updatedAt: field('Updated'),
    start,
    end: end + CURRENT_ACTION_END.length,
    block,
  };
  assertLifecyclePair(parsed.status, parsed.action);
  if (Number.isNaN(Date.parse(parsed.updatedAt))) {
    throw new Error('Issue current-next-action block has an invalid Updated timestamp');
  }
  return parsed;
}

export function upsertCurrentActionBlock(body, block) {
  const source = String(body ?? '');
  const existing = parseCurrentActionBlock(source);
  if (!existing) {
    return source.trimEnd()
      ? `${source.trimEnd()}\n\n${block}\n`
      : `${block}\n`;
  }
  return `${source.slice(0, existing.start)}${block}${source.slice(existing.end)}`;
}

export function transitionMarker(revision) {
  return `Pan: task transition ${parseRevision(revision)}`;
}

export function transitionComment({
  revision,
  fromStatus,
  fromAction,
  toStatus,
  toAction,
  detail,
  actor,
  claimGeneration,
}) {
  assertLifecyclePair(toStatus, toAction);
  const lines = [
    transitionMarker(revision),
    '',
    `- From: ${fromStatus || '(unmigrated)'}/${fromAction || '(unmigrated)'}`,
    `- To: ${toStatus}/${toAction}`,
    `- Detail: ${cleanLine(detail, 2000) || '(none)'}`,
    `- Actor: ${cleanLine(actor, 200) || 'Pan'}`,
  ];
  if (claimGeneration) lines.push(`- Claim generation: ${cleanLine(claimGeneration, 100)}`);
  return lines.join('\n');
}

export function isRecurringBody(body) {
  return /^## Recurrence\s*$/m.test(String(body ?? ''));
}

export function isTerminalStatus(status) {
  return status === 'done' || status === 'rejected';
}

export function runnableTask(item, fields) {
  const value = (name) => item.fields?.[name] ?? '';
  return (
    value(fields.status) === 'ready-for-ai'
    && value(fields.nextAction) === 'execute'
    && value(fields.executionAuthorized) === 'yes'
    && !String(value(fields.dependencies)).trim()
    && !isRecurringBody(item.issue?.body)
  );
}

export function derivePrimaryView(task, today, recentSince = null) {
  const status = task.status;
  const date = task.nextActionDate || '';
  if (!isTerminalStatus(status) && date === today) return 'today';
  if (status === 'ready-for-human' && (!date || date < today)) return 'needs-me';
  if (['ready-for-ai', 'ai-executing', 'external-waiting'].includes(status)) {
    return 'in-motion';
  }
  if (isTerminalStatus(status)) {
    if (!recentSince || !task.updatedAt || Date.parse(task.updatedAt) >= Date.parse(recentSince)) {
      return 'recent';
    }
  }
  return 'all-only';
}

export function legacyRecoveryTarget({ status, action, workerState }) {
  if (status === 'ready-for-human') {
    return { owner: 'human', status: action === 'clarify' ? 'needs-detail' : 'ready' };
  }
  if (status === 'ready-for-ai') return { owner: 'agent', status: 'ready' };
  if (status === 'ai-executing') {
    return {
      owner: 'agent',
      status: ['paused', 'checkpointed', 'uncertain'].includes(workerState)
        ? 'paused'
        : 'in-progress',
    };
  }
  if (status === 'external-waiting' || status === 'deliberate-hold') {
    return { owner: 'human', status: 'blocked' };
  }
  if (status === 'done' || status === 'rejected') {
    return { owner: 'unassigned', status };
  }
  throw new Error(`cannot translate unknown current state ${status}/${action}`);
}
