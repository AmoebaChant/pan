import { validLifecyclePair } from './pan-task-model.js';

function hasLiveLease(task, now) {
  if (!task.leaseUntil) return false;
  const lease = Date.parse(task.leaseUntil);
  return Number.isFinite(lease) && lease >= now;
}

export function translateLegacyTask(task, { now = Date.now() } = {}) {
  const owner = task.legacyOwner || 'unassigned';
  const status = task.status || 'untriaged';
  const base = {
    executionAuthorized: 'no',
    dependencies: task.dependencies || '',
    workerState: 'idle',
  };
  if (status === 'done' || status === 'rejected') {
    return {
      ...base,
      status,
      nextAction: 'none',
      workerState: 'stopped',
      detail: status === 'done' ? 'Outcome complete.' : 'Outcome rejected.',
    };
  }
  if (status === 'blocked') {
    return {
      ...base,
      status: 'external-waiting',
      nextAction: 'wait',
      workerState: task.sessionId ? 'checkpointed' : 'idle',
      detail: 'Confirm the external event or dependency this task is waiting for.',
    };
  }
  if (status === 'in-review') {
    return {
      ...base,
      status: 'ready-for-human',
      nextAction: 'review',
      workerState: task.sessionId ? 'checkpointed' : 'idle',
      detail: 'Review the durable artifact or result recorded on the Issue.',
    };
  }
  if (owner === 'agent' && ['ready', 'in-progress', 'paused'].includes(status)) {
    const executing = status !== 'ready';
    return {
      ...base,
      status: executing ? 'ai-executing' : 'ready-for-ai',
      nextAction: 'execute',
      executionAuthorized: 'yes',
      workerState: status === 'paused'
        ? 'paused'
        : status === 'in-progress'
          ? (hasLiveLease(task, now) ? 'running' : 'paused')
          : 'idle',
      detail: executing
        ? 'Continue the previously authorized playbook step.'
        : 'Run the previously authorized ready agent task.',
      // Any legacy in-progress task may still have a live launcher even when
      // its lease is missing or stale. Operational cutover must inventory it;
      // additive migration never guesses that the workspace is free.
      requiresCutoverHold: status === 'in-progress',
    };
  }
  if (status === 'needs-detail' || status === 'untriaged' || owner === 'unassigned') {
    return {
      ...base,
      status: 'ready-for-human',
      nextAction: 'clarify',
      detail: 'Clarify the stable outcome and exact next action.',
    };
  }
  return {
    ...base,
    status: 'ready-for-human',
    nextAction: 'act',
    workerState: task.sessionId ? 'checkpointed' : 'idle',
    detail: 'Perform or explicitly hand off the next action.',
  };
}

export function planLifecycleMigration(tasks, options = {}) {
  const actions = tasks.map((task) => {
    if (validLifecyclePair(task.status, task.nextAction)) {
      return {
        itemId: task.itemId,
        issueUrl: task.url,
        action: 'already-current',
        revision: task.revision,
      };
    }
    const target = translateLegacyTask(task, options);
    return {
      itemId: task.itemId,
      issueUrl: task.url,
      action: target.requiresCutoverHold ? 'requires-cutover-hold' : 'migrate',
      expected: {
        owner: task.legacyOwner || 'unassigned',
        status: task.status,
        claimedBy: task.claimedBy,
        leaseUntil: task.leaseUntil,
        machine: task.machine,
        sessionId: task.sessionId,
      },
      target,
      preserve: {
        nextActionDate: task.nextActionDate,
        deadline: task.deadline,
        priority: task.priority,
        playbook: task.playbook,
        workstream: task.workstream,
        machine: task.machine,
        sessionId: task.sessionId,
      },
    };
  });
  return {
    format: 'pan-lifecycle-migration-plan',
    version: 1,
    generatedAt: new Date().toISOString(),
    actions,
    counts: Object.fromEntries(
      [...new Set(actions.map((action) => action.action))]
        .map((name) => [name, actions.filter((action) => action.action === name).length]),
    ),
  };
}

export async function applyLifecycleMigration(plan, store) {
  const results = [];
  let partial = false;
  for (const action of plan.actions) {
    if (action.action === 'already-current' || action.action === 'requires-cutover-hold') {
      results.push(action);
      if (action.action === 'requires-cutover-hold') partial = true;
      continue;
    }
    try {
      results.push(await store.migrateLegacyItem(action));
    } catch (error) {
      partial = true;
      results.push({
        itemId: action.itemId,
        outcome: 'failed',
        error: error.message,
      });
    }
  }
  return {
    format: 'pan-lifecycle-migration-report',
    version: 1,
    completedAt: new Date().toISOString(),
    partial,
    results,
  };
}
