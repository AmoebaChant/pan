import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  derivePrimaryView,
  isRecurringBody,
  isTerminalStatus,
  parseCurrentActionBlock,
  parseRevision,
  renderCurrentActionBlock,
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
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

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
  fieldValues(first:50) {
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

function todayLocal(now = new Date()) {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function assertDate(value, field, { allowEmpty = true } = {}) {
  if ((value === '' || value == null) && allowEmpty) return '';
  if (!ISO_DATE.test(String(value)) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new Error(`${field} must be an ISO calendar date`);
  }
  return String(value);
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
    legacyOwner: fields.owner ?? '',
    revision: parseRevision(fields['task-revision'] ?? ''),
    recurring: isRecurringBody(item.issue.body),
    updatedAt: item.issue.updatedAt || item.projectUpdatedAt,
    createdAt: item.issue.createdAt,
    closedAt: item.issue.closedAt,
    bodyConflict,
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
        const parsed = parseItem(node);
        if (!parsed) continue;
        if (!this.binding.allowedRepos.has(parsed.issue.repo)) continue;
        items.push(parsed);
      }
      cursor = connection.pageInfo?.hasNextPage ? connection.pageInfo.endCursor : null;
    } while (cursor);
    return items;
  }

  async #item(itemId) {
    const query = `query($id:ID!){node(id:$id){... on ProjectV2Item{${ITEM_FRAGMENT}}}}`;
    const data = await this.#json([
      'api', 'graphql', '-f', `query=${query}`, '-f', `id=${itemId}`,
    ]);
    const item = data.data?.node ? parseItem(data.data.node) : null;
    if (!item || !this.binding.allowedRepos.has(item.issue.repo)) return null;
    return item;
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
          nodes { number title body url state stateReason }
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
    const matches = (await this.#allDomainIssues()).filter((issue) =>
      String(issue.body ?? '').split(/\r?\n/).includes(marker));
    if (matches.length > 1) {
      throw new Error(`multiple Domain Issues have Todoist source marker ${sourceId}`);
    }
    let issue = matches[0] ?? null;
    let created = false;
    if (issue?.state === 'CLOSED') {
      throw new Error(`Todoist source ${sourceId} maps to a closed Issue`);
    }
    if (issue) {
      const missingBody = String(record.body)
        .split(/\r?\n/)
        .filter((line) => line.trim())
        .filter((line) => !String(issue.body ?? '').includes(line));
      if (missingBody.length) {
        throw new Error(
          `Todoist source ${sourceId} Issue no longer preserves ` +
          `${missingBody.length} imported body line(s)`,
        );
      }
    }
    if (!issue) {
      const block = renderCurrentActionBlock({
        status: 'ready-for-human',
        action: 'act',
        detail: record.currentActionDetail || 'Perform or reconsider the imported active task.',
        revision: 1,
        updatedAt: this.now().toISOString(),
      });
      const importedBody = text(record.body, 'body', 60000);
      const bodyWithSource = record.recurrence
        ? importedBody.replace(/\r?\n/, `\n${marker}\n`)
        : `${marker}\n\n${importedBody}`;
      const body = upsertCurrentActionBlock(bodyWithSource, block);
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

    const projectItems = await this.#allItems();
    let projectItem = projectItems.find((item) => item.issue.url === issue.url);
    let addedProject = false;
    if (!projectItem) {
      const itemId = await this.#addToProject(issue.url);
      projectItem = { itemId, fields: {}, issue: { ...issue, repo: this.binding.domain.slug } };
      addedProject = true;
    }
    const itemId = projectItem.itemId;
    const initializeProject = addedProject || !projectItem.fields['task-revision'];
    if (initializeProject) {
      await this.#setSelect(itemId, 'Status', 'ready-for-human');
      await this.#setSelect(itemId, 'next-action', 'act');
      await this.#setSelect(itemId, 'priority', record.priority || 'normal');
      await this.#setSelect(itemId, 'execution-authorized', 'no');
      await this.#setSelect(itemId, 'worker-state', 'idle');
      await this.#setText(itemId, 'task-revision', '1');
      if (record.nextActionDate) {
        await this.#setDate(
          itemId,
          'next-action-date',
          assertDate(record.nextActionDate, 'nextActionDate'),
        );
      }
      if (record.deadline) {
        await this.#setDate(itemId, 'deadline', assertDate(record.deadline, 'deadline'));
      }
      if (record.workstream) await this.#setText(itemId, 'workstream', record.workstream);
    }

    const existingComments = await this.#comments(this.binding.domain.slug, issue.number);
    for (const comment of record.comments ?? []) {
      const commentMarker = `Pan: Todoist source comment ${comment.id}`;
      if (existingComments.some((entry) => entry.body.includes(commentMarker))) continue;
      await this.gh([
        'issue', 'comment', String(issue.number),
        '--repo', this.binding.domain.slug,
        '--body', `${commentMarker}\n\nImported ${comment.postedAt || 'without a source timestamp'}:\n\n${comment.content}`,
      ]);
    }
    const confirmed = await this.#item(itemId);
    if (
      !confirmed
      || confirmed.issue.url !== issue.url
      || confirmed.fields.Status !== 'ready-for-human'
      || confirmed.fields['next-action'] !== 'act'
    ) {
      throw new Error(`GitHub did not verify Todoist source ${sourceId}`);
    }
    const confirmedComments = await this.#comments(this.binding.domain.slug, issue.number);
    for (const comment of record.comments ?? []) {
      if (!confirmedComments.some((entry) =>
        entry.body.includes(`Pan: Todoist source comment ${comment.id}`))) {
        throw new Error(`GitHub did not verify Todoist comment ${comment.id}`);
      }
    }
    return {
      sourceId,
      issueUrl: issue.url,
      itemId,
      outcome: created ? 'created' : 'repaired',
    };
  }

  async todoistSourceIndex() {
    const issues = await this.#allDomainIssues();
    const projectUrls = new Set((await this.#allItems()).map((item) => item.issue.url));
    const bySourceId = new Map();
    for (const issue of issues) {
      const markers = [...String(issue.body ?? '').matchAll(/^Pan: Todoist source task ([^\r\n]+)$/gm)];
      if (markers.length !== 1) continue;
      const match = markers[0];
      const entry = {
        sourceId: match[1],
        issueUrl: issue.url,
        number: issue.number,
        state: issue.state,
        inProject: projectUrls.has(issue.url),
      };
      const current = bySourceId.get(entry.sourceId) ?? [];
      current.push(entry);
      bySourceId.set(entry.sourceId, current);
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
    const item = (await this.#allItems()).find((candidate) => candidate.issue.url === match.issueUrl);
    if (!item) {
      return { sourceId, outcome: 'failed', error: 'source Issue is not in the Project' };
    }
    const missingBody = String(record.body)
      .split(/\r?\n/)
      .filter((line) => line.trim())
      .filter((line) => !item.issue.body.includes(line));
    if (missingBody.length) {
      return {
        sourceId,
        outcome: 'conflict',
        error: `Issue no longer preserves ${missingBody.length} imported body line(s)`,
      };
    }
    const comments = await this.#comments(this.binding.domain.slug, match.number);
    const missingComments = (record.comments ?? []).filter((comment) =>
      !comments.some((entry) =>
        entry.body.includes(`Pan: Todoist source comment ${comment.id}`)));
    if (missingComments.length) {
      return {
        sourceId,
        outcome: 'failed',
        error: `missing ${missingComments.length} imported comment(s)`,
      };
    }
    return { sourceId, outcome: 'verified', issueUrl: match.issueUrl, itemId: item.itemId };
  }

  async migrateLegacyItem(action) {
    const item = await this.#item(action.itemId);
    if (!item) throw new Error('legacy Project item no longer exists');
    const expected = action.expected;
    if (
      (item.fields.owner || 'unassigned') !== expected.owner
      || item.fields.Status !== expected.status
      || (item.fields['claimed-by'] || '') !== (expected.claimedBy || '')
      || (item.fields['lease-until'] || '') !== (expected.leaseUntil || '')
      || (item.fields.machine || '') !== (expected.machine || '')
      || (item.fields['session-id'] || '') !== (expected.sessionId || '')
    ) {
      throw new Error('legacy item changed after the migration plan was generated');
    }
    const target = action.target;
    if (!validLifecyclePair(target.status, target.nextAction)) {
      throw new Error('migration target has an invalid lifecycle pair');
    }
    const expectedRevision = parseRevision(item.fields['task-revision'] || '');
    const nextRevision = expectedRevision + 1;
    if (isTerminalStatus(target.status) && item.fields['next-action-date']) {
      const expectedReason = target.status === 'done' ? 'COMPLETED' : 'NOT_PLANNED';
      if (item.issue.state !== 'CLOSED' || item.issue.stateReason !== expectedReason) {
        throw new Error('terminal legacy item has a conflicting Issue closure');
      }
      await this.#setDate(item.itemId, 'next-action-date', '');
    }
    await this.#setSelect(item.itemId, 'next-action', target.nextAction);
    await this.#setSelect(
      item.itemId,
      'execution-authorized',
      target.executionAuthorized,
    );
    await this.#setText(item.itemId, 'dependencies', target.dependencies || '');
    await this.#setSelect(item.itemId, 'worker-state', target.workerState);
    const claimGeneration = item.fields['claim-generation']
      || (item.fields['session-id'] ? randomUUID() : '');
    if (claimGeneration !== (item.fields['claim-generation'] || '')) {
      await this.#setText(item.itemId, 'claim-generation', claimGeneration);
    }
    await this.#setSelect(item.itemId, 'Status', target.status);
    await updateIssueCurrentAction(
      this.gh,
      item.issue.repo,
      item.issue.number,
      {
        expectedRevision,
        revision: nextRevision,
        status: target.status,
        action: target.nextAction,
        detail: target.detail,
        actor: 'Pan lifecycle migration',
        claimGeneration,
        fromStatus: item.fields.Status || '',
        fromAction: item.fields['next-action'] || '',
        updatedAt: this.now().toISOString(),
      },
    );
    await this.#setText(item.itemId, 'task-revision', String(nextRevision));
    if (target.workerState === 'paused') {
      await this.#setText(item.itemId, 'claimed-by', '');
      await this.#setText(item.itemId, 'lease-until', '');
    }
    const confirmed = await this.#item(item.itemId);
    if (
      !confirmed
      || confirmed.fields.Status !== target.status
      || confirmed.fields['next-action'] !== target.nextAction
      || confirmed.fields['worker-state'] !== target.workerState
      || parseRevision(confirmed.fields['task-revision']) !== nextRevision
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
    return { item, liveRevision };
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
  }) {
    if (!validLifecyclePair(status, action)) {
      throw new Error(`invalid transition target ${status}/${action}`);
    }
    const nextRevision = liveRevision + 1;
    await this.#setSelect(item.itemId, 'next-action', action);
    if (workerState) await this.#setSelect(item.itemId, 'worker-state', workerState);
    if (needsHumanSince !== undefined) {
      await this.#setText(item.itemId, 'needs-human-since', needsHumanSince);
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
    await this.#setText(item.itemId, 'task-revision', String(nextRevision));
    const confirmed = await this.#item(item.itemId);
    if (
      !confirmed
      || confirmed.fields.Status !== status
      || confirmed.fields['next-action'] !== action
      || parseRevision(confirmed.fields['task-revision']) !== nextRevision
    ) {
      throw new Error('GitHub did not confirm the requested transition');
    }
    return confirmed;
  }

  async #findNextOccurrence(item) {
    const comments = await this.#comments(item.issue.repo, item.issue.number);
    for (const comment of comments) {
      const match = /^Pan: next occurrence (https:\/\/github\.com\/[^\s]+)$/m.exec(comment.body);
      if (match) return match[1];
    }
    return null;
  }

  async #createRecurringSuccessor(item, nextOccurrence) {
    const existing = await this.#findNextOccurrence(item);
    if (existing) return existing;
    const marker = /^Pan: recurrence occurrence (\d{4}-\d{2}-\d{2})$/m.exec(item.issue.body);
    if (!marker) throw new Error('recurring task has no valid occurrence marker');
    assertDate(nextOccurrence, 'nextOccurrence', { allowEmpty: false });
    if (nextOccurrence <= marker[1]) {
      throw new Error('nextOccurrence must be after the current nominal occurrence');
    }
    const currentBlock = parseCurrentActionBlock(item.issue.body);
    const reusable = `${item.issue.body.slice(0, currentBlock?.start ?? item.issue.body.length)}${
      currentBlock ? item.issue.body.slice(currentBlock.end) : ''
    }`
      .replace(/^Pan: recurrence occurrence \d{4}-\d{2}-\d{2}\s*/m, '')
      .trim();
    const body = [
      `Pan: recurrence occurrence ${nextOccurrence}`,
      `Pan: previous occurrence ${item.issue.url}`,
      '',
      reusable,
    ].join('\n');
    const raw = await this.gh([
      'api',
      `repos/${this.binding.domain.slug}/issues`,
      '-f', `title=${item.issue.title}`,
      '-f', `body=${body}`,
    ]);
    const successor = JSON.parse(raw);
    successor.url = successor.html_url || successor.url;
    const successorItemId = await this.#addToProject(successor.url);
    const block = renderCurrentActionBlock({
      status: 'ready-for-human',
      action: 'act',
      detail: `Perform the recurrence occurrence scheduled for ${nextOccurrence}.`,
      revision: 1,
      updatedAt: this.now().toISOString(),
    });
    const successorBody = upsertCurrentActionBlock(body, block);
    await this.#editIssue(this.binding.domain.slug, successor.number, { body: successorBody });
    await this.#setSelect(successorItemId, 'Status', 'ready-for-human');
    await this.#setSelect(successorItemId, 'next-action', 'act');
    await this.#setSelect(successorItemId, 'priority', item.fields.priority || 'normal');
    await this.#setSelect(successorItemId, 'execution-authorized', 'no');
    await this.#setSelect(successorItemId, 'worker-state', 'idle');
    await this.#setText(successorItemId, 'task-revision', '1');
    await this.#setDate(successorItemId, 'next-action-date', nextOccurrence);
    if (item.fields.workstream) {
      await this.#setText(successorItemId, 'workstream', item.fields.workstream);
    }
    await ensureIssueComment(
      this.gh,
      item.issue.repo,
      item.issue.number,
      `Pan: next occurrence ${successor.url}`,
      `Pan: next occurrence ${successor.url}`,
    );
    const confirmed = await this.#item(successorItemId);
    if (
      !confirmed
      || confirmed.issue.url !== successor.url
      || confirmed.fields.Status !== 'ready-for-human'
    ) {
      throw new Error('GitHub did not verify the recurring successor');
    }
    return successor.url;
  }

  async mutate(input) {
    if (!input || typeof input !== 'object') throw new Error('request must be an object');
    const operation = text(input.operation, 'operation', 50, { allowEmpty: false });
    const { item, liveRevision } = await this.#assertMutable(input);
    if (!this.binding.allowedRepos.has(item.issue.repo)) {
      throw Object.assign(new Error('task repository is outside the configured boundary'), { statusCode: 403 });
    }

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
      let body = item.issue.body;
      const block = parseCurrentActionBlock(body);
      if (changes.details !== undefined) {
        const details = text(changes.details, 'details', 60000);
        body = block
          ? upsertCurrentActionBlock(details, block.block)
          : details;
      }
      const title = changes.title === undefined
        ? undefined
        : text(changes.title, 'title', 256, { allowEmpty: false });
      await this.#editIssue(item.issue.repo, item.issue.number, { title, body });
      if (changes.priority !== undefined) await this.#setSelect(item.itemId, 'priority', changes.priority);
      if (changes.workstream !== undefined) {
        await this.#setText(
          item.itemId,
          'workstream',
          await this.#validateWorkstream(changes.workstream),
        );
      }
      if (changes.nextActionDate !== undefined) {
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
      });
      return this.detail(item.itemId);
    }

    this.#assertNoLiveWorker(item, operation);

    if (operation === 'hold') {
      await this.#transition(item, liveRevision, {
        status: 'deliberate-hold',
        action: 'hold',
        detail: text(input.detail, 'detail', 2000, { allowEmpty: false }),
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
      });
    } else if (operation === 'external-wait') {
      await this.#transition(item, liveRevision, {
        status: 'external-waiting',
        action: 'wait',
        detail: text(input.detail, 'detail', 2000, { allowEmpty: false }),
      });
    } else if (operation === 'release-workspace') {
      if (!['idle', 'stopped', 'paused', 'checkpointed'].includes(item.fields['worker-state'] || 'idle')) {
        throw new Error('workspace release requires an idle, stopped, paused, or checkpointed worker');
      }
      await this.#setText(item.itemId, 'machine', '');
      await this.#setText(item.itemId, 'session-id', '');
      await this.#setText(item.itemId, 'claim-generation', '');
      await this.#setSelect(item.itemId, 'worker-state', 'idle');
      await this.#transition(item, liveRevision, {
        status: item.fields.Status,
        action: item.fields['next-action'],
        detail: input.detail || 'Workspace affinity explicitly released.',
        workerState: 'idle',
      });
    } else if (operation === 'finish') {
      if (isRecurringBody(item.issue.body)) {
        await this.#createRecurringSuccessor(
          item,
          assertDate(input.nextOccurrence, 'nextOccurrence', { allowEmpty: false }),
        );
      }
      if (item.fields['next-action-date']) {
        await this.#setDate(item.itemId, 'next-action-date', '');
        const cleared = await this.#item(item.itemId);
        if (!cleared || cleared.fields['next-action-date']) {
          throw new Error('GitHub did not confirm planning date cleanup');
        }
      }
      await ensureIssueClosed(this.gh, item.issue.repo, item.issue.number);
      await this.#transition(item, liveRevision, {
        status: 'done',
        action: 'none',
        detail: input.detail || 'Outcome complete.',
        workerState: 'stopped',
        needsHumanSince: '',
      });
    } else if (operation === 'reject') {
      if (item.fields['next-action-date']) await this.#setDate(item.itemId, 'next-action-date', '');
      await ensureIssueRejected(this.gh, item.issue.repo, item.issue.number);
      await this.#transition(item, liveRevision, {
        status: 'rejected',
        action: 'none',
        detail: input.detail || 'Outcome rejected.',
        workerState: 'stopped',
        needsHumanSince: '',
      });
    } else if (operation === 'defer') {
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
