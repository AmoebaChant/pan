import { spawn } from 'node:child_process';
import { TaskBackendError } from './pan-task-backend.js';

const PRIORITIES = new Set(['urgent', 'high', 'normal', 'low']);
const WORK_STATUSES = new Set(['open', 'done', 'rejected']);
const AGENT_STATUSES = new Set(['', 'requested', 'running']);
const FIELD_CONTRACT = Object.freeze({
  Status: { type: 'SINGLE_SELECT', options: ['open', 'done', 'rejected'] },
  priority: { type: 'SINGLE_SELECT', options: ['urgent', 'high', 'normal', 'low'] },
  'next-action-date': { type: 'DATE' },
  deadline: { type: 'DATE' },
  playbook: { type: 'TEXT' },
  workstream: { type: 'TEXT' },
  'session-id': { type: 'TEXT' },
  'agent-status': { type: 'SINGLE_SELECT', options: ['requested', 'running'] },
});

function assertObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TaskBackendError(`${name} must be an object`, { code: 'invalid-input' });
  }
}

function requireText(value, name) {
  const text = String(value ?? '').trim();
  if (!text) {
    throw new TaskBackendError(`${name} is required`, { code: 'invalid-input' });
  }
  return text;
}

function splitRepository(value) {
  const match = /^([^/\s]+)\/([^/\s]+)$/.exec(String(value ?? '').trim());
  if (!match) {
    throw new TaskBackendError('repository must be owner/name', { code: 'invalid-config' });
  }
  return { owner: match[1], name: match[2], nameWithOwner: `${match[1]}/${match[2]}` };
}

function backendError(error) {
  if (error instanceof TaskBackendError) return error;
  const details = error?.stderr ? String(error.stderr).trim() : null;
  return new TaskBackendError(error?.message || 'GitHub request failed', {
    code: 'github-error',
    details,
  });
}

async function spawnGh(args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn('gh', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve({ stdout });
      else {
        const error = new Error(stderr.trim() || `gh exited with code ${code}`);
        error.stderr = stderr;
        reject(error);
      }
    });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

export async function runGh(args, { execFileImpl, input } = {}) {
  const result = execFileImpl
    ? await execFileImpl('gh', args, {
        encoding: 'utf8',
        maxBuffer: 20 * 1024 * 1024,
        windowsHide: true,
      })
    : await spawnGh(args, input);
  const stdout = typeof result === 'string' ? result : result.stdout;
  return stdout?.trim() ? JSON.parse(stdout) : null;
}

class GitHubProjectTransport {
  constructor(config, dependencies = {}) {
    this.config = config;
    this.runGh = dependencies.runGh ?? ((args, options) => runGh(args, {
      execFileImpl: dependencies.execFileImpl,
      ...options,
    }));
    this.repository = splitRepository(config.repository);
    this.projectOwner = requireText(config.projectOwner, 'projectOwner');
    this.projectNumber = Number(config.projectNumber);
    if (!Number.isInteger(this.projectNumber) || this.projectNumber < 1) {
      throw new TaskBackendError('projectNumber must be a positive integer', {
        code: 'invalid-config',
      });
    }
    this.project = null;
    this.fields = new Map();
  }

  async graphql(query, variables = {}) {
    const args = ['api', 'graphql', '-f', `query=${query}`];
    for (const [name, value] of Object.entries(variables)) {
      if (value !== null && value !== undefined) args.push('-F', `${name}=${value}`);
    }
    return this.runGh(args);
  }

  async initialize() {
    const data = await this.graphql(`
      query ProjectContract(
        $projectOwner: String!,
        $projectNumber: Int!,
        $repoOwner: String!,
        $repoName: String!
      ) {
        repository(owner: $repoOwner, name: $repoName) {
          id
          nameWithOwner
        }
        user(login: $projectOwner) {
          projectV2(number: $projectNumber) { ...ProjectContract }
        }
        organization(login: $projectOwner) {
          projectV2(number: $projectNumber) { ...ProjectContract }
        }
      }
      fragment ProjectContract on ProjectV2 {
        id
        number
        title
        fields(first: 100) {
          nodes {
            __typename
            ... on ProjectV2FieldCommon { id name dataType }
            ... on ProjectV2SingleSelectField {
              options { id name }
            }
          }
        }
      }
    `, {
      projectOwner: this.projectOwner,
      projectNumber: this.projectNumber,
      repoOwner: this.repository.owner,
      repoName: this.repository.name,
    });
    if (!data?.data?.repository) {
      throw new TaskBackendError(
        `repository ${this.repository.nameWithOwner} was not found or is inaccessible`,
        { code: 'not-found', status: 404 },
      );
    }
    this.project = data.data.user?.projectV2 ?? data.data.organization?.projectV2 ?? null;
    if (!this.project) {
      throw new TaskBackendError(
        `Project ${this.projectOwner}/${this.projectNumber} was not found or is inaccessible`,
        { code: 'not-found', status: 404 },
      );
    }
    this.fields = new Map(
      this.project.fields.nodes
        .filter((field) => field?.id && field?.name)
        .map((field) => [field.name, field]),
    );
    const problems = [];
    for (const [name, expected] of Object.entries(FIELD_CONTRACT)) {
      const field = this.fields.get(name);
      if (!field) {
        problems.push(`missing ${name}`);
        continue;
      }
      if (field.dataType !== expected.type) {
        problems.push(`${name} must be ${expected.type}`);
        continue;
      }
      if (expected.options) {
        const options = new Set((field.options ?? []).map((option) => option.name));
        for (const option of expected.options) {
          if (!options.has(option)) problems.push(`${name} is missing option ${option}`);
        }
      }
    }
    if (problems.length) {
      throw new TaskBackendError(`GitHub Project schema is incompatible: ${problems.join('; ')}`, {
        code: 'schema-mismatch',
        details: { problems },
      });
    }
    return this;
  }

  async listItems() {
    const items = [];
    let cursor = null;
    do {
      const data = await this.graphql(`
        query ProjectItems(
          $projectOwner: String!,
          $projectNumber: Int!,
          $after: String
        ) {
          user(login: $projectOwner) {
            projectV2(number: $projectNumber) { ...ProjectItems }
          }
          organization(login: $projectOwner) {
            projectV2(number: $projectNumber) { ...ProjectItems }
          }
        }
        fragment ProjectItems on ProjectV2 {
          items(first: 100, after: $after) {
            nodes {
              id
              fieldValues(first: 50) {
                nodes {
                  __typename
                  ... on ProjectV2ItemFieldTextValue {
                    text
                    field { ... on ProjectV2FieldCommon { name } }
                  }
                  ... on ProjectV2ItemFieldDateValue {
                    date
                    field { ... on ProjectV2FieldCommon { name } }
                  }
                  ... on ProjectV2ItemFieldSingleSelectValue {
                    name
                    field { ... on ProjectV2FieldCommon { name } }
                  }
                }
              }
              content {
                ... on Issue {
                  id
                  number
                  title
                  body
                  url
                  state
                  stateReason
                  createdAt
                  updatedAt
                  closedAt
                  repository { nameWithOwner }
                }
              }
            }
            pageInfo { hasNextPage endCursor }
          }
        }
      `, {
        projectOwner: this.projectOwner,
        projectNumber: this.projectNumber,
        after: cursor,
      });
      const project = data?.data?.user?.projectV2 ?? data?.data?.organization?.projectV2;
      const page = project?.items;
      if (!page) throw new TaskBackendError('GitHub Project item query returned no data');
      items.push(...page.nodes);
      cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
    } while (cursor);
    return items.filter(
      (item) => item.content?.repository?.nameWithOwner?.toLowerCase()
        === this.repository.nameWithOwner.toLowerCase(),
    );
  }

  async createIssue({ title, body }) {
    return this.runGh([
      'api',
      `repos/${this.repository.nameWithOwner}/issues`,
      '--method',
      'POST',
      '--input',
      '-',
    ], { input: JSON.stringify({ title, body }) });
  }

  async addProjectItem(contentId) {
    const data = await this.graphql(`
      mutation AddProjectItem($projectId: ID!, $contentId: ID!) {
        addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) {
          item { id }
        }
      }
    `, { projectId: this.project.id, contentId });
    return data?.data?.addProjectV2ItemById?.item;
  }

  async updateIssue(number, changes) {
    return this.runGh([
      'api',
      `repos/${this.repository.nameWithOwner}/issues/${number}`,
      '--method',
      'PATCH',
      '--input',
      '-',
    ], { input: JSON.stringify(changes) });
  }

  async updateField(itemId, name, value) {
    const field = this.fields.get(name);
    if (!field) throw new TaskBackendError(`unknown Project field ${name}`);
    if (value === '') {
      await this.graphql(`
        mutation ClearField($projectId: ID!, $itemId: ID!, $fieldId: ID!) {
          clearProjectV2ItemFieldValue(
            input: { projectId: $projectId, itemId: $itemId, fieldId: $fieldId }
          ) { projectV2Item { id } }
        }
      `, { projectId: this.project.id, itemId, fieldId: field.id });
      return;
    }
    let encoded;
    if (field.dataType === 'SINGLE_SELECT') {
      const option = field.options.find((candidate) => candidate.name === value);
      if (!option) {
        throw new TaskBackendError(`unsupported ${name} value: ${value}`, {
          code: 'invalid-input',
        });
      }
      encoded = `singleSelectOptionId: ${JSON.stringify(option.id)}`;
    } else if (field.dataType === 'DATE') {
      encoded = `date: ${JSON.stringify(value)}`;
    } else {
      encoded = `text: ${JSON.stringify(value)}`;
    }
    await this.graphql(`
      mutation UpdateField($projectId: ID!, $itemId: ID!, $fieldId: ID!) {
        updateProjectV2ItemFieldValue(input: {
          projectId: $projectId,
          itemId: $itemId,
          fieldId: $fieldId,
          value: { ${encoded} }
        }) { projectV2Item { id } }
      }
    `, { projectId: this.project.id, itemId, fieldId: field.id });
  }

  async addComment(number, body) {
    return this.runGh([
      'api',
      `repos/${this.repository.nameWithOwner}/issues/${number}/comments`,
      '--method',
      'POST',
      '--input',
      '-',
    ], { input: JSON.stringify({ body }) });
  }

  async listComments(number) {
    const pages = await this.runGh([
      'api',
      `repos/${this.repository.nameWithOwner}/issues/${number}/comments?per_page=100`,
      '--paginate',
      '--slurp',
    ]);
    return (pages ?? []).flat();
  }
}

function fieldValues(item) {
  const values = new Map();
  for (const node of item.fieldValues?.nodes ?? []) {
    const name = node.field?.name;
    if (!name) continue;
    values.set(name, node.name ?? node.text ?? node.date ?? '');
  }
  return values;
}

function canonical(item, position) {
  const issue = item.content;
  const values = fieldValues(item);
  const issueStateReason = issue.stateReason ?? null;
  const status = issue.state === 'CLOSED'
    ? issueStateReason === 'COMPLETED' ? 'done' : 'rejected'
    : 'open';
  return {
    id: issue.id,
    backend: 'github',
    itemId: item.id,
    position,
    number: issue.number,
    repo: issue.repository.nameWithOwner,
    url: issue.url,
    title: issue.title,
    description: issue.body ?? '',
    status,
    priority: PRIORITIES.has(values.get('priority')) ? values.get('priority') : 'normal',
    nextActionDate: values.get('next-action-date') ?? '',
    deadline: values.get('deadline') ?? '',
    playbook: values.get('playbook') ?? '',
    workstream: values.get('workstream') ?? '',
    sessionId: values.get('session-id') ?? '',
    agentStatus: AGENT_STATUSES.has(values.get('agent-status'))
      ? values.get('agent-status')
      : '',
    issueState: issue.state,
    issueStateReason,
    recurring: false,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    closedAt: issue.closedAt,
  };
}

export class GitHubTaskBackend {
  constructor(config, dependencies = {}) {
    assertObject(config, 'backend config');
    this.config = config;
    this.transport = dependencies.transport
      ?? new GitHubProjectTransport(config, dependencies);
    this.supportsIdempotentCreate = false;
  }

  async initialize() {
    if (typeof this.transport.initialize === 'function') await this.transport.initialize();
    return this;
  }

  async list() {
    try {
      return (await this.transport.listItems()).map(canonical);
    } catch (error) {
      throw backendError(error);
    }
  }

  async get(id) {
    const tasks = await this.list();
    const key = String(id);
    const task = tasks.find((candidate) =>
      candidate.id === key
      || candidate.itemId === key
      || String(candidate.number) === key
      || candidate.url === key);
    if (!task) {
      throw new TaskBackendError(`task ${id} was not found`, {
        code: 'not-found',
        status: 404,
      });
    }
    return task;
  }

  async create(input) {
    assertObject(input, 'create input');
    if (input.idempotencyKey) {
      throw new TaskBackendError('GitHub create does not support idempotency keys', {
        code: 'idempotency-unsupported',
      });
    }
    const title = requireText(input.title, 'title');
    const status = input.status ?? 'open';
    if (!WORK_STATUSES.has(status)) {
      throw new TaskBackendError(`unsupported status: ${status}`, { code: 'invalid-input' });
    }
    let issue;
    let item;
    try {
      issue = await this.transport.createIssue({
        title,
        body: String(input.description ?? ''),
      });
      item = await this.transport.addProjectItem(issue.node_id);
      if (!item?.id) throw new Error('GitHub did not return a Project item id');
      const created = {
        id: issue.node_id,
        itemId: item.id,
        number: issue.number,
        url: issue.html_url,
      };
      const task = await this.get(item.id);
      return this.update(task.id, {
        status,
        priority: input.priority ?? 'normal',
        nextActionDate: input.nextActionDate ?? '',
        deadline: input.deadline ?? '',
        playbook: input.playbook ?? '',
        workstream: input.workstream ?? '',
        sessionId: input.sessionId ?? '',
        agentStatus: input.agentStatus ?? '',
      });
    } catch (error) {
      if (!issue) throw backendError(error);
      throw new TaskBackendError(
        `GitHub task creation was only partially completed: ${error.message}`,
        {
          code: 'partial-write',
          details: {
            taskId: issue.node_id,
            issueNumber: issue.number,
            issueUrl: issue.html_url,
            projectItemId: item?.id ?? null,
            projectItemCreated: Boolean(item?.id),
          },
        },
      );
    }
  }

  async update(id, input) {
    assertObject(input, 'update input');
    const current = await this.get(id);
    if (input.priority !== undefined && !PRIORITIES.has(input.priority)) {
      throw new TaskBackendError(`unsupported priority: ${input.priority}`, {
        code: 'invalid-input',
      });
    }
    if (input.status !== undefined && !WORK_STATUSES.has(input.status)) {
      throw new TaskBackendError(`unsupported status: ${input.status}`, {
        code: 'invalid-input',
      });
    }
    if (input.agentStatus !== undefined && !AGENT_STATUSES.has(input.agentStatus)) {
      throw new TaskBackendError(`unsupported agentStatus: ${input.agentStatus}`, {
        code: 'invalid-input',
      });
    }
    try {
      const issueChanges = {};
      if (input.title !== undefined) issueChanges.title = requireText(input.title, 'title');
      if (input.description !== undefined) issueChanges.body = String(input.description);
      if (Object.keys(issueChanges).length) {
        await this.transport.updateIssue(current.number, issueChanges);
      }
      if (input.status !== undefined && input.status !== current.status) {
        const issueState = input.status === 'open'
          ? { state: 'open' }
          : {
              state: 'closed',
              state_reason: input.status === 'done' ? 'completed' : 'not_planned',
            };
        await this.transport.updateIssue(current.number, issueState);
        await this.transport.updateField(current.itemId, 'Status', input.status);
      }
      for (const [inputName, fieldName] of [
        ['priority', 'priority'],
        ['nextActionDate', 'next-action-date'],
        ['deadline', 'deadline'],
        ['playbook', 'playbook'],
        ['workstream', 'workstream'],
        ['sessionId', 'session-id'],
        ['agentStatus', 'agent-status'],
      ]) {
        if (input[inputName] !== undefined && input[inputName] !== current[inputName]) {
          await this.transport.updateField(current.itemId, fieldName, String(input[inputName]));
        }
      }
      return await this.get(current.id);
    } catch (error) {
      throw backendError(error);
    }
  }

  async comment(id, input) {
    assertObject(input, 'comment input');
    const content = requireText(input.content, 'comment content');
    const task = await this.get(id);
    try {
      const comment = await this.transport.addComment(task.number, content);
      return {
        taskId: task.id,
        commentId: String(comment.id ?? comment.node_id),
        recorded: true,
      };
    } catch (error) {
      throw backendError(error);
    }
  }

  report(id, input) {
    return this.comment(id, input);
  }

  async comments(id) {
    const task = await this.get(id);
    try {
      return (await this.transport.listComments(task.number)).map((comment) => ({
        id: String(comment.id ?? comment.node_id),
        taskId: task.id,
        content: comment.body ?? '',
        postedAt: comment.created_at ?? '',
        updatedAt: comment.updated_at ?? '',
        url: comment.html_url ?? '',
        author: comment.user?.login ?? null,
      }));
    } catch (error) {
      throw backendError(error);
    }
  }

  reports(id) {
    return this.comments(id);
  }

  complete(id, input = {}) {
    const outcome = input.outcome ?? 'done';
    if (!['done', 'rejected'].includes(outcome)) {
      throw new TaskBackendError('completion outcome must be done or rejected', {
        code: 'invalid-input',
      });
    }
    return this.update(id, { status: outcome });
  }

  reopen(id) {
    return this.update(id, { status: 'open' });
  }

  async remove() {
    throw new TaskBackendError('GitHub Issues are retained; close the task instead', {
      code: 'unsupported-mapping',
    });
  }
}

export { FIELD_CONTRACT, GitHubProjectTransport };
