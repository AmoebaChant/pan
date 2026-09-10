import { affinityMatchesMachine, splitAffinity } from './pan-runner-slots.js';
import { isRecurringBody, runnableTask } from './pan-task-model.js';

const PRIORITY_RANK = { urgent: 0, high: 1, normal: 2, low: 3 };

export const FIELD = {
  status: 'Status',
  owner: 'owner',
  nextAction: 'next-action',
  priority: 'priority',
  nextActionDate: 'next-action-date',
  deadline: 'deadline',
  playbook: 'playbook',
  workstream: 'workstream',
  executionAuthorized: 'execution-authorized',
  dependencies: 'dependencies',
  workerState: 'worker-state',
  needsHumanSince: 'needs-human-since',
  leaseUntil: 'lease-until',
  claimedBy: 'claimed-by',
  machine: 'machine',
  sessionId: 'session-id',
  claimGeneration: 'claim-generation',
  resourceSemantics: 'resource-semantics',
  taskRevision: 'task-revision',
};

export const val = (item, name, dflt = '') => (item.fields[name] ?? dflt);
export const ownerOf = (item) => val(item, FIELD.owner, 'unassigned') || 'unassigned';
export const statusOf = (item) => val(item, FIELD.status, 'untriaged') || 'untriaged';
export const actionOf = (item) => val(item, FIELD.nextAction, '');
export const workerStateOf = (item) => val(item, FIELD.workerState, '');
const priorityOf = (item) => val(item, FIELD.priority, 'normal') || 'normal';

export function findProjectItemForTask(items, task) {
  if (task.itemId) {
    const byItemId = items.find((item) => item.itemId === task.itemId);
    if (byItemId) return byItemId;
  }
  if (task.url) {
    return items.find((item) => item.issue?.url === task.url) || null;
  }
  if (task.repo && task.number) {
    return (
      items.find(
        (item) =>
          item.issue?.repo === task.repo &&
          item.issue?.number === task.number,
      ) || null
    );
  }
  return null;
}

export function pendingFinalizationKind({
  projectStatus,
  pendingStatus,
  claimedBy,
  identity,
  sweptEligible = false,
}) {
  if (projectStatus === 'ai-executing' && claimedBy === identity) return 'active';
  if (projectStatus === 'in-progress' && claimedBy === identity) return 'active';
  if (
    pendingStatus === projectStatus &&
    (!claimedBy || claimedBy === identity)
  ) {
    return 'terminal';
  }
  if (
    ['blocked', 'ready-for-human'].includes(projectStatus) &&
    (!claimedBy || claimedBy === identity)
  ) {
    return 'escalated';
  }
  // A paused item's pending result is finalizable only when it is unambiguously
  // our finished worker: a passive sweep leaves our claim intact, whereas an
  // unclaimed paused item is a manual pause. `sweptEligible` is the caller's
  // stronger session/machine/lease evidence that rules out a stray pause.
  if (
    projectStatus === 'paused' &&
    pendingStatus &&
    claimedBy === identity &&
    sweptEligible
  ) {
    return 'swept';
  }
  return null;
}

function parseLeaseTimestamp(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/.exec(value);
  if (!match) return null;

  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return null;

  const date = new Date(timestamp);
  const expected = match.slice(1, 7).map(Number);
  const actual = [
    date.getUTCFullYear(),
    date.getUTCMonth() + 1,
    date.getUTCDate(),
    date.getUTCHours(),
    date.getUTCMinutes(),
    date.getUTCSeconds(),
  ];
  return expected.every((part, index) => part === actual[index]) ? timestamp : null;
}

function leaseState(item, now) {
  const until = val(item, FIELD.leaseUntil, '');
  if (!until) return 'missing';
  const expiresAt = parseLeaseTimestamp(until);
  if (expiresAt == null) return 'malformed';
  return expiresAt < now ? 'expired' : 'active';
}

/** Whether an item's lease is unambiguously gone — missing or expired. A
 *  malformed value fails closed (returns false), so a restore/finalize gated on
 *  lease expiry never acts on a value it cannot read. */
export function leaseExpiredOrMissing(item, now = Date.now()) {
  const state = leaseState(item, now);
  return state === 'missing' || state === 'expired';
}

function itemLabel(item) {
  return item.issue?.number ? `#${item.issue.number}` : `Project item ${item.itemId}`;
}

function warnMalformedLease(item, consequence, warn) {
  warn(
    `warning: unparseable ${FIELD.leaseUntil} value ` +
    `${JSON.stringify(val(item, FIELD.leaseUntil, ''))} on ${itemLabel(item)}; ${consequence}`,
  );
}

/** Remove stale ownership from work that can no longer have a live worker. */
export async function cleanTerminalLeaseFields(
  items,
  {
    readItem,
    clearFields,
    warn = () => {},
  },
) {
  const terminalStatuses = new Set(['in-review', 'done', 'rejected', 'blocked', 'external-waiting']);
  const cleaned = [];

  for (const item of items) {
    if (
      val(item, FIELD.resourceSemantics, '') === 'historical-provenance'
      && (val(item, FIELD.claimedBy, '') || val(item, FIELD.leaseUntil, ''))
    ) {
      warn(
        `historical provenance has contradictory claim/lease evidence on ${itemLabel(item)}; ` +
        'leaving it untouched for operator reconciliation',
      );
      continue;
    }
    if (
      !terminalStatuses.has(statusOf(item)) ||
      (!val(item, FIELD.claimedBy, '') && !val(item, FIELD.leaseUntil, ''))
    ) {
      continue;
    }

    let fresh;
    try {
      fresh = await readItem(item.itemId);
    } catch (error) {
      warn(`terminal lease re-read failed for ${itemLabel(item)}: ${error.message}`);
      continue;
    }
    if (
      !fresh ||
      !terminalStatuses.has(statusOf(fresh)) ||
      (!val(fresh, FIELD.claimedBy, '') && !val(fresh, FIELD.leaseUntil, ''))
    ) {
      continue;
    }
    if (val(fresh, FIELD.resourceSemantics, '') === 'historical-provenance') {
      warn(
        `historical provenance has contradictory claim/lease evidence on ${itemLabel(fresh)}; ` +
        'leaving it untouched for operator reconciliation',
      );
      continue;
    }

    try {
      await clearFields(fresh.itemId);
      const confirmed = await readItem(fresh.itemId);
      if (
        !confirmed ||
        !terminalStatuses.has(statusOf(confirmed)) ||
        val(confirmed, FIELD.claimedBy, '') ||
        val(confirmed, FIELD.leaseUntil, '')
      ) {
        throw new Error('GitHub did not confirm terminal lease cleanup.');
      }
      cleaned.push(confirmed);
    } catch (error) {
      warn(`terminal lease cleanup failed for ${itemLabel(fresh)}: ${error.message}`);
    }
  }

  return cleaned;
}

/** Whether a claim can proceed without taking work from a live runner. */
export function leaseIsFree(item, identity, { now = Date.now(), warn = () => {} } = {}) {
  if (val(item, FIELD.claimedBy, '') === identity) return true;
  const state = leaseState(item, now);
  if (state === 'malformed') {
    warnMalformedLease(item, 'treating lease as occupied', warn);
    return false;
  }
  return state === 'missing' || state === 'expired';
}

/** The workspace slots occupied on this physical machine right now, scoped by
 *  playbook. Composite machine affinity is only meaningful together with the
 *  task's playbook (two playbooks may each define a `primary` slot pointing at
 *  different directories), so occupancy is keyed by playbook: the return value
 *  is a `Map<playbook, Set<slot id>>`. Use {@link occupiedSlotsForPlaybook} to
 *  read (and, for same-poll reservations, accumulate into) one playbook's set.
 *
 *  A slot is occupied by (a) any in-memory active worker recorded in that slot
 *  — including a finalization-pending worker whose directory is not yet free —
 *  and (b) any live Project item that is `in-progress` with a composite
 *  affinity for this machine and a lease that is not expired. A malformed lease
 *  fails closed (occupies); an expired lease frees its slot. This is sufficient
 *  for the one-runner-per-machine contract: it needs no process, PID, or
 *  filesystem rehydration. The physical same-directory active guard at claim
 *  time remains the final cross-playbook backstop. */
export function computeMachineSlotOccupancy({
  active,
  items,
  machine,
  now = Date.now(),
  warn = () => {},
}) {
  const occupied = new Map();
  const mark = (playbook, slot) => {
    if (!slot) return;
    let set = occupied.get(playbook);
    if (!set) {
      set = new Set();
      occupied.set(playbook, set);
    }
    set.add(slot);
  };
  for (const worker of active.values()) {
    if (worker.slot) mark(worker.playbook, worker.slot);
  }
  for (const item of items) {
    const { base, slot } = splitAffinity(val(item, FIELD.machine, ''));
    if (slot == null || base !== machine) continue;
    const status = statusOf(item);
    const workerState = workerStateOf(item);
    const newLifecycleOwned = [
      'starting',
      'running',
      'waiting-human',
      'checkpointed',
      'paused',
      'uncertain',
    ].includes(workerState) && !['done', 'rejected'].includes(status);
    if (!newLifecycleOwned && status !== 'in-progress') continue;
    if (newLifecycleOwned) {
      mark(val(item, FIELD.playbook, ''), slot);
      continue;
    }
    const state = leaseState(item, now);
    if (state === 'expired') continue;
    if (state === 'malformed') {
      warnMalformedLease(item, 'treating its workspace slot as occupied', warn);
    }
    mark(val(item, FIELD.playbook, ''), slot);
  }
  return occupied;
}

/** One playbook's occupied-slot set within a machine occupancy map, creating and
 *  storing an empty set when absent so same-poll reservations accumulate against
 *  the same object across the claim loop. */
export function occupiedSlotsForPlaybook(occupancy, playbook) {
  let set = occupancy.get(playbook);
  if (!set) {
    set = new Set();
    occupancy.set(playbook, set);
  }
  return set;
}

/** The confirming re-read after a claim write: we still own the item only when
 *  claimed-by, lease-until, machine, and session-id are the exact values we
 *  wrote and the Status is in-progress. Anything else means a foreign claim won
 *  the race. */
export function claimConfirmed(item, {
  identity,
  lease,
  machine,
  sessionId,
  claimGeneration = null,
  revision = null,
  status = 'in-progress',
}) {
  if (!item) return false;
  return (
    val(item, FIELD.claimedBy, '') === identity &&
    val(item, FIELD.leaseUntil, '') === lease &&
    val(item, FIELD.machine, '') === machine &&
    val(item, FIELD.sessionId, '') === sessionId &&
    (claimGeneration == null || val(item, FIELD.claimGeneration, '') === claimGeneration) &&
    (revision == null || val(item, FIELD.taskRevision, '') === String(revision)) &&
    statusOf(item) === status
  );
}

/** Restore truthful visibility for abandoned running work. */
async function sweepExpiredItems(
  items,
  {
    now,
    readItem,
    setPaused,
    setWorkerPaused,
    lifecycleVersion,
    isSupervised,
    warn,
  },
) {
  const current = [...items];
  const swept = [];

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const newLifecycle = lifecycleVersion === 2;
    const runningStatus = newLifecycle ? 'ai-executing' : 'in-progress';
    if (val(item, FIELD.resourceSemantics, '')) continue;
    if (statusOf(item) !== runningStatus || isSupervised(item)) continue;
    if (newLifecycle && !['starting', 'running', 'waiting-human'].includes(workerStateOf(item))) {
      continue;
    }

    const state = leaseState(item, now);
    if (state === 'malformed') {
      warnMalformedLease(item, 'leaving item in-progress', warn);
      continue;
    }
    if (state !== 'expired') continue;

    let fresh;
    try {
      fresh = await readItem(item.itemId);
    } catch (error) {
      warn(`stale lease re-read failed for ${itemLabel(item)}: ${error.message}`);
      continue;
    }
    if (!fresh) continue;

    current[index] = fresh;
    if (val(fresh, FIELD.resourceSemantics, '')) continue;
    if (statusOf(fresh) !== runningStatus || isSupervised(fresh)) continue;
    if (newLifecycle && !['starting', 'running', 'waiting-human'].includes(workerStateOf(fresh))) {
      continue;
    }

    const freshState = leaseState(fresh, now);
    if (freshState === 'malformed') {
      warnMalformedLease(fresh, 'leaving item in-progress', warn);
      continue;
    }
    if (freshState !== 'expired') continue;

    try {
      if (newLifecycle) await setWorkerPaused(fresh.itemId, fresh);
      else await setPaused(fresh.itemId, fresh);
    } catch (error) {
      warn(`passive pause failed for ${itemLabel(fresh)}: ${error.message}`);
      continue;
    }

    const paused = {
      ...fresh,
      fields: newLifecycle
        ? { ...fresh.fields, [FIELD.workerState]: 'paused' }
        : { ...fresh.fields, [FIELD.status]: 'paused' },
    };
    current[index] = paused;
    swept.push(paused);
  }

  return { items: current, swept };
}

/** Build the ordered work list for this machine's available playbooks. */
function selectCandidates(items, cfg, playbooks, active, { now, warn }) {
  const newLifecycle = cfg.lifecycleVersion === 2;
  const attentionPolicy = cfg.humanAttentionBackpressure ?? { mode: 'off', softLimit: Infinity };
  const localNow = new Date(now);
  const today = [
    localNow.getFullYear(),
    String(localNow.getMonth() + 1).padStart(2, '0'),
    String(localNow.getDate()).padStart(2, '0'),
  ].join('-');
  const humanAttentionCount = items.filter((item) => {
    if (statusOf(item) !== 'ready-for-human') return false;
    const date = val(item, FIELD.nextActionDate, '');
    return !date || date < today;
  }).length;
  const attentionLimited = (
    newLifecycle
    && attentionPolicy.mode === 'prefer-autonomous'
    && humanAttentionCount >= attentionPolicy.softLimit
  );

  const retainedResume = (item) => {
    const sessionId = val(item, FIELD.sessionId, '');
    const machine = val(item, FIELD.machine, '');
    const generation = val(item, FIELD.claimGeneration, '');
    const hasRetainedAffinity = !!(sessionId || machine || generation);
    if (!hasRetainedAffinity) return false;
    return (
      workerStateOf(item) === 'paused'
      && !!sessionId
      && !!machine
      && !!generation
      && affinityMatchesMachine(machine, cfg.machine)
    );
  };

  const canRun = (item, { resume = false } = {}) => {
    if (item.issue?.state !== 'OPEN') return false;
    if (['historical-provenance', 'held-affinity'].includes(
      val(item, FIELD.resourceSemantics, ''),
    )) {
      return false;
    }
    if (newLifecycle) {
      if (val(item, FIELD.executionAuthorized, '') !== 'yes') return false;
      if (String(val(item, FIELD.dependencies, '')).trim()) return false;
      if (isRecurringBody(item.issue?.body)) return false;
      if (!runnableTask(item, FIELD)) return false;
      const hasRetainedAffinity = !!(
        val(item, FIELD.sessionId, '')
        || val(item, FIELD.machine, '')
        || val(item, FIELD.claimGeneration, '')
      );
      if (hasRetainedAffinity && !resume) return false;
    } else if (ownerOf(item) !== 'agent') {
      return false;
    }
    const playbook = val(item, FIELD.playbook, '');
    if (!playbook || !playbooks.has(playbook)) return false;
    if (playbooks.get(playbook).capacity <= 0) return false;
    if (
      attentionLimited
      && !resume
      && (playbooks.get(playbook).humanAttention ?? 'may-request') !== 'autonomous'
    ) {
      return false;
    }
    if (!leaseIsFree(item, cfg.identity, { now, warn })) return false;
    if (active.has(item.itemId)) return false;
    return true;
  };

  const paused = newLifecycle
    ? items.filter((item) => retainedResume(item) && canRun(item, { resume: true }))
    : items.filter((item) =>
      statusOf(item) === 'paused'
      && affinityMatchesMachine(val(item, FIELD.machine, ''), cfg.machine)
      && !!val(item, FIELD.sessionId, '')
      && canRun(item, { resume: true }));
  const ready = items.filter((item) => {
    if (statusOf(item) !== (newLifecycle ? 'ready-for-ai' : 'ready')) return false;
    return canRun(item, { resume: false });
  });

  const byPriority = (a, b) => {
    const aRank = PRIORITY_RANK[priorityOf(a)] ?? 2;
    const bRank = PRIORITY_RANK[priorityOf(b)] ?? 2;
    if (aRank !== bRank) return aRank - bRank;
    return items.indexOf(a) - items.indexOf(b);
  };
  return [...paused, ...ready].sort(byPriority);
}

/** Reconcile stale claims before selecting work for the current poll. */
export async function preparePoll(
  items,
  {
    cfg,
    playbooks,
    active,
    now = Date.now(),
    readItem,
    setPaused,
    setWorkerPaused = setPaused,
    warn = () => {},
  },
) {
  const reconciled = await sweepExpiredItems(items, {
    now,
    readItem,
    setPaused,
    setWorkerPaused,
    lifecycleVersion: cfg.lifecycleVersion,
    isSupervised: (item) => active.has(item.itemId),
    warn,
  });
  return {
    ...reconciled,
    candidates: selectCandidates(reconciled.items, cfg, playbooks, active, { now, warn }),
  };
}
