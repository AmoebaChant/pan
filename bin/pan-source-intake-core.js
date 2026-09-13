import { createHash } from 'node:crypto';

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RECEIPT_FORMAT = 'pan-source-intake-receipts';
const RECEIPT_VERSION = 1;

function requireRepository(value, label) {
  const repository = String(value ?? '').trim();
  if (!REPO_RE.test(repository)) {
    throw new Error(`${label} must be owner/repository`);
  }
  return repository;
}

function sourceAliases(source) {
  const nodeId = String(source.nodeId ?? '').trim();
  const url = String(source.url ?? '').trim().toLowerCase();
  return [
    nodeId ? `node:${nodeId}` : '',
    url ? `url:${url}` : '',
  ].filter(Boolean);
}

function canonicalIssueUrl(repository, number) {
  return `https://github.com/${repository}/issues/${number}`;
}

function normalizedIdentity(source) {
  return {
    repository: String(source.repository ?? '').trim().toLowerCase(),
    number: Number(source.number),
    nodeId: String(source.nodeId ?? '').trim(),
    url: String(source.url ?? '').trim().toLowerCase(),
  };
}

function sameSourceIdentity(left, right) {
  return JSON.stringify(normalizedIdentity(left)) === JSON.stringify(normalizedIdentity(right));
}

function receiptAliases(receipt) {
  return sourceAliases(receipt.source ?? {});
}

function matchingReceipts(ledger, source) {
  const aliases = new Set(sourceAliases(source));
  return ledger.receipts.filter((receipt) =>
    receiptAliases(receipt).some((alias) => aliases.has(alias)));
}

function deterministicRequestId(source, backend) {
  const seed = `${backend}\n${source.nodeId || source.url}`;
  const bytes = Buffer.from(createHash('sha256').update(seed).digest('hex').slice(0, 32), 'hex');
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}

export function emptyReceiptLedger() {
  return {
    format: RECEIPT_FORMAT,
    version: RECEIPT_VERSION,
    receipts: [],
  };
}

export function validateReceiptLedger(value, knownSources = []) {
  if (
    value?.format !== RECEIPT_FORMAT
    || value.version !== RECEIPT_VERSION
    || !Array.isArray(value.receipts)
  ) {
    throw new Error('source intake receipt file has an unsupported format');
  }
  const aliasOwners = new Map();
  for (const [index, receipt] of value.receipts.entries()) {
    if (!['reserved', 'created'].includes(receipt?.state)) {
      throw new Error(`source intake receipt ${index} has an invalid state`);
    }
    if (receipt?.source?.kind !== 'github-issue') {
      throw new Error(`source intake receipt ${index} has an invalid source`);
    }
    const repository = requireRepository(
      receipt.source.repository,
      `source intake receipt ${index} repository`,
    );
    const number = Number(receipt.source.number);
    const nodeId = String(receipt.source.nodeId ?? '').trim();
    const url = String(receipt.source.url ?? '').trim();
    if (!Number.isInteger(number) || number < 1 || !nodeId || !url) {
      throw new Error(`source intake receipt ${index} has an incomplete source identity`);
    }
    if (url.toLowerCase() !== canonicalIssueUrl(repository, number).toLowerCase()) {
      throw new Error(`source intake receipt ${index} has a non-canonical or contradictory URL`);
    }
    if (!UUID_RE.test(String(receipt.requestId || '').trim())) {
      throw new Error(`source intake receipt ${index} has an invalid requestId`);
    }
    if (!String(receipt.target?.backend || '').trim()) {
      throw new Error(`source intake receipt ${index} has no target backend`);
    }
    if (receipt.state === 'created' && !String(receipt.target?.taskId || '').trim()) {
      throw new Error(`source intake receipt ${index} has no target task id`);
    }
    for (const alias of receiptAliases(receipt)) {
      if (aliasOwners.has(alias)) {
        throw new Error(
          `source intake receipts ${aliasOwners.get(alias)} and ${index} have duplicate source identity`,
        );
      }
      aliasOwners.set(alias, index);
    }
    const receiptSourceAliases = receiptAliases(receipt);
    const liveMatches = knownSources.filter((source) =>
      sourceAliases(source).some((alias) => receiptSourceAliases.includes(alias)));
    if (
      liveMatches.length > 1
      || liveMatches.some((source) => !sameSourceIdentity(receipt.source, source))
    ) {
      throw new Error(`source intake receipt ${index} cross-links source Issue aliases`);
    }
  }
  return structuredClone(value);
}

export function parseBacklogRepositories(markdown, workstream) {
  const lines = String(markdown ?? '').split(/\r?\n/);
  const heading = lines.findIndex((line) => /^## Backlog repositories\s*$/i.test(line));
  if (heading < 0) return [];
  const repositories = [];
  for (const line of lines.slice(heading + 1)) {
    if (/^##\s/.test(line)) break;
    const bullet = /^\s*[-*]\s+(.+?)\s*$/.exec(line);
    if (!bullet) continue;
    const value = bullet[1].replace(/^`|`$/g, '').trim();
    repositories.push({
      repository: requireRepository(value, `${workstream} backlog repository`),
      workstream,
    });
  }
  return repositories;
}

export function resolveGitHubIntakeConfig(domainBackendConfig, workstreams = []) {
  const backend = String(domainBackendConfig?.backend ?? '').trim();
  const configured = domainBackendConfig?.sourceIntake?.githubIssues;
  if (configured?.enabled !== true) {
    throw new Error('GitHub Issue source intake is not enabled');
  }
  if (!backend || backend === 'github') {
    throw new Error('GitHub Issue source intake requires a non-GitHub authoritative backend');
  }
  const explicit = configured.repositories ?? [];
  if (!Array.isArray(explicit)) {
    throw new Error('sourceIntake.githubIssues.repositories must be an array');
  }
  const associations = new Map();
  if (configured.workstreamBacklogs === true) {
    for (const workstream of workstreams) {
      for (const declaration of parseBacklogRepositories(
        workstream.content,
        workstream.path,
      )) {
        const values = associations.get(declaration.repository) ?? new Set();
        values.add(declaration.workstream);
        associations.set(declaration.repository, values);
      }
    }
  }
  const repositories = new Set(
    explicit.map((entry, index) =>
      requireRepository(entry, `sourceIntake.githubIssues.repositories[${index}]`)),
  );
  for (const repository of associations.keys()) repositories.add(repository);
  if (repositories.size === 0) {
    throw new Error('GitHub Issue source intake has no explicitly declared repositories');
  }
  const receiptPath = String(
    configured.receiptPath ?? '.pan/source-intake-receipts.json',
  ).trim();
  if (
    !receiptPath
    || receiptPath.startsWith('/')
    || receiptPath.split('/').some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    throw new Error('sourceIntake.githubIssues.receiptPath must be a safe repository-relative path');
  }
  return {
    backend,
    receiptPath,
    sources: [...repositories].sort().map((repository) => {
      const declaredBy = [...(associations.get(repository) ?? [])].sort();
      return {
        repository,
        workstream: declaredBy.length === 1 ? declaredBy[0] : '',
        declaredBy,
      };
    }),
  };
}

function normalizedIssue(issue, source) {
  const number = Number(issue?.number);
  const url = String(issue?.html_url ?? issue?.url ?? '').trim();
  const nodeId = String(issue?.node_id ?? issue?.nodeId ?? '').trim();
  const updatedAt = String(issue.updated_at ?? issue.updatedAt ?? '').trim();
  if (
    !Number.isInteger(number)
    || number < 1
    || !url
    || !nodeId
    || !updatedAt
    || Number.isNaN(Date.parse(updatedAt))
    || url.toLowerCase() !== canonicalIssueUrl(source.repository, number).toLowerCase()
  ) {
    throw new Error(`${source.repository} returned an Issue without complete identity`);
  }
  const assignees = Array.isArray(issue.assignees)
    ? issue.assignees.map((assignee) => String(assignee?.login ?? '').toLowerCase()).filter(Boolean)
    : [];
  return {
    kind: 'github-issue',
    repository: source.repository,
    number,
    nodeId,
    url,
    title: String(issue.title ?? '').trim(),
    body: String(issue.body ?? ''),
    state: String(issue.state ?? '').toLowerCase(),
    updatedAt,
    assignees,
    workstream: source.workstream,
    pullRequest: Boolean(issue.pull_request || issue.pullRequest),
  };
}

function eligibility(issue, selfLogin) {
  if (issue.pullRequest) return 'pull-request';
  if (issue.state !== 'open') return 'closed';
  if (
    issue.assignees.length > 0
    && !issue.assignees.includes(String(selfLogin).toLowerCase())
  ) {
    return 'assigned-exclusively-to-other-people';
  }
  return '';
}

export async function discoverGitHubIssues(github, sources) {
  const selfLogin = String(await github.currentUser()).trim().toLowerCase();
  if (!selfLogin) throw new Error('GitHub returned no authenticated user login');
  const eligible = [];
  const excluded = [];
  for (const source of sources) {
    const snapshots = [];
    for (let pass = 0; pass < 2; pass += 1) {
      const issues = [];
      const seenNodes = new Set();
      const seenCursors = new Set();
      let cursor = null;
      let expectedTotal = null;
      while (true) {
        const page = await github.listIssueConnectionPage(source.repository, cursor, 100);
        if (
          !page
          || !Array.isArray(page.nodes)
          || page.nodes.length > 100
          || !Number.isInteger(page.totalCount)
          || page.totalCount < 0
          || typeof page.pageInfo?.hasNextPage !== 'boolean'
          || !Object.hasOwn(page.pageInfo, 'endCursor')
        ) {
          throw new Error(`${source.repository} returned incomplete Issue cursor metadata`);
        }
        if (expectedTotal === null) expectedTotal = page.totalCount;
        if (page.totalCount !== expectedTotal) {
          throw new Error(`${source.repository} changed while its Issues were being read`);
        }
        for (const native of page.nodes) {
          const issue = normalizedIssue(native, source);
          if (seenNodes.has(issue.nodeId)) {
            throw new Error(`${source.repository} returned overlapping or reordered Issue pages`);
          }
          seenNodes.add(issue.nodeId);
          issues.push(issue);
        }
        if (!page.pageInfo.hasNextPage) break;
        const nextCursor = String(page.pageInfo.endCursor ?? '').trim();
        if (!nextCursor || seenCursors.has(nextCursor)) {
          throw new Error(`${source.repository} returned an invalid or repeated Issue cursor`);
        }
        seenCursors.add(nextCursor);
        cursor = nextCursor;
      }
      if (issues.length !== expectedTotal) {
        throw new Error(
          `${source.repository} Issue snapshot expected ${expectedTotal} records but read ${issues.length}`,
        );
      }
      snapshots.push(issues);
    }
    if (JSON.stringify(snapshots[0]) !== JSON.stringify(snapshots[1])) {
      throw new Error(`${source.repository} changed between complete Issue snapshots`);
    }
    for (const issue of snapshots[1]) {
      const reason = eligibility(issue, selfLogin);
      if (reason) excluded.push({ source: issue, reason });
      else eligible.push(issue);
    }
  }
  const byNode = new Map();
  for (const issue of eligible) {
    const previous = byNode.get(issue.nodeId);
    if (!previous) {
      byNode.set(issue.nodeId, issue);
    } else if (!previous.workstream && issue.workstream) {
      byNode.set(issue.nodeId, { ...previous, workstream: issue.workstream });
    }
  }
  return {
    eligible: [...byNode.values()].sort((a, b) =>
      a.repository.localeCompare(b.repository) || a.number - b.number),
    excluded,
  };
}

export function planSourceIntake(discovery, ledgerValue, backend) {
  const ledger = validateReceiptLedger(ledgerValue, [
    ...discovery.eligible,
    ...discovery.excluded.map((entry) => entry.source),
  ]);
  const actions = discovery.eligible.map((source) => {
    const matches = matchingReceipts(ledger, source);
    if (matches.length > 1) {
      return {
        action: 'conflict',
        source,
        reason: 'multiple durable receipts match this source Issue',
        receipts: matches,
      };
    }
    if (matches.length === 1) {
      const receipt = matches[0];
      if (receipt.target.backend !== backend) {
        return {
          action: 'conflict',
          source,
          reason: 'the source Issue is already mapped to another authoritative backend',
          receipts: matches,
        };
      }
      return {
        action: receipt.state === 'created' ? 'already-imported' : 'recover-reservation',
        source,
        receipt,
      };
    }
    return {
      action: 'create',
      source,
      requestId: deterministicRequestId(source, backend),
    };
  });
  return {
    format: 'pan-source-intake-plan',
    version: 1,
    backend,
    actions,
    excluded: discovery.excluded,
    counts: Object.fromEntries(
      [...new Set(actions.map((action) => action.action))]
        .map((name) => [name, actions.filter((action) => action.action === name).length]),
    ),
  };
}

function sourceDescription(source) {
  return [
    'Pan source: GitHub Issue',
    `Source URL: ${source.url}`,
    `Source repository: ${source.repository}`,
    `Source Issue: #${source.number}`,
    `Source node id: ${source.nodeId}`,
    '',
    'This task was registered from the source Issue. The authoritative task',
    'lifecycle is here; the source Issue remains reference-only.',
    '',
    '## Source Issue description',
    '',
    source.body || '(No description.)',
  ].join('\n');
}

function createInput(source, requestId) {
  return {
    title: source.title,
    description: sourceDescription(source),
    status: 'untriaged',
    nextAction: '',
    nextActionDetail: '',
    priority: 'normal',
    nextActionDate: '',
    deadline: '',
    playbook: '',
    workstream: source.workstream || '',
    executionAuthorized: false,
    dependencies: [],
    idempotencyKey: requestId,
  };
}

function assertSafeCreatedTask(task, input) {
  if (
    !String(task?.id ?? '').trim()
    || task.title !== input.title
    || task.description !== input.description.trimEnd()
    || task.status !== 'untriaged'
    || task.nextAction !== ''
    || task.nextActionDetail !== ''
    || task.executionAuthorized !== false
    || task.nextActionDate !== ''
    || task.deadline !== ''
    || task.playbook !== ''
    || task.workstream !== input.workstream
    || !Array.isArray(task.dependencies)
    || task.dependencies.length > 0
  ) {
    throw new Error(
      `created task ${task?.id ?? '(unknown)'} does not match the required safe intake record`,
    );
  }
}

async function reserve(receiptStore, source, backend, requestId, now) {
  const current = await receiptStore.read();
  const ledger = validateReceiptLedger(current.ledger, [source]);
  const matches = matchingReceipts(ledger, source);
  if (matches.length > 1) throw new Error('multiple durable receipts match this source Issue');
  if (matches.length === 1) {
    const receipt = matches[0];
    if (
      !sameSourceIdentity(receipt.source, source)
      || receipt.target.backend !== backend
      || receipt.requestId !== requestId
    ) {
      throw new Error('durable receipt changed before the task was created');
    }
    return receipt;
  }
  const receipt = {
    state: 'reserved',
    source: {
      kind: 'github-issue',
      repository: source.repository,
      number: source.number,
      nodeId: source.nodeId,
      url: source.url,
    },
    target: { backend, taskId: null },
    requestId,
    reservedAt: now(),
  };
  ledger.receipts.push(receipt);
  await receiptStore.write(ledger, current.revision);
  return receipt;
}

async function finalize(receiptStore, source, backend, requestId, taskId, now) {
  const current = await receiptStore.read();
  const ledger = validateReceiptLedger(current.ledger, [source]);
  const matches = matchingReceipts(ledger, source);
  if (matches.length !== 1) {
    throw new Error(`expected one durable receipt while finalizing; found ${matches.length}`);
  }
  const receipt = matches[0];
  if (receipt.target.backend !== backend || receipt.requestId !== requestId) {
    throw new Error('durable receipt changed while the task was being created');
  }
  if (receipt.state === 'created') {
    if (String(receipt.target.taskId) !== String(taskId)) {
      throw new Error('durable receipt points to a different authoritative task');
    }
    return receipt;
  }
  receipt.state = 'created';
  receipt.target.taskId = String(taskId);
  receipt.createdAt = now();
  await receiptStore.write(ledger, current.revision);
  return receipt;
}

function samePlannedReceipt(planned, live) {
  return (
    planned.state === live.state
    && sameSourceIdentity(planned.source, live.source)
    && planned.target.backend === live.target.backend
    && String(planned.target.taskId) === String(live.target.taskId)
    && planned.requestId === live.requestId
  );
}

async function confirmExistingReceipt(receiptStore, action, backend) {
  const current = await receiptStore.read();
  const ledger = validateReceiptLedger(current.ledger, [action.source]);
  const matches = matchingReceipts(ledger, action.source);
  if (
    matches.length !== 1
    || matches[0].state !== 'created'
    || matches[0].target.backend !== backend
    || !samePlannedReceipt(action.receipt, matches[0])
  ) {
    throw new Error('durable receipt changed after preview; rerun intake');
  }
  return matches[0];
}

function sameSourceRevision(planned, live) {
  return (
    planned.nodeId === live.nodeId
    && planned.url === live.url
    && planned.updatedAt === live.updatedAt
  );
}

export async function applySourceIntake(plan, {
  backend,
  github,
  receiptStore,
  now = () => new Date().toISOString(),
}) {
  if (backend.supportsIdempotentCreate !== true) {
    throw new Error('the configured backend does not support idempotent source-intake creation');
  }
  const results = [];
  let partial = false;
  for (const action of plan.actions) {
    if (action.action === 'already-imported') {
      try {
        const receipt = await confirmExistingReceipt(receiptStore, action, plan.backend);
        results.push({
          action: action.action,
          sourceUrl: action.source.url,
          taskId: receipt.target.taskId,
        });
      } catch (error) {
        partial = true;
        results.push({
          action: 'failed',
          sourceUrl: action.source.url,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      continue;
    }
    if (action.action === 'conflict') {
      partial = true;
      results.push({
        action: 'failed',
        sourceUrl: action.source.url,
        error: action.reason,
      });
      continue;
    }
    let task = null;
    let requestId = action.receipt?.requestId || action.requestId;
    try {
      const native = await github.getIssue(action.source.repository, action.source.number);
      const live = normalizedIssue(native, {
        repository: action.source.repository,
        workstream: action.source.workstream,
      });
      const reason = eligibility(live, await github.currentUser());
      if (reason) throw new Error(`source Issue is no longer eligible: ${reason}`);
      if (!sameSourceRevision(action.source, live)) {
        throw new Error('source Issue changed after preview; rerun intake');
      }
      const receipt = await reserve(
        receiptStore,
        live,
        plan.backend,
        requestId,
        now,
      );
      if (receipt.state === 'created') {
        results.push({
          action: 'already-imported',
          sourceUrl: live.url,
          taskId: receipt.target.taskId,
        });
        continue;
      }
      requestId = receipt.requestId;
      const input = createInput(live, requestId);
      task = await backend.create(input);
      assertSafeCreatedTask(task, input);
      await finalize(receiptStore, live, plan.backend, requestId, task.id, now);
      results.push({
        action: action.action === 'recover-reservation' ? 'recovered' : 'created',
        sourceUrl: live.url,
        taskId: task.id,
        requestId,
      });
    } catch (error) {
      partial = true;
      const createdTaskId = task?.id ?? error?.details?.taskId;
      results.push({
        action: 'failed',
        sourceUrl: action.source.url,
        requestId,
        ...(createdTaskId ? { createdTaskId: String(createdTaskId) } : {}),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return {
    format: 'pan-source-intake-report',
    version: 1,
    partial,
    results,
    excluded: plan.excluded,
  };
}
