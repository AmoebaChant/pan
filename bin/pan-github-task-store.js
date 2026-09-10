import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  derivePrimaryView,
  isRecurringBody,
  isTerminalStatus,
  parseCurrentActionBlock,
  parseRevision,
  renderCurrentActionBlock,
  rollbackSafetyReason,
  transitionComment,
  transitionMarker,
  upsertCurrentActionBlock,
  validLifecyclePair,
} from './pan-task-model.js';
import {
  ensureIssueComment,
  ensureIssueClosed,
  ensureIssueRejected,
  updateIssueCurrentAction,
} from './pan-issue-lifecycle.js';
import { CANONICAL_FIELDS, schemaProblems } from './pan-project-schema.js';

const MAX_GH_OUTPUT = 64 * 1024 * 1024;
const ACTIVE_WORKER_STATES = new Set(['starting', 'running', 'waiting-human', 'uncertain']);

export function runGh(args, { input = null } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('gh', args, {
      shell: false,
      stdio: [input == null ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    let stdoutSize = 0;
    let stderrSize = 0;
    child.stdout.on('data', (chunk) => {
      stdoutSize += chunk.length;
      if (stdoutSize <= MAX_GH_OUTPUT) stdout.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderrSize += chunk.length;
      if (stderrSize <= MAX_GH_OUTPUT) stderr.push(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (stdoutSize > MAX_GH_OUTPUT || stderrSize > MAX_GH_OUTPUT) {
        reject(new Error('gh output exceeded the service safety limit'));
        return;
      }

      const out = Buffer.concat(stdout).toString('utf8');
      const err = Buffer.concat(stderr).toString('utf8').trim();
      if (code === 0) resolve(out);
      else reject(new Error(err || `gh exited ${code}`));
    });
    if (input != null) {
      child.stdin.end(input);
    }
  });
}

function projectionFingerprint(item) {
  return createHash('sha256').update(JSON.stringify({
    itemId: item.itemId,
    projectUpdatedAt: item.projectUpdatedAt,
    issue: item.issue,
    fields: Object.fromEntries(Object.entries(item.fields).sort(([a], [b]) => a.localeCompare(b))),
  })).digest('hex');
}

function parseRepo(value, name) {
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(String(value ?? ''));
  if (!match) throw new Error(`${name} must be owner/repository`);
  return { owner: match[1], name: match[2], slug: `${match[1]}/${match[2]}` };
}

function parseProject(value) {
  const match = /^([A-Za-z0-9_.-]+)\/([1-9]\d*)$/.exec(String(value ?? ''));
  if (!match) throw new Error('project must be owner/number');
  return { owner: match[1], number: Number(match[2]) };
}

export async function loadTaskServiceBinding(configPath, checkoutPath) {
  if (!configPath || !path.isAbsolute(configPath)) {
    throw new Error('--config must be an absolute path');
  }
  if (!checkoutPath || !path.isAbsolute(checkoutPath)) {
    throw new Error('--checkout must be an absolute path');
  }
  const [{ readFile }, checkoutReal] = await Promise.all([
    import('node:fs/promises'),
    realpath(checkoutPath),
  ]);
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  const packagePath = path.join(checkoutReal, 'package.json');
  const packageStat = await stat(packagePath);
  if (!packageStat.isFile()) throw new Error('--checkout does not contain package.json');
  const packageJson = JSON.parse(await readFile(packagePath, 'utf8'));
  if (packageJson.name !== '@amoebachant/pan') {
    throw new Error('--checkout is not a Pan checkout');
  }
  const domain = parseRepo(config.domainRepo, 'domainRepo');
  const project = parseProject(config.project);
  const allowedRepos = new Set([domain.slug]);
  const configuredBacklogs = config.taskBacklogRepos ?? [];
  if (
    !Array.isArray(configuredBacklogs)
    || configuredBacklogs.some((entry) => typeof entry !== 'string')
  ) {
    throw new Error('taskBacklogRepos must be an array of owner/repository strings');
  }
  for (const entry of configuredBacklogs) {
    allowedRepos.add(parseRepo(entry, 'taskBacklogRepos entry').slug);
  }
  return {
    configPath,
    checkout: checkoutReal,
    domain,
    project,
    allowedRepos,
  };
}

function fieldValueNodes(nodes) {
  const fields = {};
  for (const value of nodes ?? []) {
    const name = value.field?.name;
    if (!name) continue;
    if (Object.hasOwn(fields, name)) {
      throw new Error(`Project item returned duplicate values for field "${name}"`);
    }
    if (typeof value.text === 'string') fields[name] = value.text;
    else if (typeof value.name === 'string') fields[name] = value.name;
    else if (typeof value.date === 'string') fields[name] = value.date;
  }
  return fields;
}

const ITEM_FRAGMENT = `
  id
  updatedAt
  content {
    __typename
    ... on Issue {
      number title body url state stateReason createdAt updatedAt closedAt
      repository { nameWithOwner }
    }
  }
  fieldValues(first:100) {
    nodes {
      __typename
      ... on ProjectV2ItemFieldTextValue {
        text field { ... on ProjectV2FieldCommon { name } }
      }
      ... on ProjectV2ItemFieldSingleSelectValue {
        name field { ... on ProjectV2FieldCommon { name } }
      }
      ... on ProjectV2ItemFieldDateValue {
        date field { ... on ProjectV2FieldCommon { name } }
      }
    }
    pageInfo { hasNextPage endCursor }
  }`;

function parseItem(node) {
  if (node.content?.__typename !== 'Issue') return null;
  return {
    itemId: node.id,
    projectUpdatedAt: node.updatedAt,
    issue: {
      number: node.content.number,
      title: node.content.title,
      body: node.content.body ?? '',
      url: node.content.url,
      repo: node.content.repository?.nameWithOwner ?? '',
      state: node.content.state,
      stateReason: node.content.stateReason,
      createdAt: node.content.createdAt,
      updatedAt: node.content.updatedAt,
      closedAt: node.content.closedAt,
    },
    fields: fieldValueNodes(node.fieldValues?.nodes),
  };
}

export async function completeTaskStoreItemFieldValues(node, runJson) {
  const nodes = [...(node.fieldValues?.nodes ?? [])];
  let page = node.fieldValues?.pageInfo ?? {};
  let cursor = page.hasNextPage ? page.endCursor : null;
  const seen = new Set();
  const query = `query($id:ID!,$cursor:String){
    node(id:$id) {
      ... on ProjectV2Item {
        fieldValues(first:100,after:$cursor) {
          nodes {
            __typename
            ... on ProjectV2ItemFieldTextValue {
              text field { ... on ProjectV2FieldCommon { name } }
            }
            ... on ProjectV2ItemFieldSingleSelectValue {
              name field { ... on ProjectV2FieldCommon { name } }
            }
            ... on ProjectV2ItemFieldDateValue {
              date field { ... on ProjectV2FieldCommon { name } }
            }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }`;
  while (cursor) {
    if (seen.has(cursor)) throw new Error(`Project item ${node.id} repeated a field-value cursor`);
    seen.add(cursor);
    const data = await runJson([
      'api', 'graphql', '-f', `query=${query}`,
      '-f', `id=${node.id}`, '-f', `cursor=${cursor}`,
    ]);
    const connection = data.data?.node?.fieldValues;
    if (!connection) throw new Error(`Project item ${node.id} field values were unreadable`);
    nodes.push(...(connection.nodes ?? []));
    page = connection.pageInfo ?? {};
    cursor = page.hasNextPage ? page.endCursor : null;
  }
  return {
    ...node,
    fieldValues: {
      nodes,
      pageInfo: { hasNextPage: false, endCursor: null },
    },
  };
}

function todayLocal(now = new Date()) {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function assertDate(value, field, { allowEmpty = true } = {}) {
  if ((value === '' || value == null) && allowEmpty) return '';
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value));
  const parsed = match ? new Date(`${value}T00:00:00.000Z`) : null;
  if (
    !match
    || Number.isNaN(parsed.valueOf())
    || parsed.getUTCFullYear() !== Number(match[1])
    || parsed.getUTCMonth() + 1 !== Number(match[2])
    || parsed.getUTCDate() !== Number(match[3])
  ) {
    throw new Error(`${field} must be an ISO calendar date`);
  }
  return String(value);
}

const WEEKDAYS = new Map([
  ['sunday', 0],
  ['monday', 1],
  ['tuesday', 2],
  ['wednesday', 3],
  ['thursday', 4],
  ['friday', 5],
  ['saturday', 6],
]);
const ORDINALS = new Map([
  ['first', 1],
  ['second', 2],
  ['third', 3],
  ['fourth', 4],
]);
const NUMBER_WORDS = new Map([
  ['one', 1],
  ['two', 2],
  ['three', 3],
  ['four', 4],
]);

function isoDay(date) {
  return date.toISOString().slice(0, 10);
}

function addUtcDays(date, days) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function recurrenceState(body) {
  const source = String(body ?? '');
  const markers = [...source.matchAll(/^Pan: recurrence occurrence (\d{4}-\d{2}-\d{2})$/gm)];
  if (markers.length !== 1 || markers[0].index !== 0) {
    throw new Error('recurring task must have exactly one valid first-line occurrence marker');
  }
  const headings = [...source.matchAll(/^## Recurrence\s*$/gm)];
  if (headings.length !== 1) {
    throw new Error('recurring task must have exactly one ## Recurrence section');
  }
  const sectionStart = headings[0].index + headings[0][0].length;
  const remainder = source.slice(sectionStart).replace(/^\r?\n/, '');
  const nextBoundary = /^(?:##\s+|<!-- pan-current-next-action:start -->)/m.exec(remainder);
  const rule = remainder.slice(0, nextBoundary?.index ?? remainder.length).trim();
  if (!rule || /\r?\n/.test(rule)) {
    throw new Error('recurrence rule must be one concise, unambiguous line');
  }
  return {
    occurrence: assertDate(markers[0][1], 'recurrence occurrence', { allowEmpty: false }),
    rule,
  };
}

function monthlyWeekday(year, month, weekday, ordinal) {
  if (ordinal === 'last') {
    const date = new Date(Date.UTC(year, month + 1, 0));
    date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() - weekday + 7) % 7));
    return date;
  }
  const date = new Date(Date.UTC(year, month, 1));
  date.setUTCDate(date.getUTCDate() + ((weekday - date.getUTCDay() + 7) % 7) + (ordinal - 1) * 7);
  if (date.getUTCMonth() !== month) throw new Error('recurrence ordinal has no date in the month');
  return date;
}

export function computeRecurringSuccessor(body, completionDay) {
  const { occurrence, rule } = recurrenceState(body);
  const completion = new Date(`${assertDate(
    completionDay,
    'completion day',
    { allowEmpty: false },
  )}T00:00:00.000Z`);
  const nominal = new Date(`${occurrence}T00:00:00.000Z`);
  const normalized = rule.trim().replace(/\.$/, '').toLowerCase();
  let next;

  const weekly = /^every (?:(one|two|three|four|\d+) weeks? on )?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)$/.exec(normalized);
  if (weekly) {
    const interval = weekly[1]
      ? (NUMBER_WORDS.get(weekly[1]) ?? Number(weekly[1]))
      : 1;
    const weekday = WEEKDAYS.get(weekly[2]);
    if (!Number.isInteger(interval) || interval < 1 || interval > 52) {
      throw new Error(`unsupported recurrence interval: ${rule}`);
    }
    if (nominal.getUTCDay() !== weekday) {
      throw new Error('recurrence occurrence does not satisfy its weekday rule');
    }
    next = (date) => addUtcDays(date, interval * 7);
  } else {
    const monthly = /^the (first|second|third|fourth|last) (sunday|monday|tuesday|wednesday|thursday|friday|saturday) of every month$/.exec(normalized);
    if (monthly) {
      const ordinal = monthly[1] === 'last' ? 'last' : ORDINALS.get(monthly[1]);
      const weekday = WEEKDAYS.get(monthly[2]);
      const expected = monthlyWeekday(
        nominal.getUTCFullYear(),
        nominal.getUTCMonth(),
        weekday,
        ordinal,
      );
      if (isoDay(expected) !== occurrence) {
        throw new Error('recurrence occurrence does not satisfy its monthly rule');
      }
      next = (date) => {
        const month = date.getUTCMonth() + 1;
        return monthlyWeekday(
          date.getUTCFullYear() + Math.floor(month / 12),
          month % 12,
          weekday,
          ordinal,
        );
      };
    } else {
      const daily = /^every (?:(one|two|three|four|\d+) days?|day)$/.exec(normalized);
      if (!daily) throw new Error(`unsupported recurrence rule: ${rule}`);
      const interval = daily[1]
        ? (NUMBER_WORDS.get(daily[1]) ?? Number(daily[1]))
        : 1;
      if (!Number.isInteger(interval) || interval < 1 || interval > 366) {
        throw new Error(`unsupported recurrence interval: ${rule}`);
      }
      next = (date) => addUtcDays(date, interval);
    }
  }

  const skipped = [];
  let candidate = next(nominal);
  let guard = 0;
  while (candidate <= completion) {
    skipped.push(isoDay(candidate));
    candidate = next(candidate);
    guard += 1;
    if (guard > 10000) throw new Error('recurrence computation exceeded its safety limit');
  }
  return {
    occurrence,
    rule,
    nextOccurrence: isoDay(candidate),
    skipped,
  };
}

export function resolveRecurringSuccessorEvidence({
  currentUrl,
  domainSlug,
  comments,
  issues,
}) {
  const commentTargets = (comments ?? []).flatMap((comment) => {
    const firstLine = String(comment.body ?? '').split(/\r?\n/, 1)[0];
    const match = /^Pan: next occurrence (https:\/\/github\.com\/[^\s]+)$/.exec(firstLine);
    return match ? [match[1]] : [];
  });
  if (commentTargets.length > 1) {
    throw new Error('recurring task has duplicate or conflicting next-occurrence comments');
  }
  const reverseLine = `Pan: previous occurrence ${currentUrl}`;
  const reverseTargets = (issues ?? []).filter((issue) =>
    String(issue.body ?? '').split(/\r?\n/).filter((line) => line === reverseLine).length === 1);
  const malformedReverse = (issues ?? []).filter((issue) =>
    String(issue.body ?? '').split(/\r?\n/).filter((line) => line === reverseLine).length > 1);
  if (malformedReverse.length || reverseTargets.length > 1) {
    throw new Error('recurring task has duplicate reverse successor markers');
  }
  const targetUrl = commentTargets[0] ?? reverseTargets[0]?.url ?? null;
  if (targetUrl && reverseTargets[0] && reverseTargets[0].url !== targetUrl) {
    throw new Error('recurring task successor backlink and reverse marker disagree');
  }
  if (!targetUrl) return null;
  const expectedPrefix = `https://github.com/${domainSlug}/issues/`;
  if (!targetUrl.startsWith(expectedPrefix) || targetUrl === currentUrl) {
    throw new Error('recurring task successor points outside the configured Domain');
  }
  const successor = (issues ?? []).find((issue) => issue.url === targetUrl);
  if (!successor) throw new Error('recurring task successor target could not be verified');
  const previousMarkers = String(successor.body ?? '')
    .split(/\r?\n/)
    .filter((line) => line.startsWith('Pan: previous occurrence '));
  if (
    previousMarkers.length > 1
    || (previousMarkers.length === 1 && previousMarkers[0] !== reverseLine)
    || (!commentTargets.length && previousMarkers.length !== 1)
  ) {
    throw new Error('recurring task successor has conflicting reverse-marker evidence');
  }
  return successor;
}

function text(value, field, max, { allowEmpty = true } = {}) {
  if (typeof value !== 'string') throw new Error(`${field} must be a string`);
  const result = value.trim();
  if (!result && !allowEmpty) throw new Error(`${field} must not be empty`);
  if (result.length > max) throw new Error(`${field} exceeds ${max} characters`);
  return result;
}

function normalizedTask(item, today, recentSince) {
  const fields = item.fields;
  let currentAction = null;
  let bodyConflict = null;
  try {
    currentAction = parseCurrentActionBlock(item.issue.body);
  } catch (error) {
    bodyConflict = error.message;
  }
  const task = {
    id: item.itemId,
    itemId: item.itemId,
    number: item.issue.number,
    repo: item.issue.repo,
    title: item.issue.title,
    url: item.issue.url,
    issueState: item.issue.state,
    issueStateReason: item.issue.stateReason,
    status: fields.Status ?? '',
    nextAction: fields['next-action'] ?? '',
    nextActionDetail: currentAction?.detail ?? '',
    priority: fields.priority || 'normal',
    nextActionDate: fields['next-action-date'] ?? '',
    deadline: fields.deadline ?? '',
    playbook: fields.playbook ?? '',
    workstream: fields.workstream ?? '',
    executionAuthorized: fields['execution-authorized'] || 'no',
    dependencies: fields.dependencies ?? '',
    workerState: fields['worker-state'] ?? '',
    needsHumanSince: fields['needs-human-since'] ?? '',
    claimedBy: fields['claimed-by'] ?? '',
    leaseUntil: fields['lease-until'] ?? '',
    machine: fields.machine ?? '',
    sessionId: fields['session-id'] ?? '',
    claimGeneration: fields['claim-generation'] ?? '',
    resourceSemantics: fields['resource-semantics'] ?? '',
    legacyOwner: fields.owner ?? '',
    revision: parseRevision(fields['task-revision'] ?? ''),
    recurring: isRecurringBody(item.issue.body),
    updatedAt: item.issue.updatedAt || item.projectUpdatedAt,
    createdAt: item.issue.createdAt,
    closedAt: item.issue.closedAt,
    bodyConflict,
    currentActionStatus: currentAction?.status ?? '',
    currentActionAction: currentAction?.action ?? '',
    currentActionRevision: currentAction?.revision ?? null,
    projection: projectionFingerprint(item),
  };
  task.primaryView = derivePrimaryView(task, today, recentSince);
  task.overdue = (
    !isTerminalStatus(task.status)
    && !!task.nextActionDate
    && task.nextActionDate < today
  );
  return task;
}

function artifactsFromComments(comments) {
  const found = [];
  const seen = new Set();
  const pattern = /https:\/\/github\.com\/[^\s)>\]]+/g;
  for (const comment of comments) {
    for (const url of comment.body.match(pattern) ?? []) {
      if (seen.has(url)) continue;
      seen.add(url);
      found.push({ url, sourceCommentUrl: comment.url });
    }
  }
  return found;
}

export class GitHubTaskStore {
  constructor(binding, { gh = runGh, now = () => new Date() } = {}) {
    this.binding = binding;
    this.gh = gh;
    this.now = now;
    this.meta = null;
  }

  async initialize() {
    this.meta = await this.#loadMeta();
    const problems = schemaProblems(this.meta.fields);
    if (problems.length) {
      throw new Error(`Project schema is invalid:\n- ${problems.join('\n- ')}`);
    }
    return this;
  }

  async #json(args) {
    return JSON.parse(await this.gh(args));
  }

  async #loadMeta() {
    const typeData = await this.#json([
      'api',
      'graphql',
      '-f',
      'query=query($login:String!){repositoryOwner(login:$login){__typename}}',
      '-f',
      `login=${this.binding.project.owner}`,
    ]);
    const typename = typeData.data?.repositoryOwner?.__typename;
    const ownerType = typename === 'Organization' ? 'organization' : typename === 'User' ? 'user' : null;
    if (!ownerType) throw new Error(`cannot resolve Project owner ${this.binding.project.owner}`);

    const query = `query($login:String!,$number:Int!,$cursor:String){
      ${ownerType}(login:$login) {
        projectV2(number:$number) {
          id
          fields(first:50,after:$cursor) {
            nodes {
              __typename
              ... on ProjectV2FieldCommon { id name }
              ... on ProjectV2Field { dataType }
              ... on ProjectV2SingleSelectField {
                id name options { id name }
              }
            }
            pageInfo { hasNextPage endCursor }
          }
        }
      }
    }`;
    const fields = new Map();
    let projectId = '';
    let cursor = null;
    do {
      const args = [
        'api', 'graphql', '-f', `query=${query}`,
        '-f', `login=${this.binding.project.owner}`,
        '-F', `number=${this.binding.project.number}`,
      ];
      if (cursor) args.push('-f', `cursor=${cursor}`);
      const data = await this.#json(args);
      const project = data.data?.[ownerType]?.projectV2;
      if (!project) throw new Error('configured Project was not found');
      projectId = project.id;
      for (const field of project.fields.nodes ?? []) {
        if (!field?.name) continue;
        const options = field.options
          ? new Map(field.options.map((option) => [option.name, option.id]))
          : null;
        fields.set(field.name, {
          id: field.id,
          dataType: field.dataType ?? (options ? 'SINGLE_SELECT' : field.__typename),
          options,
        });
      }
      cursor = project.fields.pageInfo?.hasNextPage
        ? project.fields.pageInfo.endCursor
        : null;
    } while (cursor);
    return { ownerType, projectId, fields };
  }

  async #allItems() {
    const query = `query($login:String!,$number:Int!,$cursor:String){
      ${this.meta.ownerType}(login:$login) {
        projectV2(number:$number) {
          items(first:100,after:$cursor) {
            nodes { ${ITEM_FRAGMENT} }
            pageInfo { hasNextPage endCursor }
          }
        }
      }
    }`;
    const items = [];
    let cursor = null;
    do {
      const args = [
        'api', 'graphql', '-f', `query=${query}`,
        '-f', `login=${this.binding.project.owner}`,
        '-F', `number=${this.binding.project.number}`,
      ];
      if (cursor) args.push('-f', `cursor=${cursor}`);
      const data = await this.#json(args);
      const connection = data.data?.[this.meta.ownerType]?.projectV2?.items;
      if (!connection) throw new Error('configured Project items were unreadable');
      for (const node of connection.nodes ?? []) {
        const parsed = parseItem(await this.#completeItemFieldValues(node));
        if (!parsed) continue;
        if (!this.binding.allowedRepos.has(parsed.issue.repo)) continue;
        items.push(parsed);
      }
      cursor = connection.pageInfo?.hasNextPage ? connection.pageInfo.endCursor : null;
    } while (cursor);
    return items;
  }

  async #item(itemId) {
    const matches = (await this.#allItems()).filter((item) => item.itemId === itemId);
    if (matches.length > 1) {
      throw new Error(`configured Project returned duplicate item id ${itemId}`);
    }
    return matches[0] ?? null;
  }

  async #completeItemFieldValues(node) {
    return completeTaskStoreItemFieldValues(node, (args) => this.#json(args));
  }

  async #comments(repo, number) {
    const [owner, name] = repo.split('/');
    const query = `query($owner:String!,$name:String!,$number:Int!,$cursor:String){
      repository(owner:$owner,name:$name) {
        issue(number:$number) {
          comments(first:100,after:$cursor) {
            nodes { id author { login } createdAt updatedAt url body }
            pageInfo { hasNextPage endCursor }
          }
        }
      }
    }`;
    const comments = [];
    let cursor = null;
    do {
      const args = [
        'api', 'graphql', '-f', `query=${query}`,
        '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `number=${number}`,
      ];
      if (cursor) args.push('-f', `cursor=${cursor}`);
      const data = await this.#json(args);
      const connection = data.data?.repository?.issue?.comments;
      if (!connection) throw new Error(`Issue comments were unreadable for ${repo}#${number}`);
      comments.push(...(connection.nodes ?? []).map((comment) => ({
        id: comment.id,
        author: comment.author?.login ?? null,
        createdAt: comment.createdAt,
        updatedAt: comment.updatedAt,
        url: comment.url,
        body: comment.body,
      })));
      cursor = connection.pageInfo?.hasNextPage ? connection.pageInfo.endCursor : null;
    } while (cursor);
    return comments;
  }

  async #allDomainIssues() {
    const query = `query($owner:String!,$name:String!,$cursor:String){
      repository(owner:$owner,name:$name) {
        issues(first:100,after:$cursor,states:[OPEN,CLOSED],orderBy:{field:CREATED_AT,direction:ASC}) {
          nodes { number title body url state stateReason createdAt updatedAt closedAt }
          pageInfo { hasNextPage endCursor }
        }
      }
    }`;
    const issues = [];
    let cursor = null;
    do {
      const args = [
        'api', 'graphql', '-f', `query=${query}`,
        '-f', `owner=${this.binding.domain.owner}`,
        '-f', `name=${this.binding.domain.name}`,
      ];
      if (cursor) args.push('-f', `cursor=${cursor}`);
      const data = await this.#json(args);
      const connection = data.data?.repository?.issues;
      if (!connection) throw new Error('Domain Issues were unreadable');
      issues.push(...(connection.nodes ?? []));
      cursor = connection.pageInfo?.hasNextPage ? connection.pageInfo.endCursor : null;
    } while (cursor);
    return issues;
  }

  async list() {
    const today = todayLocal(this.now());
    const recentSince = new Date(this.now().valueOf() - 14 * 86400000).toISOString();
    const tasks = (await this.#allItems()).map((item) => normalizedTask(item, today, recentSince));
    const views = {
      today: [],
      'needs-me': [],
      'in-motion': [],
      recent: [],
      all: tasks.map((task) => task.id),
    };
    for (const task of tasks) {
      if (views[task.primaryView]) views[task.primaryView].push(task.id);
    }
    return {
      today,
      domainRepo: this.binding.domain.slug,
      project: `${this.binding.project.owner}/${this.binding.project.number}`,
      tasks,
      views,
    };
  }

  async detail(itemId) {
    const item = await this.#item(itemId);
    if (!item) throw Object.assign(new Error('task not found'), { statusCode: 404 });
    const today = todayLocal(this.now());
    const task = normalizedTask(item, today, null);
    const comments = await this.#comments(item.issue.repo, item.issue.number);
    let currentAction = null;
    try {
      currentAction = parseCurrentActionBlock(item.issue.body);
    } catch {}
    const details = currentAction
      ? `${item.issue.body.slice(0, currentAction.start)}${item.issue.body.slice(currentAction.end)}`.trim()
      : item.issue.body.trim();
    return {
      ...task,
      details,
      comments,
      artifacts: artifactsFromComments(comments),
    };
  }

  #field(name) {
    const field = this.meta.fields.get(name);
    if (!field) throw new Error(`Project has no field "${name}"`);
    return field;
  }

  async #setText(itemId, name, value) {
    const field = this.#field(name);
    const args = [
      'project', 'item-edit',
      '--id', itemId,
      '--project-id', this.meta.projectId,
      '--field-id', field.id,
    ];
    if (value === '' || value == null) args.push('--clear');
    else args.push('--text', String(value));
    await this.gh(args);
  }

  async #setDate(itemId, name, value) {
    const field = this.#field(name);
    const args = [
      'project', 'item-edit',
      '--id', itemId,
      '--project-id', this.meta.projectId,
      '--field-id', field.id,
    ];
    if (!value) args.push('--clear');
    else args.push('--date', value);
    await this.gh(args);
  }

  async #setSelect(itemId, name, value) {
    const field = this.#field(name);
    if (!value) {
      await this.gh([
        'project', 'item-edit',
        '--id', itemId,
        '--project-id', this.meta.projectId,
        '--field-id', field.id,
        '--clear',
      ]);
      return;
    }
    const option = field.options?.get(value);
    if (!option) throw new Error(`Project field "${name}" has no option "${value}"`);
    await this.gh([
      'project', 'item-edit',
      '--id', itemId,
      '--project-id', this.meta.projectId,
      '--field-id', field.id,
      '--single-select-option-id', option,
    ]);
  }

  async #addToProject(url) {
    const raw = await this.gh([
      'project', 'item-add',
      String(this.binding.project.number),
      '--owner', this.binding.project.owner,
      '--url', url,
      '--format', 'json',
    ]);
    const parsed = JSON.parse(raw);
    const id = parsed.id ?? parsed.item?.id;
    if (!id) throw new Error('GitHub did not return the added Project item id');
    return id;
  }

  async #validateWorkstream(value) {
    const workstream = text(value ?? '', 'workstream', 300);
    if (!workstream) return '';
    if (
      workstream.startsWith('/')
      || workstream.endsWith('/')
      || workstream.split('/').some((segment) =>
        !segment || segment === '.' || segment === '..' || !/^[A-Za-z0-9_.-]+$/.test(segment))
    ) {
      throw new Error('workstream must be a safe path below workstreams/');
    }
    try {
      await this.gh([
        'api',
        `repos/${this.binding.domain.slug}/contents/workstreams/${workstream}/README.md`,
      ]);
    } catch (error) {
      throw new Error(`workstream "${workstream}" is not readable in the configured Domain: ${error.message}`);
    }
    return workstream;
  }

  async capture(input) {
    const title = text(input.title, 'title', 256, { allowEmpty: false });
    const details = text(input.details ?? '', 'details', 60000);
    let body = details;
    let nextActionDate = assertDate(input.nextActionDate ?? '', 'nextActionDate');
    if (input.recurrence) {
      const rule = text(input.recurrence.rule, 'recurrence.rule', 500, { allowEmpty: false });
      const occurrence = assertDate(
        input.recurrence.occurrence,
        'recurrence.occurrence',
        { allowEmpty: false },
      );
      body = [
        `Pan: recurrence occurrence ${occurrence}`,
        '',
        details,
        '',
        '## Recurrence',
        '',
        rule,
      ].filter((line, index, lines) => line || (index > 0 && lines[index - 1])).join('\n').trim();
      if (!nextActionDate) nextActionDate = occurrence;
    }
    const revision = 1;
    const block = renderCurrentActionBlock({
      status: 'ready-for-human',
      action: 'clarify',
      detail: input.currentActionDetail || 'Clarify and confirm the next action.',
      revision,
      updatedAt: this.now().toISOString(),
    });
    body = upsertCurrentActionBlock(body, block);
    const raw = await this.gh([
      'api',
      `repos/${this.binding.domain.slug}/issues`,
      '-f', `title=${title}`,
      '-f', `body=${body}`,
    ]);
    const issue = JSON.parse(raw);
    issue.url = issue.html_url || issue.url;
    if (!issue.url || !issue.number) throw new Error('GitHub did not confirm Issue creation');
    const itemId = await this.#addToProject(issue.url);
    await this.#setSelect(itemId, 'Status', 'ready-for-human');
    await this.#setSelect(itemId, 'next-action', 'clarify');
    await this.#setSelect(itemId, 'priority', input.priority || 'normal');
    await this.#setSelect(itemId, 'execution-authorized', 'no');
    await this.#setSelect(itemId, 'worker-state', 'idle');
    await this.#setText(itemId, 'task-revision', String(revision));
    if (nextActionDate) await this.#setDate(itemId, 'next-action-date', nextActionDate);
    if (input.deadline) {
      await this.#setDate(itemId, 'deadline', assertDate(input.deadline, 'deadline'));
    }
    if (input.workstream) {
      await this.#setText(itemId, 'workstream', await this.#validateWorkstream(input.workstream));
    }
    const confirmed = await this.#item(itemId);
    if (
      !confirmed
      || confirmed.issue.url !== issue.url
      || confirmed.fields.Status !== 'ready-for-human'
      || confirmed.fields['next-action'] !== 'clarify'
      || parseRevision(confirmed.fields['task-revision']) !== revision
    ) {
      throw new Error('GitHub did not verify the captured task');
    }
    return this.detail(itemId);
  }

  async importTodoistTask(record) {
    const sourceId = text(String(record.sourceId), 'sourceId', 200, { allowEmpty: false });
    const marker = `Pan: Todoist source task ${sourceId}`;
    const domainIssues = await this.#allDomainIssues();
    const malformed = domainIssues.filter((issue) =>
      String(issue.body ?? '').split(/\r?\n/).filter((line) => line === marker).length > 1);
    if (malformed.length) {
      throw new Error(`Todoist source ${sourceId} has duplicate markers in one Issue`);
    }
    const matches = domainIssues.filter((issue) =>
      String(issue.body ?? '').split(/\r?\n/).filter((line) => line === marker).length === 1);
    if (matches.length > 1) {
      throw new Error(`multiple Domain Issues have Todoist source marker ${sourceId}`);
    }
    let issue = matches[0] ?? null;
    let created = false;
    if (issue?.state === 'CLOSED') {
      throw new Error(`Todoist source ${sourceId} maps to a closed Issue`);
    }
    const currentActionDetail = record.currentActionDetail
      || 'Perform or reconsider the imported active task.';
    const sourceBody = text(record.body, 'body', 60000);
    const importedBody = record.recurrence
      ? sourceBody.replace(/\r?\n/, `\n${marker}\n`)
      : `${marker}\n\n${sourceBody}`;
    if (!issue) {
      const block = renderCurrentActionBlock({
        status: 'ready-for-human',
        action: 'act',
        detail: currentActionDetail,
        revision: 1,
        updatedAt: this.now().toISOString(),
      });
      const body = upsertCurrentActionBlock(importedBody, block);
      const raw = await this.gh([
        'api',
        `repos/${this.binding.domain.slug}/issues`,
        '-f', `title=${text(record.title, 'title', 256, { allowEmpty: false })}`,
        '-f', `body=${body}`,
      ]);
      const parsed = JSON.parse(raw);
      issue = {
        number: parsed.number,
        title: parsed.title,
        body: parsed.body,
        url: parsed.html_url,
        state: parsed.state === 'open' ? 'OPEN' : 'CLOSED',
      };
      created = true;
    }

    const projectMatches = (await this.#allItems()).filter((item) => item.issue.url === issue.url);
    if (projectMatches.length > 1) {
      throw new Error(`Todoist source ${sourceId} appears more than once in the configured Project`);
    }
    let projectItem = projectMatches[0] ?? null;
    let addedProject = false;
    if (!projectItem) {
      const itemId = await this.#addToProject(issue.url);
      projectItem = {
        itemId,
        fields: {},
        issue: {
          ...issue,
          repo: this.binding.domain.slug,
          createdAt: issue.createdAt,
          updatedAt: issue.updatedAt,
          closedAt: issue.closedAt,
        },
      };
      addedProject = true;
    }
    const itemId = projectItem.itemId;
    const workerState = projectItem.fields['worker-state'] || '';
    const runtimeBusy = (
      (workerState && !['idle', 'stopped'].includes(workerState))
      || projectItem.fields['claimed-by']
      || projectItem.fields['lease-until']
      || projectItem.fields.machine
      || projectItem.fields['session-id']
      || projectItem.fields['claim-generation']
    );
    if (runtimeBusy) {
      throw new Error(`Todoist source ${sourceId} has live or uncertain worker ownership`);
    }

    let existingComments = await this.#comments(this.binding.domain.slug, issue.number);
    const sourceCommentOccurrences = new Map();
    for (const comment of existingComments) {
      for (const match of String(comment.body ?? '').matchAll(/^Pan: Todoist source comment ([^\r\n]+)$/gm)) {
        const entries = sourceCommentOccurrences.get(match[1]) ?? [];
        entries.push(comment);
        sourceCommentOccurrences.set(match[1], entries);
      }
    }
    for (const [commentId, occurrences] of sourceCommentOccurrences) {
      if (occurrences.length > 1) {
        throw new Error(`Todoist source ${sourceId} has duplicate comment marker ${commentId}`);
      }
    }

    let currentBlock = parseCurrentActionBlock(issue.body ?? '');
    const currentRevision = parseRevision(projectItem.fields['task-revision'] ?? '');
    const transitionOccurrences = existingComments.filter(
      (comment) =>
        String(comment.body ?? '').split(/\r?\n/, 1)[0]
          === transitionMarker(currentBlock?.revision ?? currentRevision),
    );
    if (transitionOccurrences.length > 1) {
      throw new Error(`Todoist source ${sourceId} has duplicate lifecycle transition comments`);
    }
    const expectedFields = new Map([
      ['Status', 'ready-for-human'],
      ['next-action', 'act'],
      ['priority', record.priority || 'normal'],
      ['execution-authorized', 'no'],
      ['worker-state', 'idle'],
      ['next-action-date', assertDate(record.nextActionDate || '', 'nextActionDate')],
      ['deadline', assertDate(record.deadline || '', 'deadline')],
      ['workstream', record.workstream || ''],
      ['playbook', ''],
      ['dependencies', ''],
      ['needs-human-since', ''],
      ['claimed-by', ''],
      ['lease-until', ''],
      ['machine', ''],
      ['session-id', ''],
      ['claim-generation', ''],
    ]);
    const expectedCommentBodies = new Map((record.comments ?? []).map((comment) => [
      String(comment.id),
      `Pan: Todoist source comment ${comment.id}\n\n` +
        `Imported ${comment.postedAt || 'without a source timestamp'}:\n\n${comment.content}`,
    ]));
    const bodyWithoutBlock = currentBlock
      ? `${issue.body.slice(0, currentBlock.start)}${issue.body.slice(currentBlock.end)}`.trim()
      : String(issue.body ?? '').trim();
    const fieldChanges = [...expectedFields].filter(
      ([name, value]) => (projectItem.fields[name] ?? '') !== value,
    );
    const commentChanges = [...expectedCommentBodies].filter(([id, body]) => {
      const found = sourceCommentOccurrences.get(id);
      return !found || found[0].body !== body;
    });
    const issueProjectionChanged = (
      issue.title !== text(record.title, 'title', 256, { allowEmpty: false })
      || bodyWithoutBlock !== importedBody
      || !currentBlock
      || currentBlock.status !== 'ready-for-human'
      || currentBlock.action !== 'act'
      || currentBlock.detail !== currentActionDetail
    );
    const needsRevision = (
      addedProject
      || fieldChanges.length > 0
      || commentChanges.length > 0
      || issueProjectionChanged
    );
    const revisionLastRecovery = (
      !needsRevision
      && currentBlock.revision === currentRevision + 1
    );
    if (
      needsRevision
      && currentBlock
      && currentBlock.revision === currentRevision + 1
    ) {
      throw new Error(
        `Todoist source ${sourceId} interrupted revision-last recovery found ` +
          'independent non-revision projection drift',
      );
    }
    const needsRepair = (
      needsRevision
      || transitionOccurrences.length !== 1
      || revisionLastRecovery
    );
    let finalRevision = currentRevision;
    if (needsRevision) {
      if (currentBlock && currentBlock.revision > currentRevision) {
        throw new Error(`Todoist source ${sourceId} current-action revision is ahead of the Project`);
      }
      finalRevision = currentRevision + 1;
      currentBlock = {
        block: renderCurrentActionBlock({
          status: 'ready-for-human',
          action: 'act',
          detail: currentActionDetail,
          revision: finalRevision,
          updatedAt: this.now().toISOString(),
        }),
      };
    } else if (revisionLastRecovery) {
      finalRevision = currentBlock.revision;
    } else if (currentBlock.revision !== currentRevision) {
      throw new Error(`Todoist source ${sourceId} has mismatched Issue and Project revisions`);
    }

    for (const [name, value] of fieldChanges) {
      const field = this.#field(name);
      if (field.dataType === 'SINGLE_SELECT') await this.#setSelect(itemId, name, value);
      else if (field.dataType === 'DATE') await this.#setDate(itemId, name, value);
      else await this.#setText(itemId, name, value);
    }
    const expectedBody = upsertCurrentActionBlock(importedBody, currentBlock.block);
    if (
      issue.title !== record.title
      || issue.body !== expectedBody
    ) {
      await this.#editIssue(this.binding.domain.slug, issue.number, {
        title: text(record.title, 'title', 256, { allowEmpty: false }),
        body: expectedBody,
      });
    }
    for (const comment of record.comments ?? []) {
      const commentMarker = `Pan: Todoist source comment ${comment.id}`;
      const expectedBody = expectedCommentBodies.get(String(comment.id));
      const existing = sourceCommentOccurrences.get(String(comment.id))?.[0];
      if (!existing) {
        await this.gh([
          'issue', 'comment', String(issue.number),
          '--repo', this.binding.domain.slug,
          '--body', expectedBody,
        ]);
      } else if (existing.body !== expectedBody) {
        await this.gh([
          'api',
          `repos/${this.binding.domain.slug}/issues/comments/${existing.id}`,
          '-X', 'PATCH',
          '-f', `body=${expectedBody}`,
        ]);
      }
    }
    await ensureIssueComment(
      this.gh,
      this.binding.domain.slug,
      issue.number,
      transitionMarker(finalRevision),
      transitionComment({
        revision: finalRevision,
        fromStatus: projectItem.fields.Status || '',
        fromAction: projectItem.fields['next-action'] || '',
        toStatus: 'ready-for-human',
        toAction: 'act',
        detail: currentActionDetail,
        actor: 'Pan Todoist migration',
      }),
    );
    if (currentRevision !== finalRevision) {
      await this.#setText(itemId, 'task-revision', String(finalRevision));
    }
    const confirmed = await this.#item(itemId);
    const confirmedBlock = confirmed
      ? parseCurrentActionBlock(confirmed.issue.body)
      : null;
    if (
      !confirmed
      || confirmed.issue.url !== issue.url
      || confirmed.issue.title !== record.title
      || confirmed.issue.body !== expectedBody
      || confirmed.fields.Status !== 'ready-for-human'
      || confirmed.fields['next-action'] !== 'act'
      || confirmed.fields.priority !== (record.priority || 'normal')
      || confirmed.fields['execution-authorized'] !== 'no'
      || confirmed.fields['worker-state'] !== 'idle'
      || (confirmed.fields['next-action-date'] || '') !== (record.nextActionDate || '')
      || (confirmed.fields.deadline || '') !== (record.deadline || '')
      || (confirmed.fields.workstream || '') !== (record.workstream || '')
      || confirmed.fields.playbook
      || confirmed.fields.dependencies
      || confirmed.fields['needs-human-since']
      || confirmed.fields['claimed-by']
      || confirmed.fields['lease-until']
      || confirmed.fields.machine
      || confirmed.fields['session-id']
      || confirmed.fields['claim-generation']
      || parseRevision(confirmed.fields['task-revision'] ?? '') !== finalRevision
      || !confirmedBlock
      || confirmedBlock.revision !== finalRevision
      || confirmedBlock.status !== 'ready-for-human'
      || confirmedBlock.action !== 'act'
      || confirmedBlock.detail !== currentActionDetail
    ) {
      throw new Error(`GitHub did not verify Todoist source ${sourceId}`);
    }
    existingComments = await this.#comments(this.binding.domain.slug, issue.number);
    const confirmedMarkers = new Map();
    for (const comment of existingComments) {
      for (const match of String(comment.body ?? '').matchAll(/^Pan: Todoist source comment ([^\r\n]+)$/gm)) {
        const entries = confirmedMarkers.get(match[1]) ?? [];
        entries.push(comment);
        confirmedMarkers.set(match[1], entries);
      }
    }
    for (const comment of record.comments ?? []) {
      const confirmedComment = confirmedMarkers.get(String(comment.id)) ?? [];
      if (
        confirmedComment.length !== 1
        || confirmedComment[0].body !== expectedCommentBodies.get(String(comment.id))
      ) {
        throw new Error(`GitHub did not verify Todoist comment ${comment.id}`);
      }
    }
    return {
      sourceId,
      issueUrl: issue.url,
      itemId,
      outcome: created ? 'created' : needsRepair ? 'repaired' : 'verified',
    };
  }

  async todoistSourceIndex() {
    const issues = await this.#allDomainIssues();
    const projectUrls = new Set((await this.#allItems()).map((item) => item.issue.url));
    const bySourceId = new Map();
    for (const issue of issues) {
      const markers = [...String(issue.body ?? '').matchAll(/^Pan: Todoist source task ([^\r\n]+)$/gm)];
      for (const match of markers) {
        const entry = {
          sourceId: match[1],
          issueUrl: issue.url,
          number: issue.number,
          state: issue.state,
          inProject: projectUrls.has(issue.url),
          duplicateMarker: markers.filter((candidate) => candidate[1] === match[1]).length > 1,
        };
        const current = bySourceId.get(entry.sourceId) ?? [];
        current.push(entry);
        bySourceId.set(entry.sourceId, current);
      }
    }
    return bySourceId;
  }

  async verifyTodoistTask(record) {
    const sourceId = String(record.sourceId);
    const matches = (await this.todoistSourceIndex()).get(sourceId) ?? [];
    if (matches.length !== 1) {
      return {
        sourceId,
        outcome: 'conflict',
        error: `expected one source Issue, found ${matches.length}`,
      };
    }
    const match = matches[0];
    if (match.state !== 'OPEN') {
      return { sourceId, outcome: 'conflict', error: 'source Issue is closed' };
    }
    const projectMatches = (await this.#allItems()).filter(
      (candidate) => candidate.issue.url === match.issueUrl,
    );
    if (projectMatches.length !== 1) {
      return {
        sourceId,
        outcome: projectMatches.length > 1 ? 'conflict' : 'failed',
        error: projectMatches.length > 1
          ? 'source Issue appears more than once in the Project'
          : 'source Issue is not in the Project',
      };
    }
    const item = projectMatches[0];
    const marker = `Pan: Todoist source task ${sourceId}`;
    const sourceBody = text(record.body, 'body', 60000);
    const importedBody = record.recurrence
      ? sourceBody.replace(/\r?\n/, `\n${marker}\n`)
      : `${marker}\n\n${sourceBody}`;
    let block;
    try {
      block = parseCurrentActionBlock(item.issue.body);
    } catch (error) {
      return { sourceId, outcome: 'conflict', error: error.message };
    }
    const baseBody = block
      ? `${item.issue.body.slice(0, block.start)}${item.issue.body.slice(block.end)}`.trim()
      : item.issue.body.trim();
    const expectedDetail = record.currentActionDetail
      || 'Perform or reconsider the imported active task.';
    const expectedFields = {
      Status: 'ready-for-human',
      'next-action': 'act',
      priority: record.priority || 'normal',
      'execution-authorized': 'no',
      'worker-state': 'idle',
      'next-action-date': record.nextActionDate || '',
      deadline: record.deadline || '',
      workstream: record.workstream || '',
      playbook: '',
      dependencies: '',
      'needs-human-since': '',
      'claimed-by': '',
      'lease-until': '',
      machine: '',
      'session-id': '',
      'claim-generation': '',
    };
    const mismatchedFields = Object.entries(expectedFields)
      .filter(([name, value]) => (item.fields[name] ?? '') !== value)
      .map(([name]) => name);
    if (
      item.issue.title !== record.title
      || baseBody !== importedBody
      || !block
      || block.status !== 'ready-for-human'
      || block.action !== 'act'
      || block.detail !== expectedDetail
      || block.revision !== parseRevision(item.fields['task-revision'] ?? '')
      || mismatchedFields.length
    ) {
      return {
        sourceId,
        outcome: 'conflict',
        error: 'Issue, Project fields, or lifecycle projection does not exactly match the import',
      };
    }
    const comments = await this.#comments(this.binding.domain.slug, match.number);
    for (const comment of record.comments ?? []) {
      const markerLine = `Pan: Todoist source comment ${comment.id}`;
      const expectedBody = `${markerLine}\n\n` +
        `Imported ${comment.postedAt || 'without a source timestamp'}:\n\n${comment.content}`;
      const matchesForComment = comments.filter((entry) =>
        String(entry.body ?? '').split(/\r?\n/).includes(markerLine));
      if (matchesForComment.length !== 1 || matchesForComment[0].body !== expectedBody) {
        return {
          sourceId,
          outcome: 'failed',
          error: `missing, duplicate, or mismatched imported comment ${comment.id}`,
        };
      }
    }
    const allSourceMarkers = new Map();
    for (const comment of comments) {
      for (const sourceMarker of String(comment.body ?? '').matchAll(/^Pan: Todoist source comment ([^\r\n]+)$/gm)) {
        allSourceMarkers.set(
          sourceMarker[1],
          (allSourceMarkers.get(sourceMarker[1]) ?? 0) + 1,
        );
      }
    }
    if ([...allSourceMarkers.values()].some((count) => count > 1)) {
      return {
        sourceId,
        outcome: 'conflict',
        error: 'duplicate Todoist source comment markers exist',
      };
    }
    const transitionMatches = comments.filter(
      (comment) =>
        String(comment.body ?? '').split(/\r?\n/, 1)[0] === transitionMarker(block.revision),
    );
    if (transitionMatches.length !== 1) {
      return {
        sourceId,
        outcome: 'conflict',
        error: 'missing or duplicate lifecycle transition comment',
      };
    }
    return { sourceId, outcome: 'verified', issueUrl: match.issueUrl, itemId: item.itemId };
  }

  async migrateLegacyItem(action) {
    const item = await this.#item(action.itemId);
    if (!item) throw new Error('legacy Project item no longer exists');
    const expected = action.expected;
    if (
      typeof expected.projection !== 'string'
      || projectionFingerprint(item) !== expected.projection
      || (item.fields.owner || 'unassigned') !== expected.owner
      || item.fields.Status !== expected.status
      || (item.fields['next-action'] || '') !== (expected.nextAction || '')
      || (item.fields['worker-state'] || '') !== (expected.workerState || '')
      || (item.fields['execution-authorized'] || '') !== (expected.executionAuthorized || '')
      || (item.fields.dependencies || '') !== (expected.dependencies || '')
      || (item.fields.playbook || '') !== (expected.playbook || '')
      || (item.fields['claimed-by'] || '') !== (expected.claimedBy || '')
      || (item.fields['lease-until'] || '') !== (expected.leaseUntil || '')
      || (item.fields.machine || '') !== (expected.machine || '')
      || (item.fields['session-id'] || '') !== (expected.sessionId || '')
      || (item.fields['claim-generation'] || '') !== (expected.claimGeneration || '')
      || (item.fields['resource-semantics'] || '') !== (expected.resourceSemantics || '')
      || parseRevision(item.fields['task-revision'] || '') !== parseRevision(expected.revision || '')
      || item.issue.state !== expected.issueState
      || item.issue.stateReason !== expected.issueStateReason
    ) {
      throw new Error('legacy item changed after the migration plan was generated');
    }
    const target = action.target;
    if (!validLifecyclePair(target.status, target.nextAction)) {
      throw new Error('migration target has an invalid lifecycle pair');
    }
    const terminal = isTerminalStatus(target.status);
    if (!terminal && item.issue.state === 'CLOSED') {
      throw new Error('closed Issue with a nonterminal lifecycle requires reconciliation');
    }
    const expectedRevision = parseRevision(item.fields['task-revision'] || '');
    const currentBlock = parseCurrentActionBlock(item.issue.body);
    let nextRevision = expectedRevision + 1;
    if (
      currentBlock
      && currentBlock.status === target.status
      && currentBlock.action === target.nextAction
      && currentBlock.detail === target.detail
      && currentBlock.revision === expectedRevision + 1
    ) {
      nextRevision = currentBlock.revision;
    } else if (currentBlock && currentBlock.revision > expectedRevision) {
      throw new Error('Issue current-next-action revision is ahead of the migration plan');
    }
    if (terminal) {
      if (item.fields['next-action-date']) {
        await this.#setDate(item.itemId, 'next-action-date', '');
        const cleared = await this.#item(item.itemId);
        if (!cleared || cleared.fields['next-action-date']) {
          throw new Error('GitHub did not verify terminal migration date cleanup');
        }
      }
      if (target.status === 'done') {
        await ensureIssueClosed(this.gh, item.issue.repo, item.issue.number);
      } else {
        await ensureIssueRejected(this.gh, item.issue.repo, item.issue.number);
      }
    }
    const expectedFields = new Map([
      ['next-action', target.nextAction],
      ['execution-authorized', target.executionAuthorized],
      ['dependencies', target.dependencies || ''],
      ['worker-state', target.workerState],
      ['claimed-by', ''],
      ['lease-until', ''],
      ['machine', item.fields.machine || ''],
      ['session-id', item.fields['session-id'] || ''],
      ['claim-generation', item.fields['claim-generation'] || ''],
      ['resource-semantics', action.preserve.resourceSemantics || ''],
    ]);
    for (const [name, value] of expectedFields) {
      if ((item.fields[name] || '') === value) continue;
      const field = this.#field(name);
      if (field.dataType === 'SINGLE_SELECT') await this.#setSelect(item.itemId, name, value);
      else await this.#setText(item.itemId, name, value);
    }
    await this.#setSelect(item.itemId, 'Status', target.status);
    if (
      !currentBlock
      || currentBlock.status !== target.status
      || currentBlock.action !== target.nextAction
      || currentBlock.detail !== target.detail
      || currentBlock.revision !== nextRevision
    ) {
      await updateIssueCurrentAction(
        this.gh,
        item.issue.repo,
        item.issue.number,
        {
          expectedRevision: currentBlock?.revision ?? expectedRevision,
          revision: nextRevision,
          status: target.status,
          action: target.nextAction,
          detail: target.detail,
          actor: 'Pan lifecycle migration',
          claimGeneration: terminal ? '' : (item.fields['claim-generation'] || ''),
          fromStatus: item.fields.Status || '',
          fromAction: item.fields['next-action'] || '',
          updatedAt: this.now().toISOString(),
        },
      );
    } else {
      await ensureIssueComment(
        this.gh,
        item.issue.repo,
        item.issue.number,
        transitionMarker(nextRevision),
        transitionComment({
          revision: nextRevision,
          fromStatus: item.fields.Status || '',
          fromAction: item.fields['next-action'] || '',
          toStatus: target.status,
          toAction: target.nextAction,
          detail: target.detail,
          actor: 'Pan lifecycle migration',
          claimGeneration: terminal ? '' : (item.fields['claim-generation'] || ''),
        }),
      );
    }
    await this.#setText(item.itemId, 'task-revision', String(nextRevision));
    const confirmed = await this.#item(item.itemId);
    const confirmedBlock = confirmed
      ? parseCurrentActionBlock(confirmed.issue.body)
      : null;
    if (
      !confirmed
      || confirmed.fields.Status !== target.status
      || confirmed.fields['next-action'] !== target.nextAction
      || confirmed.fields['execution-authorized'] !== target.executionAuthorized
      || (confirmed.fields.dependencies || '') !== (target.dependencies || '')
      || confirmed.fields['worker-state'] !== target.workerState
      || confirmed.fields['claimed-by']
      || confirmed.fields['lease-until']
      || (confirmed.fields.machine || '') !== (item.fields.machine || '')
      || (confirmed.fields['session-id'] || '') !== (item.fields['session-id'] || '')
      || (confirmed.fields['claim-generation'] || '') !== (item.fields['claim-generation'] || '')
      || (confirmed.fields['resource-semantics'] || '') !== (action.preserve.resourceSemantics || '')
      || (terminal && confirmed.fields['next-action-date'])
      || parseRevision(confirmed.fields['task-revision']) !== nextRevision
      || !confirmedBlock
      || confirmedBlock.revision !== nextRevision
      || confirmedBlock.status !== target.status
      || confirmedBlock.action !== target.nextAction
      || confirmedBlock.detail !== target.detail
      || (
        terminal
        && (
          confirmed.issue.state !== 'CLOSED'
          || confirmed.issue.stateReason !== (target.status === 'done' ? 'COMPLETED' : 'NOT_PLANNED')
        )
      )
      || (!terminal && confirmed.issue.state !== 'OPEN')
    ) {
      throw new Error('GitHub did not verify lifecycle migration');
    }
    return {
      itemId: item.itemId,
      issueUrl: item.issue.url,
      outcome: 'migrated',
      revision: nextRevision,
      target: {
        status: target.status,
        nextAction: target.nextAction,
        workerState: target.workerState,
      },
    };
  }

  async rollbackLifecycleItem(action) {
    const item = await this.#item(action.itemId);
    if (!item) throw new Error('rollback Project item no longer exists');
    if (
      !action.expected
      || typeof action.expected.projection !== 'string'
      || projectionFingerprint(item) !== action.expected.projection
      || (item.fields.playbook || '') !== (action.expected.playbook || '')
    ) {
      throw new Error('rollback item changed after the current-state plan was generated');
    }
    const source = action.source;
    const target = action.legacyTarget;
    if (
      !source
      || !validLifecyclePair(source.status, source.nextAction)
      || !target
      || !['unassigned', 'human', 'agent'].includes(target.owner)
      || !['untriaged', 'needs-detail', 'ready', 'in-progress', 'paused', 'in-review', 'blocked', 'done', 'rejected']
        .includes(target.status)
    ) {
      throw new Error('rollback plan has an invalid source or legacy target');
    }
    const rollbackUnsafe = rollbackSafetyReason({
      status: source.status,
      workerState: item.fields['worker-state'] || '',
      needsHumanSince: item.fields['needs-human-since'] || '',
      claimedBy: item.fields['claimed-by'] || '',
      leaseUntil: item.fields['lease-until'] || '',
      machine: item.fields.machine || '',
      sessionId: item.fields['session-id'] || '',
      claimGeneration: item.fields['claim-generation'] || '',
      resourceSemantics: item.fields['resource-semantics'] || '',
    }, source.status);
    if (rollbackUnsafe) throw new Error(rollbackUnsafe);
    if (
      ['done', 'rejected'].includes(source.status)
        ? (
          item.issue.state !== 'CLOSED'
          || item.issue.stateReason !== (source.status === 'done' ? 'COMPLETED' : 'NOT_PLANNED')
        )
        : item.issue.state !== 'OPEN'
    ) {
      throw new Error('rollback refuses to reverse external Issue state');
    }
    const currentBlock = parseCurrentActionBlock(item.issue.body);
    const currentRevision = parseRevision(item.fields['task-revision'] || '');
    if (
      !currentBlock
      || currentBlock.status !== source.status
      || currentBlock.action !== source.nextAction
      || currentBlock.detail !== source.detail
      || ![currentRevision, currentRevision + 1].includes(currentBlock.revision)
    ) {
      throw new Error('rollback source no longer matches the Issue current-action projection');
    }
    if (
      ![source.status, target.status].includes(item.fields.Status)
      || ![action.expected.owner, target.owner].includes(item.fields.owner || 'unassigned')
    ) {
      throw new Error('rollback Project fields are not a monotonic source-to-target state');
    }
    const preservedFields = { ...item.fields };
    const originalBaseBody = `${
      item.issue.body.slice(0, currentBlock.start)
    }${item.issue.body.slice(currentBlock.end)}`.trim();
    const nextRevision = currentBlock.revision === currentRevision + 1
      ? currentBlock.revision
      : currentRevision + 1;
    if (currentBlock.revision === currentRevision) {
      await updateIssueCurrentAction(
        this.gh,
        item.issue.repo,
        item.issue.number,
        {
          expectedRevision: currentRevision,
          revision: nextRevision,
          status: source.status,
          action: source.nextAction,
          detail: source.detail,
          actor: 'Pan lifecycle rollback',
          claimGeneration: item.fields['claim-generation'] || '',
          fromStatus: source.status,
          fromAction: source.nextAction,
          updatedAt: this.now().toISOString(),
        },
      );
    } else {
      await ensureIssueComment(
        this.gh,
        item.issue.repo,
        item.issue.number,
        transitionMarker(nextRevision),
        transitionComment({
          revision: nextRevision,
          fromStatus: source.status,
          fromAction: source.nextAction,
          toStatus: source.status,
          toAction: source.nextAction,
          detail: source.detail,
          actor: 'Pan lifecycle rollback',
          claimGeneration: item.fields['claim-generation'] || '',
        }),
      );
    }
    if ((item.fields.owner || 'unassigned') !== target.owner) {
      await this.#setSelect(item.itemId, 'owner', target.owner);
    }
    if (item.fields.Status !== target.status) {
      await this.#setSelect(item.itemId, 'Status', target.status);
    }
    if (currentRevision !== nextRevision) {
      await this.#setText(item.itemId, 'task-revision', String(nextRevision));
    }
    const confirmed = await this.#item(item.itemId);
    const confirmedBlock = confirmed
      ? parseCurrentActionBlock(confirmed.issue.body)
      : null;
    const confirmedBaseBody = confirmed && confirmedBlock
      ? `${
        confirmed.issue.body.slice(0, confirmedBlock.start)
      }${confirmed.issue.body.slice(confirmedBlock.end)}`.trim()
      : '';
    const preservedFieldNames = Object.keys(preservedFields).filter(
      (name) => !['owner', 'Status', 'task-revision'].includes(name),
    );
    if (
      !confirmed
      || (confirmed.fields.owner || 'unassigned') !== target.owner
      || confirmed.fields.Status !== target.status
      || parseRevision(confirmed.fields['task-revision'] || '') !== nextRevision
      || !confirmedBlock
      || confirmedBlock.revision !== nextRevision
      || confirmedBlock.status !== source.status
      || confirmedBlock.action !== source.nextAction
      || confirmedBlock.detail !== source.detail
      || confirmed.issue.title !== item.issue.title
      || confirmed.issue.state !== item.issue.state
      || confirmed.issue.stateReason !== item.issue.stateReason
      || confirmedBaseBody !== originalBaseBody
      || preservedFieldNames.some(
        (name) => (confirmed.fields[name] || '') !== (preservedFields[name] || ''),
      )
    ) {
      throw new Error('GitHub did not verify the complete lifecycle rollback');
    }
    return {
      itemId: item.itemId,
      issueUrl: item.issue.url,
      outcome: 'rolled-back',
      revision: nextRevision,
      legacyTarget: target,
    };
  }

  async #assertMutable(input) {
    const item = await this.#item(input.itemId);
    if (!item) throw Object.assign(new Error('task not found'), { statusCode: 404 });
    const liveRevision = parseRevision(item.fields['task-revision'] ?? '');
    if (parseRevision(input.revision) !== liveRevision) {
      throw Object.assign(
        new Error(`stale task revision: expected ${input.revision}, live is ${liveRevision}`),
        { statusCode: 409 },
      );
    }
    if (
      typeof input.projection !== 'string'
      || input.projection !== projectionFingerprint(item)
    ) {
      throw Object.assign(
        new Error('stale task projection: Issue, Project, or ownership state changed'),
        { statusCode: 409 },
      );
    }
    return { item, liveRevision };
  }

  #assertHistoricalProvenanceMutation(item, operation, input) {
    if (item.fields['resource-semantics'] !== 'historical-provenance') return;
    const changes = operation === 'edit' ? (input.changes ?? {}) : {};
    const protectedChanges = [
      ['status', item.fields.Status],
      ['nextAction', item.fields['next-action']],
      ['workerState', item.fields['worker-state']],
      ['executionAuthorized', item.fields['execution-authorized']],
      ['resourceSemantics', 'historical-provenance'],
    ];
    const changesHistoricalEvidence = protectedChanges.some(
      ([name, current]) =>
        changes[name] !== undefined
        && changes[name] !== current,
    );
    if (
      changesHistoricalEvidence
      || ['hold', 'handoff-ai', 'handoff-human', 'external-wait'].includes(operation)
    ) {
      throw Object.assign(
        new Error(
          `${operation} cannot reclassify or resume historical provenance; ` +
          'only checked operator migration or rollback may preserve this evidence',
        ),
        { statusCode: 409 },
      );
    }
  }

  #assertNoLiveWorker(item, operation) {
    const workerState = item.fields['worker-state'] ?? '';
    const claimedBy = item.fields['claimed-by'] ?? '';
    const leaseUntil = item.fields['lease-until'] ?? '';
    if (ACTIVE_WORKER_STATES.has(workerState) || claimedBy || leaseUntil) {
      throw Object.assign(
        new Error(
          `${operation} would disturb a live or uncertain worker; continue in the worker terminal ` +
          'or checkpoint it first',
        ),
        { statusCode: 409 },
      );
    }
  }

  #assertNoRetainedAffinity(item, operation) {
    if (
      item.fields.machine
      || item.fields['session-id']
      || item.fields['claim-generation']
    ) {
      throw Object.assign(
        new Error(
          `${operation} cannot complete a task with retained workspace affinity; ` +
          'resume it or use checked runner/operator terminal cleanup',
        ),
        { statusCode: 409 },
      );
    }
  }

  async #editIssue(repo, number, changes) {
    const args = ['issue', 'edit', String(number), '--repo', repo];
    if (changes.title !== undefined) args.push('--title', changes.title);
    if (changes.body !== undefined) args.push('--body', changes.body);
    if (args.length > 6) await this.gh(args);
  }

  async #transition(item, liveRevision, {
    status,
    action,
    detail,
    actor = 'Pan task UI',
    workerState,
    needsHumanSince,
    resourceSemantics,
    issueTitle,
    issueDetails,
  }) {
    if (!validLifecyclePair(status, action)) {
      throw new Error(`invalid transition target ${status}/${action}`);
    }
    if (
      item.fields['resource-semantics'] === 'historical-provenance'
      && (
        !['done', 'rejected'].includes(status)
        || (
          workerState !== undefined
          && workerState !== item.fields['worker-state']
        )
        || (
          resourceSemantics !== undefined
          && resourceSemantics !== 'historical-provenance'
        )
      )
    ) {
      throw Object.assign(
        new Error(
          'transition cannot reclassify or resume historical provenance; ' +
          'only checked operator migration or rollback may preserve this evidence',
        ),
        { statusCode: 409 },
      );
    }
    const nextRevision = liveRevision + 1;
    await this.#setSelect(item.itemId, 'next-action', action);
    if (workerState) await this.#setSelect(item.itemId, 'worker-state', workerState);
    if (needsHumanSince !== undefined) {
      await this.#setText(item.itemId, 'needs-human-since', needsHumanSince);
    }
    if (resourceSemantics !== undefined) {
      await this.#setSelect(item.itemId, 'resource-semantics', resourceSemantics);
    }
    await this.#setSelect(item.itemId, 'Status', status);
    await updateIssueCurrentAction(
      this.gh,
      item.issue.repo,
      item.issue.number,
      {
        expectedRevision: liveRevision,
        revision: nextRevision,
        status,
        action,
        detail,
        actor,
        claimGeneration: item.fields['claim-generation'] ?? '',
        fromStatus: item.fields.Status ?? '',
        fromAction: item.fields['next-action'] ?? '',
        updatedAt: this.now().toISOString(),
      },
    );
    if (issueTitle !== undefined || issueDetails !== undefined) {
      const projected = await this.#item(item.itemId);
      if (!projected) throw new Error('task disappeared while updating its Issue projection');
      const projectedBlock = parseCurrentActionBlock(projected.issue.body);
      if (!projectedBlock || projectedBlock.revision !== nextRevision) {
        throw new Error('Issue current-next-action projection changed during the edit');
      }
      const body = issueDetails === undefined
        ? undefined
        : upsertCurrentActionBlock(
          text(issueDetails, 'details', 60000),
          projectedBlock.block,
        );
      await this.#editIssue(projected.issue.repo, projected.issue.number, {
        title: issueTitle,
        body,
      });
    }
    await this.#setText(item.itemId, 'task-revision', String(nextRevision));
    const confirmed = await this.#item(item.itemId);
    const confirmedBlock = confirmed
      ? parseCurrentActionBlock(confirmed.issue.body)
      : null;
    const confirmedDetails = confirmed && confirmedBlock
      ? `${confirmed.issue.body.slice(0, confirmedBlock.start)}${
        confirmed.issue.body.slice(confirmedBlock.end)
      }`.trim()
      : confirmed?.issue.body?.trim();
    if (
      !confirmed
      || confirmed.fields.Status !== status
      || confirmed.fields['next-action'] !== action
      || (
        resourceSemantics !== undefined
        && (confirmed.fields['resource-semantics'] || '') !== resourceSemantics
      )
      || parseRevision(confirmed.fields['task-revision']) !== nextRevision
      || !confirmedBlock
      || confirmedBlock.revision !== nextRevision
      || confirmedBlock.status !== status
      || confirmedBlock.action !== action
      || confirmedBlock.detail !== detail
      || (issueTitle !== undefined && confirmed.issue.title !== issueTitle)
      || (
        issueDetails !== undefined
        && confirmedDetails !== text(issueDetails, 'details', 60000)
      )
    ) {
      throw new Error('GitHub did not confirm the requested transition');
    }
    return confirmed;
  }

  async #findRecurringSuccessor(item) {
    const comments = await this.#comments(item.issue.repo, item.issue.number);
    const issues = await this.#allDomainIssues();
    return resolveRecurringSuccessorEvidence({
      currentUrl: item.issue.url,
      domainSlug: this.binding.domain.slug,
      comments,
      issues,
    });
  }

  #recurringSuccessorBody(item, nextOccurrence) {
    const currentBlock = parseCurrentActionBlock(item.issue.body);
    let reusable = `${item.issue.body.slice(0, currentBlock?.start ?? item.issue.body.length)}${
      currentBlock ? item.issue.body.slice(currentBlock.end) : ''
    }`
      .replace(/^Pan: recurrence occurrence \d{4}-\d{2}-\d{2}\s*/m, '')
      .replace(/^Pan: previous occurrence https:\/\/github\.com\/[^\s]+\s*/m, '')
      .replace(/^Pan: Todoist source task [^\r\n]+\s*/m, '')
      .replace(/^Pan import note:[^\r\n]*\s*/m, '')
      .trim();
    if (/^Source URL:/m.test(reusable) && /^## Imported active description\s*$/m.test(reusable)) {
      const imported = /^## Imported active description\s*\n([\s\S]*?)(?=^## Recurrence\s*$)/m.exec(reusable);
      const recurrence = /^## Recurrence\s*\n[\s\S]*$/m.exec(reusable);
      reusable = [imported?.[1]?.trim(), recurrence?.[0]?.trim()].filter(Boolean).join('\n\n');
    }
    return [
      `Pan: recurrence occurrence ${nextOccurrence}`,
      `Pan: previous occurrence ${item.issue.url}`,
      '',
      reusable,
    ].join('\n').trim();
  }

  async #ensureRecurringSuccessor(item, successor, schedule) {
    if (successor.state !== 'OPEN') {
      throw new Error('recurring successor is not open');
    }
    const expectedBaseBody = this.#recurringSuccessorBody(item, schedule.nextOccurrence);
    let projectItems = (await this.#allItems()).filter(
      (candidate) => candidate.issue.url === successor.url,
    );
    if (projectItems.length > 1) {
      throw new Error('recurring successor appears more than once in the configured Project');
    }
    if (!projectItems.length) {
      const itemId = await this.#addToProject(successor.url);
      projectItems = [{
        itemId,
        projectUpdatedAt: null,
        fields: {},
        issue: {
          ...successor,
          repo: this.binding.domain.slug,
          createdAt: successor.createdAt,
          updatedAt: successor.updatedAt,
          closedAt: successor.closedAt,
        },
      }];
    }
    let successorItem = projectItems[0];
    const currentRevision = parseRevision(successorItem.fields['task-revision'] ?? '');
    let block = parseCurrentActionBlock(successor.body ?? '');
    const desiredDetail = `Perform the recurrence occurrence scheduled for ${schedule.nextOccurrence}.`;
    const actualBaseBody = block
      ? `${successor.body.slice(0, block.start)}${successor.body.slice(block.end)}`.trim()
      : String(successor.body ?? '').trim();
    const expectedFields = new Map([
      ['Status', 'ready-for-human'],
      ['next-action', 'act'],
      ['priority', item.fields.priority || 'normal'],
      ['execution-authorized', 'no'],
      ['worker-state', 'idle'],
      ['next-action-date', schedule.nextOccurrence],
      ['workstream', item.fields.workstream || ''],
      ['playbook', ''],
      ['dependencies', ''],
      ['needs-human-since', ''],
      ['claimed-by', ''],
      ['lease-until', ''],
      ['machine', ''],
      ['session-id', ''],
      ['claim-generation', ''],
    ]);
    const fieldChanges = [...expectedFields].filter(
      ([name, value]) => (successorItem.fields[name] ?? '') !== value,
    );
    const blockMatches = (
      block
      && block.status === 'ready-for-human'
      && block.action === 'act'
      && block.detail === desiredDetail
    );
    const needsRevision = (
      successor.title !== item.issue.title
      || actualBaseBody !== expectedBaseBody
      || fieldChanges.length > 0
      || !blockMatches
    );
    const revisionLastRecovery = (
      !needsRevision
      && block.revision === currentRevision + 1
    );
    if (
      needsRevision
      && block
      && block.revision === currentRevision + 1
    ) {
      throw new Error(
        'recurring successor interrupted revision-last recovery found ' +
          'independent non-revision projection drift',
      );
    }
    let finalRevision = currentRevision;
    if (needsRevision) {
      if (block && block.revision > currentRevision) {
        throw new Error('recurring successor current-action revision is ahead of its Project item');
      }
      finalRevision = currentRevision + 1;
      block = {
        block: renderCurrentActionBlock({
          status: 'ready-for-human',
          action: 'act',
          detail: desiredDetail,
          revision: finalRevision,
          updatedAt: this.now().toISOString(),
        }),
      };
    } else if (revisionLastRecovery) {
      finalRevision = block.revision;
    } else if (block.revision !== currentRevision) {
      throw new Error('recurring successor Issue and Project revisions disagree');
    }
    const desiredBody = upsertCurrentActionBlock(expectedBaseBody, block.block);
    // Project fields precede the Issue revision boundary. Therefore an Issue
    // already at Project+1 is recoverable only when every non-revision field is
    // exact; a crash before this point leaves the Issue at the old revision.
    for (const [name, value] of fieldChanges) {
      const field = this.#field(name);
      if (field.dataType === 'SINGLE_SELECT') await this.#setSelect(successorItem.itemId, name, value);
      else if (field.dataType === 'DATE') await this.#setDate(successorItem.itemId, name, value);
      else await this.#setText(successorItem.itemId, name, value);
    }
    if (successor.title !== item.issue.title || successor.body !== desiredBody) {
      await this.#editIssue(this.binding.domain.slug, successor.number, {
        title: item.issue.title,
        body: desiredBody,
      });
    }
    await ensureIssueComment(
      this.gh,
      this.binding.domain.slug,
      successor.number,
      transitionMarker(finalRevision),
      transitionComment({
        revision: finalRevision,
        fromStatus: successorItem.fields.Status || '',
        fromAction: successorItem.fields['next-action'] || '',
        toStatus: 'ready-for-human',
        toAction: 'act',
        detail: desiredDetail,
        actor: 'Pan recurrence rollover',
      }),
    );
    if (currentRevision !== finalRevision) {
      await this.#setText(successorItem.itemId, 'task-revision', String(finalRevision));
      const revisionConfirmed = await this.#item(successorItem.itemId);
      const revisionConfirmedBlock = revisionConfirmed
        ? parseCurrentActionBlock(revisionConfirmed.issue.body)
        : null;
      if (
        !revisionConfirmed
        || parseRevision(revisionConfirmed.fields['task-revision'] ?? '') !== finalRevision
        || !revisionConfirmedBlock
        || revisionConfirmedBlock.revision !== finalRevision
      ) {
        throw new Error('GitHub did not verify recurring successor revision repair');
      }
    }
    successorItem = await this.#item(successorItem.itemId);
    const confirmedBlock = successorItem
      ? parseCurrentActionBlock(successorItem.issue.body)
      : null;
    if (
      !successorItem
      || successorItem.issue.url !== successor.url
      || successorItem.issue.state !== 'OPEN'
      || successorItem.issue.title !== item.issue.title
      || successorItem.fields.Status !== 'ready-for-human'
      || successorItem.fields['next-action'] !== 'act'
      || successorItem.fields.priority !== (item.fields.priority || 'normal')
      || successorItem.fields['execution-authorized'] !== 'no'
      || successorItem.fields['worker-state'] !== 'idle'
      || successorItem.fields['next-action-date'] !== schedule.nextOccurrence
      || (successorItem.fields.workstream || '') !== (item.fields.workstream || '')
      || successorItem.fields.playbook
      || successorItem.fields.dependencies
      || successorItem.fields['needs-human-since']
      || successorItem.fields['claimed-by']
      || successorItem.fields['lease-until']
      || successorItem.fields.machine
      || successorItem.fields['session-id']
      || successorItem.fields['claim-generation']
      || parseRevision(successorItem.fields['task-revision'] ?? '') !== finalRevision
      || !confirmedBlock
      || confirmedBlock.revision !== finalRevision
      || confirmedBlock.status !== 'ready-for-human'
      || confirmedBlock.action !== 'act'
      || confirmedBlock.detail !== desiredDetail
      || successorItem.issue.body !== desiredBody
    ) {
      throw new Error('GitHub did not verify the complete recurring successor');
    }
    return successorItem;
  }

  async #ensureRecurringBacklink(item, successorUrl, schedule) {
    const marker = `Pan: next occurrence ${successorUrl}`;
    const body = [
      marker,
      '',
      `- Nominal occurrence: ${schedule.nextOccurrence}`,
      `- Skipped cadence dates: ${schedule.skipped.length ? schedule.skipped.join(', ') : '(none)'}`,
    ].join('\n');
    let comments = await this.#comments(item.issue.repo, item.issue.number);
    let matches = comments.filter(
      (comment) => String(comment.body ?? '').split(/\r?\n/, 1)[0] === marker,
    );
    if (matches.length > 1) {
      throw new Error('recurring task has duplicate next-occurrence backlink comments');
    }
    if (!matches.length) {
      await ensureIssueComment(
        this.gh,
        item.issue.repo,
        item.issue.number,
        marker,
        body,
      );
    } else if (matches[0].body !== body) {
      await this.gh([
        'api',
        `repos/${item.issue.repo}/issues/comments/${matches[0].id}`,
        '-X', 'PATCH',
        '-f', `body=${body}`,
      ]);
    }
    comments = await this.#comments(item.issue.repo, item.issue.number);
    matches = comments.filter(
      (comment) => String(comment.body ?? '').split(/\r?\n/, 1)[0] === marker,
    );
    if (matches.length !== 1 || matches[0].body !== body) {
      throw new Error('GitHub did not verify the recurring successor backlink/history');
    }
  }

  async #createRecurringSuccessor(item) {
    if (item.issue.repo !== this.binding.domain.slug) {
      throw new Error('recurring rollover is allowed only for Issues in the configured Domain');
    }
    if (item.issue.state === 'OPEN' && item.fields.Status === 'done') {
      throw new Error('Project Status=done without completed Issue closure is not a recurrence completion signal');
    }
    if (item.issue.state === 'CLOSED' && item.issue.stateReason !== 'COMPLETED') {
      throw new Error('a recurring Issue closed as not planned cannot create a successor');
    }
    const completionDay = item.issue.state === 'CLOSED'
      ? String(item.issue.closedAt ?? '').slice(0, 10)
      : todayLocal(this.now());
    const schedule = computeRecurringSuccessor(item.issue.body, completionDay);
    let successor = await this.#findRecurringSuccessor(item);
    if (successor) {
      const targetSchedule = recurrenceState(successor.body);
      if (
        targetSchedule.occurrence !== schedule.nextOccurrence
        || targetSchedule.rule !== schedule.rule
      ) {
        throw new Error('existing recurring successor does not match the computed cadence');
      }
      await this.#ensureRecurringSuccessor(item, successor, schedule);
      await this.#ensureRecurringBacklink(item, successor.url, schedule);
      return successor.url;
    }
    const body = this.#recurringSuccessorBody(item, schedule.nextOccurrence);
    const raw = await this.gh([
      'api',
      `repos/${this.binding.domain.slug}/issues`,
      '-f', `title=${item.issue.title}`,
      '-f', `body=${body}`,
    ]);
    const createdSuccessor = JSON.parse(raw);
    createdSuccessor.url = createdSuccessor.html_url || createdSuccessor.url;
    createdSuccessor.state = createdSuccessor.state === 'open' ? 'OPEN' : createdSuccessor.state;
    createdSuccessor.body = createdSuccessor.body ?? body;
    await this.#ensureRecurringBacklink(item, createdSuccessor.url, schedule);
    await this.#ensureRecurringSuccessor(item, createdSuccessor, schedule);
    return createdSuccessor.url;
  }

  async #assertRecurringCancellationSafe(item) {
    if (item.issue.repo !== this.binding.domain.slug) {
      throw new Error('recurring cancellation is allowed only for Issues in the configured Domain');
    }
    recurrenceState(item.issue.body);
    const successor = await this.#findRecurringSuccessor(item);
    if (successor) {
      throw new Error(`cannot cancel this occurrence because successor ${successor.url} already exists`);
    }
  }

  async mutate(input) {
    if (!input || typeof input !== 'object') throw new Error('request must be an object');
    const operation = text(input.operation, 'operation', 50, { allowEmpty: false });
    const { item, liveRevision } = await this.#assertMutable(input);
    if (!this.binding.allowedRepos.has(item.issue.repo)) {
      throw Object.assign(new Error('task repository is outside the configured boundary'), { statusCode: 403 });
    }
    this.#assertHistoricalProvenanceMutation(item, operation, input);

    if (operation === 'edit') {
      const changes = input.changes ?? {};
      if (
        changes.title !== undefined
        && changes.title !== item.issue.title
      ) {
        this.#assertNoLiveWorker(item, 'title edit');
      }
      if (
        (
          changes.details !== undefined
          && changes.details !== (() => {
            try {
              const block = parseCurrentActionBlock(item.issue.body);
              return block
                ? `${item.issue.body.slice(0, block.start)}${item.issue.body.slice(block.end)}`.trim()
                : item.issue.body.trim();
            } catch {
              return item.issue.body.trim();
            }
          })()
        )
        || (
          changes.playbook !== undefined
          && changes.playbook !== (item.fields.playbook || '')
        )
        || (
          changes.dependencies !== undefined
          && changes.dependencies !== (item.fields.dependencies || '')
        )
        || (
          changes.executionAuthorized !== undefined
          && changes.executionAuthorized !== (item.fields['execution-authorized'] || 'no')
        )
        || (
          changes.currentActionDetail !== undefined
          && changes.currentActionDetail !== (() => {
            try {
              return parseCurrentActionBlock(item.issue.body)?.detail || '';
            } catch {
              return '';
            }
          })()
        )
      ) {
        this.#assertNoLiveWorker(item, 'execution-affecting edit');
      }
      const nextStatus = changes.status ?? item.fields.Status;
      const nextAction = changes.nextAction ?? item.fields['next-action'];
      if (
        (changes.status !== undefined && changes.status !== item.fields.Status)
        || (
          changes.nextAction !== undefined
          && changes.nextAction !== item.fields['next-action']
        )
      ) {
        throw new Error('lifecycle changes require a checked action, not a generic edit');
      }
      if (!validLifecyclePair(nextStatus, nextAction)) {
        throw new Error(`edit would create invalid lifecycle pair ${nextStatus}/${nextAction}`);
      }
      if (
        changes.workerState !== undefined
      ) {
        this.#assertNoLiveWorker(item, 'edit');
      }
      const block = parseCurrentActionBlock(item.issue.body);
      const title = changes.title === undefined
        ? undefined
        : text(changes.title, 'title', 256, { allowEmpty: false });
      if (changes.priority !== undefined) await this.#setSelect(item.itemId, 'priority', changes.priority);
      if (changes.workstream !== undefined) {
        await this.#setText(
          item.itemId,
          'workstream',
          await this.#validateWorkstream(changes.workstream),
        );
      }
      if (changes.nextActionDate !== undefined) {
        if (isRecurringBody(item.issue.body)) recurrenceState(item.issue.body);
        await this.#setDate(
          item.itemId,
          'next-action-date',
          assertDate(changes.nextActionDate, 'nextActionDate'),
        );
      }
      if (changes.deadline !== undefined) {
        await this.#setDate(item.itemId, 'deadline', assertDate(changes.deadline, 'deadline'));
      }
      if (changes.playbook !== undefined) {
        await this.#setText(item.itemId, 'playbook', text(changes.playbook, 'playbook', 300));
      }
      if (changes.dependencies !== undefined) {
        await this.#setText(item.itemId, 'dependencies', text(changes.dependencies, 'dependencies', 4000));
      }
      if (changes.executionAuthorized !== undefined) {
        await this.#setSelect(item.itemId, 'execution-authorized', changes.executionAuthorized);
      }
      const detail = changes.currentActionDetail ?? block?.detail ?? 'Task details updated.';
      await this.#transition(item, liveRevision, {
        status: nextStatus,
        action: nextAction,
        detail,
        workerState: changes.workerState,
        issueTitle: title,
        issueDetails: changes.details,
      });
      return this.detail(item.itemId);
    }

    this.#assertNoLiveWorker(item, operation);

    if (operation === 'hold') {
      const tuple = [
        item.fields.machine || '',
        item.fields['session-id'] || '',
        item.fields['claim-generation'] || '',
      ];
      await this.#transition(item, liveRevision, {
        status: 'deliberate-hold',
        action: 'hold',
        detail: text(input.detail, 'detail', 2000, { allowEmpty: false }),
        resourceSemantics: (
          tuple.every(Boolean)
          && !item.fields['needs-human-since']
        ) ? 'held-affinity' : '',
      });
    } else if (operation === 'handoff-ai') {
      if (!item.fields.playbook) throw new Error('handoff to AI requires a playbook');
      if (String(item.fields.dependencies ?? '').trim()) {
        throw new Error('handoff to AI requires cleared dependencies');
      }
      await this.#setSelect(item.itemId, 'execution-authorized', 'yes');
      await this.#setText(item.itemId, 'needs-human-since', '');
      await this.#transition(item, liveRevision, {
        status: 'ready-for-ai',
        action: 'execute',
        detail: text(input.detail || 'Run the authorized playbook step.', 'detail', 2000, { allowEmpty: false }),
        workerState: item.fields['worker-state'] === 'checkpointed' ? 'paused' : undefined,
        resourceSemantics: '',
      });
    } else if (operation === 'handoff-human') {
      const action = input.action;
      if (!['clarify', 'discuss', 'approve', 'review', 'act'].includes(action)) {
        throw new Error('handoff-human requires an exact human action');
      }
      await this.#setSelect(item.itemId, 'execution-authorized', 'no');
      await this.#transition(item, liveRevision, {
        status: 'ready-for-human',
        action,
        detail: text(input.detail, 'detail', 2000, { allowEmpty: false }),
        resourceSemantics: '',
      });
    } else if (operation === 'external-wait') {
      await this.#transition(item, liveRevision, {
        status: 'external-waiting',
        action: 'wait',
        detail: text(input.detail, 'detail', 2000, { allowEmpty: false }),
        resourceSemantics: '',
      });
    } else if (operation === 'finish') {
      this.#assertNoRetainedAffinity(item, operation);
      const recurring = isRecurringBody(item.issue.body);
      if (recurring) {
        await this.#createRecurringSuccessor(item);
        const current = await this.#item(item.itemId);
        if (
          !current
          || current.issue.state !== item.issue.state
          || current.issue.body !== item.issue.body
          || current.fields.Status !== item.fields.Status
          || current.fields['next-action'] !== item.fields['next-action']
          || current.fields['next-action-date'] !== item.fields['next-action-date']
          || parseRevision(current.fields['task-revision'] ?? '') !== liveRevision
        ) {
          throw new Error('recurring task changed while its successor was being prepared');
        }
      }
      if (item.fields['next-action-date']) {
        await this.#setDate(item.itemId, 'next-action-date', '');
        const cleared = await this.#item(item.itemId);
        if (!cleared || cleared.fields['next-action-date']) {
          throw new Error('GitHub did not confirm planning date cleanup');
        }
      }
      await ensureIssueClosed(this.gh, item.issue.repo, item.issue.number);
      if (recurring && item.fields.Status === 'done') {
        const terminal = await this.#item(item.itemId);
        if (
          !terminal
          || terminal.issue.state !== 'CLOSED'
          || terminal.issue.stateReason !== 'COMPLETED'
          || terminal.fields['next-action-date']
        ) {
          throw new Error('done recurring task has a conflicting Issue closure');
        }
        return this.detail(item.itemId);
      }
      await this.#transition(item, liveRevision, {
        status: 'done',
        action: 'none',
        detail: input.detail || 'Outcome complete.',
        workerState: 'stopped',
        needsHumanSince: '',
      });
    } else if (operation === 'reject') {
      this.#assertNoRetainedAffinity(item, operation);
      const recurring = isRecurringBody(item.issue.body);
      if (recurring) {
        await this.#assertRecurringCancellationSafe(item);
      }
      if (item.fields['next-action-date']) {
        await this.#setDate(item.itemId, 'next-action-date', '');
        const cleared = await this.#item(item.itemId);
        if (!cleared || cleared.fields['next-action-date']) {
          throw new Error('GitHub did not confirm planning date cleanup before rejection');
        }
      }
      await ensureIssueRejected(this.gh, item.issue.repo, item.issue.number);
      if (recurring && item.fields.Status === 'rejected') {
        const terminal = await this.#item(item.itemId);
        if (
          !terminal
          || terminal.issue.state !== 'CLOSED'
          || terminal.issue.stateReason !== 'NOT_PLANNED'
          || terminal.fields['next-action-date']
        ) {
          throw new Error('rejected recurring task has a conflicting Issue closure');
        }
        return this.detail(item.itemId);
      }
      await this.#transition(item, liveRevision, {
        status: 'rejected',
        action: 'none',
        detail: input.detail || 'Outcome rejected.',
        workerState: 'stopped',
        needsHumanSince: '',
      });
    } else if (operation === 'defer') {
      if (isRecurringBody(item.issue.body)) recurrenceState(item.issue.body);
      await this.#setDate(
        item.itemId,
        'next-action-date',
        assertDate(input.date, 'date'),
      );
      await this.#transition(item, liveRevision, {
        status: item.fields.Status,
        action: item.fields['next-action'],
        detail: input.detail || 'Human attention schedule updated.',
      });
    } else {
      throw new Error(`unsupported operation: ${operation}`);
    }
    return this.detail(item.itemId);
  }
}

export function demoTasks(now = new Date('2026-09-09T12:00:00Z')) {
  const today = todayLocal(now);
  const tasks = [
    {
      id: 'demo-1', itemId: 'demo-1', number: 1, repo: 'example/pan-domain',
      title: 'Approve the garden irrigation estimate', url: '#demo-1',
      status: 'ready-for-human', nextAction: 'approve',
      nextActionDetail: 'Approve the lower-water option after reviewing the comparison.',
      priority: 'high', nextActionDate: today, deadline: '2026-09-12',
      playbook: '', workstream: 'home/garden', executionAuthorized: 'no',
      dependencies: '', workerState: 'idle', needsHumanSince: '', claimedBy: '',
      leaseUntil: '', machine: '', sessionId: '', claimGeneration: '', revision: 3,
      recurring: false, updatedAt: '2026-09-09T15:00:00Z', primaryView: 'today',
      overdue: false,
    },
    {
      id: 'demo-2', itemId: 'demo-2', number: 2, repo: 'example/pan-domain',
      title: 'Choose the release cohort', url: '#demo-2',
      status: 'ready-for-human', nextAction: 'discuss',
      nextActionDetail: 'Discuss whether the beta should include all paid accounts.',
      priority: 'urgent', nextActionDate: '', deadline: '',
      playbook: 'product-development', workstream: 'product/release',
      executionAuthorized: 'yes', dependencies: '', workerState: 'waiting-human',
      needsHumanSince: '2026-09-09T16:00:00Z', claimedBy: 'demo-runner',
      leaseUntil: '2026-09-10T00:00:00Z', machine: 'demo-machine',
      sessionId: '11111111-1111-4111-8111-111111111111',
      claimGeneration: '22222222-2222-4222-8222-222222222222', revision: 5,
      recurring: false, updatedAt: '2026-09-09T16:00:00Z', primaryView: 'needs-me',
      overdue: false,
    },
    {
      id: 'demo-3', itemId: 'demo-3', number: 3, repo: 'example/pan-domain',
      title: 'Prepare accessibility audit fixes', url: '#demo-3',
      status: 'ai-executing', nextAction: 'execute',
      nextActionDetail: 'Implement the authorized audit fixes and run focused tests.',
      priority: 'normal', nextActionDate: '', deadline: '',
      playbook: 'tool-development', workstream: 'product/accessibility',
      executionAuthorized: 'yes', dependencies: '', workerState: 'running',
      needsHumanSince: '', claimedBy: 'demo-runner',
      leaseUntil: '2026-09-10T00:00:00Z', machine: 'demo-machine::primary',
      sessionId: '33333333-3333-4333-8333-333333333333',
      claimGeneration: '44444444-4444-4444-8444-444444444444', revision: 2,
      recurring: false, updatedAt: '2026-09-09T17:00:00Z', primaryView: 'in-motion',
      overdue: false,
    },
    {
      id: 'demo-4', itemId: 'demo-4', number: 4, repo: 'example/pan-domain',
      title: 'Renew the library membership', url: '#demo-4',
      status: 'done', nextAction: 'none', nextActionDetail: 'Outcome complete.',
      priority: 'low', nextActionDate: '', deadline: '',
      playbook: '', workstream: 'personal/admin', executionAuthorized: 'no',
      dependencies: '', workerState: 'stopped', needsHumanSince: '', claimedBy: '',
      leaseUntil: '', machine: '', sessionId: '', claimGeneration: '', revision: 7,
      recurring: false, updatedAt: '2026-09-09T14:00:00Z', primaryView: 'recent',
      overdue: false,
    },
  ];
  return {
    today,
    domainRepo: 'example/pan-domain',
    project: 'example/1',
    tasks,
    views: {
      today: ['demo-1'],
      'needs-me': ['demo-2'],
      'in-motion': ['demo-3'],
      recent: ['demo-4'],
      all: tasks.map((task) => task.id),
    },
  };
}

export const TASK_SERVICE_SCHEMA = CANONICAL_FIELDS;
