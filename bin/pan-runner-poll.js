const PRIORITY_RANK = { urgent: 0, high: 1, normal: 2, low: 3 };

export const FIELD = {
  status: 'Status',
  owner: 'owner',
  priority: 'priority',
  nextActionDate: 'next-action-date',
  playbook: 'playbook',
  workstream: 'workstream',
  needsHumanSince: 'needs-human-since',
  leaseUntil: 'lease-until',
  claimedBy: 'claimed-by',
  machine: 'machine',
  sessionId: 'session-id',
};

export const val = (item, name, dflt = '') => (item.fields[name] ?? dflt);
export const ownerOf = (item) => val(item, FIELD.owner, 'unassigned') || 'unassigned';
export const statusOf = (item) => val(item, FIELD.status, 'untriaged') || 'untriaged';
const priorityOf = (item) => val(item, FIELD.priority, 'normal') || 'normal';

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

function itemLabel(item) {
  return item.issue?.number ? `#${item.issue.number}` : `Project item ${item.itemId}`;
}

function warnMalformedLease(item, consequence, warn) {
  warn(
    `warning: unparseable ${FIELD.leaseUntil} value ` +
    `${JSON.stringify(val(item, FIELD.leaseUntil, ''))} on ${itemLabel(item)}; ${consequence}`,
  );
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

/** Restore truthful visibility for abandoned running work. */
async function sweepExpiredItems(
  items,
  {
    now,
    readItem,
    setPaused,
    isSupervised,
    warn,
  },
) {
  const current = [...items];
  const swept = [];

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (statusOf(item) !== 'in-progress' || isSupervised(item)) continue;

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
    if (statusOf(fresh) !== 'in-progress' || isSupervised(fresh)) continue;

    const freshState = leaseState(fresh, now);
    if (freshState === 'malformed') {
      warnMalformedLease(fresh, 'leaving item in-progress', warn);
      continue;
    }
    if (freshState !== 'expired') continue;

    try {
      await setPaused(fresh.itemId);
    } catch (error) {
      warn(`passive pause failed for ${itemLabel(fresh)}: ${error.message}`);
      continue;
    }

    const paused = {
      ...fresh,
      fields: { ...fresh.fields, [FIELD.status]: 'paused' },
    };
    current[index] = paused;
    swept.push(paused);
  }

  return { items: current, swept };
}

/** Build the ordered work list for this machine's available playbooks. */
function selectCandidates(items, cfg, playbooks, active, { now, warn }) {
  const canRun = (item) => {
    if (ownerOf(item) !== 'agent') return false;
    const playbook = val(item, FIELD.playbook, '');
    if (!playbook || !playbooks.has(playbook)) return false;
    if (playbooks.get(playbook).capacity <= 0) return false;
    if (!leaseIsFree(item, cfg.identity, { now, warn })) return false;
    if (item.issue && active.has(item.issue.number)) return false;
    return true;
  };

  const paused = items.filter((item) =>
    statusOf(item) === 'paused'
    && val(item, FIELD.machine, '') === cfg.machine
    && !!val(item, FIELD.sessionId, '')
    && canRun(item),
  );
  const ready = items.filter((item) => statusOf(item) === 'ready' && canRun(item));

  const byPriority = (a, b) => {
    const aRank = PRIORITY_RANK[priorityOf(a)] ?? 2;
    const bRank = PRIORITY_RANK[priorityOf(b)] ?? 2;
    if (aRank !== bRank) return aRank - bRank;
    return items.indexOf(a) - items.indexOf(b);
  };
  paused.sort(byPriority);
  ready.sort(byPriority);
  return [...paused, ...ready];
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
    warn = () => {},
  },
) {
  const reconciled = await sweepExpiredItems(items, {
    now,
    readItem,
    setPaused,
    isSupervised: (item) => !!item.issue && active.has(item.issue.number),
    warn,
  });
  return {
    ...reconciled,
    candidates: selectCandidates(reconciled.items, cfg, playbooks, active, { now, warn }),
  };
}
