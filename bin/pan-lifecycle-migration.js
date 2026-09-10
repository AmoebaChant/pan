import {
  legacyRecoveryTarget,
  parseRevision,
  rollbackSafetyReason,
  validLifecyclePair,
  WORKER_STATES,
} from './pan-task-model.js';

const ACTIVE_WORKER_STATES = new Set(['starting', 'running', 'waiting-human']);
const RETAINED_WORKER_STATES = new Set([
  'starting',
  'running',
  'waiting-human',
  'checkpointed',
  'paused',
  'uncertain',
]);
const LEGACY_STATUSES = new Set([
  'untriaged',
  'needs-detail',
  'ready',
  'in-progress',
  'paused',
  'in-review',
  'blocked',
  'done',
  'rejected',
]);

function hasCompleteResourceTuple(task) {
  return resourceTuple(task).every(Boolean);
}

function hasEmptyResourceTuple(task) {
  return resourceTuple(task).every((value) => !value);
}

function hasActiveOrUncertainEvidence(task) {
  return !!(
    task.claimedBy
    || task.leaseUntil
    || ACTIVE_WORKER_STATES.has(task.workerState)
    || task.workerState === 'uncertain'
  );
}

function hasDurableHoldEvidence(task) {
  if (
    task.bodyConflict
    || task.currentActionStatus !== 'deliberate-hold'
    || task.currentActionAction !== 'hold'
    || !String(task.nextActionDetail || '').trim()
  ) {
    return false;
  }
  let revision;
  try {
    revision = parseRevision(task.revision);
  } catch {
    return false;
  }
  return [revision, revision + 1].includes(task.currentActionRevision);
}

function passiveWorkerState(task, fallback) {
  if (['checkpointed', 'paused', 'stopped'].includes(task.workerState)) {
    return task.workerState;
  }
  return hasCompleteResourceTuple(task) ? fallback : 'idle';
}

function safeTerminalProvenance(task, status = task.status) {
  if (!['done', 'rejected'].includes(status)) return false;
  if (!hasCompleteResourceTuple(task)) return false;
  if (!['', 'historical-provenance'].includes(task.resourceSemantics || '')) return false;
  return (
    !hasActiveOrUncertainEvidence(task)
    && !task.needsHumanSince
    && ['', 'idle', 'stopped'].includes(task.workerState || '')
  );
}

function safeDeliberateHold(task, target) {
  if (target.status !== 'deliberate-hold' || !hasDurableHoldEvidence(task)) {
    return false;
  }
  if (!['', 'held-affinity'].includes(task.resourceSemantics || '')) return false;
  if (task.needsHumanSince) return false;
  if (hasActiveOrUncertainEvidence(task)) return false;
  if (!hasCompleteResourceTuple(task) && !hasEmptyResourceTuple(task)) return false;
  if (
    ['checkpointed', 'paused'].includes(task.workerState)
    && !hasCompleteResourceTuple(task)
  ) {
    return false;
  }
  return ['', 'idle', 'checkpointed', 'paused', 'stopped'].includes(task.workerState || '');
}

function hasLiveLease(task, now) {
  if (!task.leaseUntil) return false;
  const lease = Date.parse(task.leaseUntil);
  return Number.isFinite(lease) && lease >= now;
}

function authorizationMatches(task, authorization) {
  return !!(
    authorization
    && authorization.executionAuthorized === true
    && authorization.itemId === task.itemId
    && typeof authorization.playbook === 'string'
    && authorization.playbook
    && authorization.playbook === task.playbook
    && typeof authorization.dependencies === 'string'
    && authorization.dependencies === (task.dependencies || '')
  );
}

export function parseMigrationAuthorizations(document) {
  if (
    document?.format !== 'pan-lifecycle-migration-authorization'
    || document.version !== 1
    || !Array.isArray(document.items)
  ) {
    throw new Error('authorization file is not a Pan lifecycle migration authorization');
  }
  const seen = new Set();
  return document.items.map((entry) => {
    if (
      !entry
      || typeof entry.itemId !== 'string'
      || !entry.itemId
      || typeof entry.playbook !== 'string'
      || !entry.playbook
      || typeof entry.dependencies !== 'string'
      || entry.executionAuthorized !== true
    ) {
      throw new Error('every migration authorization must name itemId, playbook, dependencies, and executionAuthorized=true');
    }
    if (seen.has(entry.itemId)) {
      throw new Error(`duplicate migration authorization for ${entry.itemId}`);
    }
    seen.add(entry.itemId);
    return {
      itemId: entry.itemId,
      playbook: entry.playbook,
      dependencies: entry.dependencies,
      executionAuthorized: true,
    };
  });
}

export function translateLegacyTask(task, {
  now = Date.now(),
  authorization = null,
} = {}) {
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
    if (hasDurableHoldEvidence(task)) {
      return {
        ...base,
        status: 'deliberate-hold',
        nextAction: 'hold',
        workerState: passiveWorkerState(task, 'checkpointed'),
        detail: task.nextActionDetail,
      };
    }
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
    const explicitlyAuthorized = authorizationMatches(task, authorization);
    return {
      ...base,
      status: executing ? 'ai-executing' : 'ready-for-ai',
      nextAction: 'execute',
      executionAuthorized: explicitlyAuthorized ? 'yes' : 'no',
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
      requiresCutoverHold: status === 'in-progress' || status === 'paused' || !!task.sessionId,
      requiresAuthorization: !explicitlyAuthorized,
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

function currentLifecycleTarget(task) {
  const hasSession = !!(task.sessionId || task.machine || task.claimGeneration);
  let workerState = ['done', 'rejected'].includes(task.status)
    ? 'stopped'
    : task.workerState;
  if (!WORKER_STATES.includes(workerState)) {
    if (task.status === 'done' || task.status === 'rejected') workerState = 'stopped';
    else if (task.status === 'ai-executing') workerState = hasSession ? 'paused' : 'uncertain';
    else if (task.status === 'ready-for-ai') workerState = hasSession ? 'paused' : 'idle';
    else if (task.status === 'ready-for-human' && hasSession) workerState = 'checkpointed';
    else workerState = 'idle';
  }
  return {
    status: task.status,
    nextAction: task.nextAction,
    executionAuthorized: ['ready-for-ai', 'ai-executing'].includes(task.status) ? 'yes' : 'no',
    dependencies: task.dependencies || '',
    workerState,
    detail: task.nextActionDetail
      || (task.status === 'done'
        ? 'Outcome complete.'
        : task.status === 'rejected'
          ? 'Outcome rejected.'
          : 'Confirm the exact current next action.'),
    requiresCutoverHold: (
      task.status !== 'deliberate-hold'
      && hasSession
      && ['paused', 'checkpointed', 'uncertain'].includes(workerState)
    ),
    requiresAuthorization: false,
  };
}

function resourceTuple(task) {
  return [
    task.machine || '',
    task.sessionId || '',
    task.claimGeneration || '',
  ];
}

function hasResourceEvidence(task) {
  return !!(
    resourceTuple(task).some(Boolean)
    || task.claimedBy
    || task.leaseUntil
    || task.needsHumanSince
    || RETAINED_WORKER_STATES.has(task.workerState)
  );
}

function invalidRuntimeReason(
  task,
  status = task.status,
  canonical = validLifecyclePair(task.status, task.nextAction),
) {
  const tuple = resourceTuple(task);
  const tupleComplete = tuple.every(Boolean);
  const tupleEmpty = tuple.every((value) => !value);
  const resourceSemantics = task.resourceSemantics || '';
  if (!['', 'historical-provenance', 'held-affinity'].includes(resourceSemantics)) {
    return 'resource-semantics is invalid';
  }
  if (
    resourceSemantics === 'historical-provenance'
    && !safeTerminalProvenance(task, status)
  ) {
    return 'historical provenance marker conflicts with the live task state';
  }
  if (
    resourceSemantics === 'held-affinity'
    && status !== 'deliberate-hold'
  ) {
    return 'held affinity marker conflicts with the live task state';
  }
  if ((canonical || ['done', 'rejected'].includes(status)) && !tupleComplete && !tupleEmpty) {
    return 'machine, session-id, and claim-generation must be all present or all empty';
  }
  if (
    ['done', 'rejected'].includes(status)
    && (
      task.claimedBy
      || task.leaseUntil
      || task.needsHumanSince
      || !['', 'idle', 'stopped'].includes(task.workerState || '')
    )
  ) {
    return 'terminal state retains active, uncertain, or contradictory worker evidence';
  }
  if (
    canonical
    &&
    status === 'ai-executing'
    && !tupleComplete
  ) {
    return 'ai-executing state has no complete workspace owner tuple';
  }
  if (
    canonical
    &&
    ACTIVE_WORKER_STATES.has(task.workerState)
    && (
      !tupleComplete
      || !task.claimedBy
      || !task.leaseUntil
    )
  ) {
    return 'executing/running state has no complete live owner tuple';
  }
  return '';
}

function invalidMigrationIssueStateReason(task, target) {
  if (
    task.issueState === 'CLOSED'
    && !['done', 'rejected'].includes(target.status)
  ) {
    return 'closed Issue conflicts with a nonterminal lifecycle and requires reconciliation';
  }
  return '';
}

function currentTupleComplete(task) {
  if (!validLifecyclePair(task.status, task.nextAction)) return false;
  let revision;
  try {
    revision = parseRevision(task.revision);
  } catch {
    return false;
  }
  if (revision < 1) return false;
  if (
    task.bodyConflict
    || task.currentActionStatus !== task.status
    || task.currentActionAction !== task.nextAction
    || task.currentActionRevision !== revision
  ) {
    return false;
  }
  if (!WORKER_STATES.includes(task.workerState)) return false;
  if (
    ['ready-for-ai', 'ai-executing'].includes(task.status)
      ? task.executionAuthorized !== 'yes'
      : task.executionAuthorized !== 'no'
  ) {
    return false;
  }
  const tuple = resourceTuple(task);
  if (tuple.some(Boolean) && !tuple.every(Boolean)) return false;
  if (
    tuple.every(Boolean)
    && ['done', 'rejected'].includes(task.status)
    && task.resourceSemantics !== 'historical-provenance'
  ) {
    return false;
  }
  if (
    tuple.every(Boolean)
    && task.status === 'deliberate-hold'
    && task.resourceSemantics !== 'held-affinity'
  ) {
    return false;
  }
  if (tuple.every((value) => !value) && task.resourceSemantics) return false;
  if (invalidRuntimeReason(task)) return false;
  if (
    ['done', 'rejected'].includes(task.status)
    && (
      task.nextActionDate
      || task.claimedBy
      || task.leaseUntil
      || task.workerState !== 'stopped'
      || task.issueState !== 'CLOSED'
      || task.issueStateReason !== (task.status === 'done' ? 'COMPLETED' : 'NOT_PLANNED')
    )
  ) {
    return false;
  }
  if (
    !['done', 'rejected'].includes(task.status)
    && task.issueState
    && task.issueState !== 'OPEN'
  ) {
    return false;
  }
  return true;
}

function expectedProjection(task) {
  return {
    projection: task.projection,
    owner: task.legacyOwner || 'unassigned',
    status: task.status,
    nextAction: task.nextAction,
    workerState: task.workerState,
    executionAuthorized: task.executionAuthorized,
    dependencies: task.dependencies,
    playbook: task.playbook,
    claimedBy: task.claimedBy,
    leaseUntil: task.leaseUntil,
    machine: task.machine,
    sessionId: task.sessionId,
    claimGeneration: task.claimGeneration,
    resourceSemantics: task.resourceSemantics,
    revision: task.revision,
    issueState: task.issueState,
    issueStateReason: task.issueStateReason,
  };
}

export function planLifecycleMigration(tasks, options = {}) {
  const authorizations = new Map(
    (options.authorizations ?? []).map((authorization) => [authorization.itemId, authorization]),
  );
  const actions = tasks.map((task) => {
    const alreadyCurrent = validLifecyclePair(task.status, task.nextAction);
    const target = alreadyCurrent
      ? currentLifecycleTarget(task)
      : translateLegacyTask(task, {
        ...options,
        authorization: authorizations.get(task.itemId),
      });
    const invalidReason = task.bodyConflict
      || invalidRuntimeReason(task)
      || invalidMigrationIssueStateReason(task, target);
    const passiveProvenance = safeTerminalProvenance(task, target.status)
      || safeDeliberateHold(task, target);
    const requiresCutoverHold = !passiveProvenance && (
      target.requiresCutoverHold
      || hasResourceEvidence(task)
    );
    if (currentTupleComplete(task) && !requiresCutoverHold && !invalidReason) {
      return {
        itemId: task.itemId,
        issueUrl: task.url,
        action: 'already-current',
        revision: task.revision,
      };
    }
    const requiresAuthorization = target.requiresAuthorization;
    return {
      itemId: task.itemId,
      issueUrl: task.url,
      action: invalidReason
        ? 'invalid-state'
        : requiresCutoverHold
        ? 'requires-cutover-hold'
        : requiresAuthorization
          ? 'requires-authorization'
          : alreadyCurrent
            ? 'repair-current'
            : 'migrate',
      ...(invalidReason ? { reason: invalidReason } : {}),
      expected: expectedProjection(task),
      target,
      preserve: {
        nextActionDate: task.nextActionDate,
        deadline: task.deadline,
        priority: task.priority,
        playbook: task.playbook,
        workstream: task.workstream,
        machine: task.machine,
        sessionId: task.sessionId,
        claimGeneration: task.claimGeneration,
        resourceSemantics: safeTerminalProvenance(task, target.status)
          ? 'historical-provenance'
          : (
            target.status === 'deliberate-hold'
            && passiveProvenance
            && hasCompleteResourceTuple(task)
          )
            ? 'held-affinity'
            : '',
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
    if (
      action.action === 'already-current'
      || action.action === 'requires-cutover-hold'
      || action.action === 'requires-authorization'
      || action.action === 'invalid-state'
    ) {
      results.push(action);
      if (action.action !== 'already-current') partial = true;
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

function rollbackSource(task) {
  if (validLifecyclePair(task.status, task.nextAction)) {
    return {
      status: task.status,
      nextAction: task.nextAction,
      detail: task.nextActionDetail,
      legacyProjectState: false,
    };
  }
  if (
    LEGACY_STATUSES.has(task.status)
    && validLifecyclePair(task.currentActionStatus, task.currentActionAction)
  ) {
    return {
      status: task.currentActionStatus,
      nextAction: task.currentActionAction,
      detail: task.nextActionDetail,
      legacyProjectState: true,
    };
  }
  return null;
}

function rollbackInvalidReason(task, source) {
  if (!source) return 'task has neither a complete current pair nor a recoverable rollback projection';
  let revision;
  try {
    revision = parseRevision(task.revision);
  } catch {
    return 'task revision is invalid';
  }
  if (
    task.bodyConflict
    || task.currentActionStatus !== source.status
    || task.currentActionAction !== source.nextAction
    || ![revision, revision + 1].includes(task.currentActionRevision)
  ) {
    return 'Issue current-action projection does not match the rollback source';
  }
  const runtimeReason = rollbackSafetyReason(task, source.status);
  if (runtimeReason) return runtimeReason;
  if (
    ['done', 'rejected'].includes(source.status)
      ? (
        task.issueState !== 'CLOSED'
        || task.issueStateReason !== (source.status === 'done' ? 'COMPLETED' : 'NOT_PLANNED')
      )
      : task.issueState !== 'OPEN'
  ) {
    return 'Issue state cannot be reversed safely from the current live projection';
  }
  return '';
}

export function planLifecycleRollback(tasks) {
  const actions = tasks.map((task) => {
    const source = rollbackSource(task);
    const invalidReason = rollbackInvalidReason(task, source);
    let target = null;
    if (!invalidReason) {
      target = legacyRecoveryTarget({
        status: source.status,
        action: source.nextAction,
        workerState: task.workerState,
      });
    }
    const alreadyRolledBack = !!(
      target
      && source.legacyProjectState
      && task.status === target.status
      && (task.legacyOwner || 'unassigned') === target.owner
      && task.currentActionRevision === parseRevision(task.revision)
    );
    return {
      itemId: task.itemId,
      issueUrl: task.url,
      action: invalidReason
        ? 'invalid-state'
        : alreadyRolledBack
          ? 'already-rolled-back'
          : 'rollback',
      ...(invalidReason ? { reason: invalidReason } : {}),
      expected: expectedProjection(task),
      current: {
        status: task.status,
        nextAction: task.nextAction,
        workerState: task.workerState,
        revision: task.revision,
      },
      source: source && {
        status: source.status,
        nextAction: source.nextAction,
        detail: source.detail,
      },
      legacyTarget: target,
      preserve: {
        nextActionDate: task.nextActionDate,
        deadline: task.deadline,
        priority: task.priority,
        playbook: task.playbook,
        workstream: task.workstream,
        dependencies: task.dependencies,
        executionAuthorized: task.executionAuthorized,
        workerState: task.workerState,
        needsHumanSince: task.needsHumanSince,
        machine: task.machine,
        sessionId: task.sessionId,
        claimGeneration: task.claimGeneration,
        resourceSemantics: task.resourceSemantics,
      },
    };
  });
  return {
    format: 'pan-lifecycle-rollback-plan',
    version: 1,
    generatedAt: new Date().toISOString(),
    source: 'current-live-state',
    actions,
    counts: Object.fromEntries(
      [...new Set(actions.map((action) => action.action))]
        .map((name) => [name, actions.filter((action) => action.action === name).length]),
    ),
  };
}

export async function applyLifecycleRollback(plan, store) {
  const results = [];
  let partial = false;
  for (const action of plan.actions) {
    if (action.action !== 'rollback') {
      results.push(action);
      if (action.action !== 'already-rolled-back') partial = true;
      continue;
    }
    try {
      results.push(await store.rollbackLifecycleItem(action));
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
    format: 'pan-lifecycle-rollback-report',
    version: 1,
    completedAt: new Date().toISOString(),
    partial,
    results,
  };
}
