import assert from 'node:assert/strict';
import test from 'node:test';
import { GitHubTaskBackend } from '../bin/pan-github-task-backend.js';

const PROJECT_FIELDS = [
  {
    __typename: 'ProjectV2SingleSelectField',
    id: 'status',
    name: 'Status',
    dataType: 'SINGLE_SELECT',
    options: ['open', 'done', 'rejected'].map((name) => ({ id: name, name })),
  },
  {
    __typename: 'ProjectV2SingleSelectField',
    id: 'priority',
    name: 'priority',
    dataType: 'SINGLE_SELECT',
    options: ['urgent', 'high', 'normal', 'low'].map((name) => ({ id: name, name })),
  },
  ...['next-action-date', 'deadline'].map((name) => ({
    __typename: 'ProjectV2Field',
    id: name,
    name,
    dataType: 'DATE',
  })),
  ...['next-step', 'playbook', 'workstream', 'session-id'].map((name) => ({
    __typename: 'ProjectV2Field',
    id: name,
    name,
    dataType: 'TEXT',
  })),
  {
    __typename: 'ProjectV2SingleSelectField',
    id: 'agent-status',
    name: 'agent-status',
    dataType: 'SINGLE_SELECT',
    options: ['requested', 'running'].map((name) => ({ id: name, name })),
  },
];

function graphqlVariables(args) {
  const variables = {};
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== '-F') continue;
    const value = args[index + 1];
    const separator = value.indexOf('=');
    variables[value.slice(0, separator)] = value.slice(separator + 1);
    index += 1;
  }
  return variables;
}

function strictProjectTransport({
  visibleInList = true,
  failFieldId = null,
  directProjectId = 'project',
  directRepository = 'example/domain',
  directFieldValues,
} = {}) {
  let issue = null;
  let item = null;
  let issuePostCount = 0;
  let projectItemAddCount = 0;
  let listCalls = 0;
  let directItemReads = 0;
  const fieldWrites = [];
  const issueWrites = [];

  function project() {
    return {
      id: 'project',
      number: 1,
      title: 'Tasks',
      fields: { nodes: PROJECT_FIELDS },
    };
  }

  return {
    fieldWrites,
    issueWrites,
    get issuePostCount() {
      return issuePostCount;
    },
    get projectItemAddCount() {
      return projectItemAddCount;
    },
    get listCalls() {
      return listCalls;
    },
    get directItemReads() {
      return directItemReads;
    },
    async runGh(args, options = {}) {
      if (args[0] === 'api' && args[1] === 'graphql') {
        const query = args.find((arg) => arg.startsWith('query='))?.slice('query='.length) ?? '';
        const variables = graphqlVariables(args);
        if (query.includes('query ProjectContract')) {
          return {
            data: {
              repository: {
                id: 'repository',
                nameWithOwner: 'example/domain',
              },
              repositoryOwner: { projectV2: project() },
            },
          };
        }
        if (query.includes('query ProjectItems')) {
          assert.match(query, /ProjectV2ItemFieldTextValue/);
          listCalls += 1;
          return {
            data: {
              repositoryOwner: {
                projectV2: {
                  items: {
                    nodes: item && visibleInList ? [item] : [],
                    pageInfo: { hasNextPage: false, endCursor: null },
                  },
                },
              },
            },
          };
        }
        if (query.includes('query ProjectItem(')) {
          assert.equal(variables.itemId, item?.id);
          directItemReads += 1;
          const readbackNodes = typeof directFieldValues === 'function'
            ? directFieldValues(item.fieldValues.nodes)
            : directFieldValues ?? item.fieldValues.nodes;
          return {
            data: {
              node: item ? {
                ...item,
                project: { id: directProjectId },
                fieldValues: { nodes: readbackNodes },
                content: {
                  ...item.content,
                  repository: { nameWithOwner: directRepository },
                },
              } : null,
            },
          };
        }
        if (query.includes('mutation AddProjectItem')) {
          assert.equal(variables.projectId, 'project');
          assert.equal(variables.contentId, issue.id);
          projectItemAddCount += 1;
          item = {
            id: 'item-1',
            fieldValues: { nodes: [] },
            content: issue,
          };
          return { data: { addProjectV2ItemById: { item: { id: item.id } } } };
        }
        if (query.includes('mutation UpdateField')) {
          const field = PROJECT_FIELDS.find((candidate) => candidate.id === variables.fieldId);
          assert.ok(field);
          if (field.id === failFieldId) {
            throw new Error(`simulated ${field.name} write failure`);
          }
          let value;
          if (query.includes('singleSelectOptionId:')) {
            const optionId = JSON.parse(
              query.match(/singleSelectOptionId:\s*("(?:[^"\\]|\\.)*")/)?.[1],
            );
            value = field.options.find((option) => option.id === optionId)?.name;
          } else if (query.includes('date:')) {
            value = JSON.parse(query.match(/date:\s*("(?:[^"\\]|\\.)*")/)?.[1]);
          } else {
            value = JSON.parse(query.match(/text:\s*("(?:[^"\\]|\\.)*")/)?.[1]);
          }
          item.fieldValues.nodes = item.fieldValues.nodes.filter(
            (node) => node.field.name !== field.name,
          );
          item.fieldValues.nodes.push({
            field: { name: field.name },
            ...(field.dataType === 'SINGLE_SELECT'
              ? { name: value }
              : field.dataType === 'DATE' ? { date: value } : { text: value }),
          });
          fieldWrites.push({
            operation: 'set',
            fieldId: variables.fieldId,
            itemId: variables.itemId,
            query,
            value,
          });
          return { data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: item.id } } } };
        }
        if (query.includes('mutation ClearField')) {
          const field = PROJECT_FIELDS.find((candidate) => candidate.id === variables.fieldId);
          assert.ok(field);
          item.fieldValues.nodes = item.fieldValues.nodes.filter(
            (node) => node.field.name !== field.name,
          );
          fieldWrites.push({
            operation: 'clear',
            fieldId: variables.fieldId,
            itemId: variables.itemId,
            query,
          });
          return { data: { clearProjectV2ItemFieldValue: { projectV2Item: { id: item.id } } } };
        }
        throw new Error(`unexpected GraphQL query: ${query}`);
      }

      const route = args[1];
      if (route === 'repos/example/domain/issues' && args.includes('POST')) {
        issuePostCount += 1;
        const input = JSON.parse(options.input);
        issue = {
          id: 'issue-1',
          node_id: 'issue-1',
          number: 1,
          title: input.title,
          body: input.body,
          url: 'https://github.com/example/domain/issues/1',
          html_url: 'https://github.com/example/domain/issues/1',
          state: 'OPEN',
          stateReason: null,
          createdAt: '2026-09-18T00:00:00Z',
          updatedAt: '2026-09-18T00:00:00Z',
          closedAt: null,
          repository: { nameWithOwner: 'example/domain' },
        };
        return issue;
      }
      if (route === 'repos/example/domain/issues/1' && args.includes('PATCH')) {
        const input = JSON.parse(options.input);
        if (input.title !== undefined) issue.title = input.title;
        if (input.body !== undefined) issue.body = input.body;
        if (input.state !== undefined) {
          issue.state = input.state === 'closed' ? 'CLOSED' : 'OPEN';
          issue.stateReason = input.state === 'closed'
            ? input.state_reason === 'completed' ? 'COMPLETED' : 'NOT_PLANNED'
            : null;
          issue.closedAt = input.state === 'closed' ? '2026-09-18T00:01:00Z' : null;
        }
        issueWrites.push(input);
        return issue;
      }
      throw new Error(`unexpected gh request: ${args.join(' ')}`);
    },
  };
}

function strictOwnerTransport(ownerType) {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    async runGh(args) {
      calls += 1;
      const query = args.find((arg) => arg.startsWith('query='))?.slice('query='.length) ?? '';
      if (query.includes('user(login: $projectOwner)') && ownerType !== 'User') {
        throw new Error('Could not resolve to a User with the requested login');
      }
      if (query.includes('organization(login: $projectOwner)')
        && ownerType !== 'Organization') {
        throw new Error('Could not resolve to an Organization with the requested login');
      }
      assert.doesNotMatch(query, /\b(?:user|organization)\(login: \$projectOwner\)/);
      assert.match(query, /repositoryOwner\(login: \$projectOwner\)/);
      assert.match(query, /\.\.\. on ProjectV2Owner/);
      assert.ok(args.includes('projectOwner=example'));
      assert.ok(args.includes('projectNumber=1'));
      if (query.includes('query ProjectItems')) {
        return {
          data: {
            repositoryOwner: {
              __typename: ownerType,
              projectV2: {
                items: {
                  nodes: [],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          },
        };
      }
      return {
        data: {
          repository: {
            id: 'repository',
            nameWithOwner: 'example/domain',
          },
          repositoryOwner: {
            __typename: ownerType,
            projectV2: {
              id: 'project',
              number: 1,
              title: 'Tasks',
              fields: { nodes: PROJECT_FIELDS },
            },
          },
        },
      };
    },
  };
}

for (const [ownerType, ownerLabel] of [
  ['User', 'a user'],
  ['Organization', 'an organization'],
]) {
  test(`GitHub Project initialization and listing resolve ${ownerLabel} owner without invalid owner queries`, async () => {
    const transport = strictOwnerTransport(ownerType);
    const backend = new GitHubTaskBackend({
      backend: 'github',
      repository: 'example/domain',
      projectOwner: 'example',
      projectNumber: 1,
    }, { runGh: transport.runGh });

    assert.equal(await backend.initialize(), backend);
    assert.deepEqual(await backend.list(), []);
    assert.equal(transport.calls, 2);
  });
}

test('GitHub Project text field creates, reads, updates, and clears nextStep', async () => {
  const transport = strictProjectTransport();
  const backend = await new GitHubTaskBackend({
    backend: 'github',
    repository: 'example/domain',
    projectOwner: 'example',
    projectNumber: 1,
  }, { runGh: transport.runGh }).initialize();

  const created = await backend.create({
    title: 'Publish the reviewed change',
    priority: 'high',
    nextStep: 'PR published - ready for review',
    sessionId: 'saved-session',
    agentStatus: 'running',
  });
  assert.equal(created.nextStep, 'PR published - ready for review');
  assert.equal(created.title, 'Publish the reviewed change');
  assert.equal(created.status, 'open');
  assert.equal(created.sessionId, 'saved-session');
  assert.equal(created.agentStatus, 'running');

  const listed = await backend.list();
  assert.equal(listed[0].nextStep, 'PR published - ready for review');
  assert.equal((await backend.get(created.itemId)).nextStep, 'PR published - ready for review');

  const updated = await backend.update(created.id, {
    nextStep: 'Awaiting reviewer decision',
  });
  assert.equal(updated.nextStep, 'Awaiting reviewer decision');
  assert.equal(updated.id, created.id);
  assert.equal(updated.itemId, created.itemId);
  assert.equal(updated.title, created.title);
  assert.equal(updated.sessionId, created.sessionId);
  assert.equal(updated.agentStatus, created.agentStatus);

  const cleared = await backend.update(created.id, { nextStep: '' });
  assert.equal(cleared.nextStep, '');
  assert.equal(cleared.status, 'open');
  assert.equal(cleared.sessionId, 'saved-session');
  assert.equal(cleared.agentStatus, 'running');
  assert.deepEqual(
    transport.fieldWrites
      .filter((write) => write.fieldId === 'next-step')
      .map(({ operation, itemId, value }) => ({ operation, itemId, value })),
    [
      {
        operation: 'set',
        itemId: 'item-1',
        value: 'PR published - ready for review',
      },
      {
        operation: 'set',
        itemId: 'item-1',
        value: 'Awaiting reviewer decision',
      },
      {
        operation: 'clear',
        itemId: 'item-1',
        value: undefined,
      },
    ],
  );
  const nextStepSet = transport.fieldWrites.find(
    (write) => write.fieldId === 'next-step' && write.operation === 'set',
  );
  assert.match(nextStepSet.query, /updateProjectV2ItemFieldValue/);
  assert.match(nextStepSet.query, /value:\s*\{\s*text:/);
  const nextStepClear = transport.fieldWrites.find(
    (write) => write.fieldId === 'next-step' && write.operation === 'clear',
  );
  assert.match(nextStepClear.query, /clearProjectV2ItemFieldValue/);
});

test('GitHub create persists and directly reads initial fields while collection visibility is delayed', async () => {
  const transport = strictProjectTransport({ visibleInList: false });
  const backend = await new GitHubTaskBackend({
    backend: 'github',
    repository: 'example/domain',
    projectOwner: 'example',
    projectNumber: 1,
  }, { runGh: transport.runGh }).initialize();

  const created = await backend.create({
    title: 'Review animation tuning',
    description: 'Publish the PR when the tuning is ready.',
    status: 'open',
    priority: 'normal',
    nextActionDate: '2026-09-19',
    nextStep: 'Review the latest tuning',
    deadline: '2026-09-26',
    playbook: 'review-and-publish',
    workstream: 'animation',
    sessionId: 'session-1',
    agentStatus: 'running',
  });

  assert.deepEqual(
    {
      id: created.id,
      itemId: created.itemId,
      title: created.title,
      description: created.description,
      status: created.status,
      priority: created.priority,
      nextActionDate: created.nextActionDate,
      nextStep: created.nextStep,
      deadline: created.deadline,
      playbook: created.playbook,
      workstream: created.workstream,
      sessionId: created.sessionId,
      agentStatus: created.agentStatus,
      issueState: created.issueState,
    },
    {
      id: 'issue-1',
      itemId: 'item-1',
      title: 'Review animation tuning',
      description: 'Publish the PR when the tuning is ready.',
      status: 'open',
      priority: 'normal',
      nextActionDate: '2026-09-19',
      nextStep: 'Review the latest tuning',
      deadline: '2026-09-26',
      playbook: 'review-and-publish',
      workstream: 'animation',
      sessionId: 'session-1',
      agentStatus: 'running',
      issueState: 'OPEN',
    },
  );
  assert.equal(transport.issuePostCount, 1);
  assert.equal(transport.projectItemAddCount, 1);
  assert.equal(transport.listCalls, 0);
  assert.equal(transport.directItemReads, 1);
  assert.deepEqual(
    transport.fieldWrites.map(({ fieldId, value }) => [fieldId, value]),
    [
      ['status', 'open'],
      ['priority', 'normal'],
      ['next-action-date', '2026-09-19'],
      ['next-step', 'Review the latest tuning'],
      ['deadline', '2026-09-26'],
      ['playbook', 'review-and-publish'],
      ['workstream', 'animation'],
      ['session-id', 'session-1'],
      ['agent-status', 'running'],
    ],
  );
});

for (const {
  name,
  input,
  directFieldValues,
} of [
  {
    name: 'missing explicit open and normal Project fields',
    input: {
      title: 'Task with missing defaults',
      status: 'open',
      priority: 'normal',
    },
    directFieldValues: [],
  },
  {
    name: 'mismatched non-empty Project metadata',
    input: {
      title: 'Task with mismatched metadata',
      priority: 'high',
      nextStep: 'Review the tuning',
    },
    directFieldValues: (nodes) => nodes.map((node) => (
      node.field.name === 'next-step'
        ? { ...node, text: 'Different next step' }
        : node
    )),
  },
  {
    name: 'missing done Project Status',
    input: {
      title: 'Task with missing done status',
      status: 'done',
    },
    directFieldValues: (nodes) => nodes.filter((node) => node.field.name !== 'Status'),
  },
]) {
  test(`GitHub create reports partial write for ${name}`, async () => {
    const transport = strictProjectTransport({
      visibleInList: false,
      directFieldValues,
    });
    const backend = await new GitHubTaskBackend({
      backend: 'github',
      repository: 'example/domain',
      projectOwner: 'example',
      projectNumber: 1,
    }, { runGh: transport.runGh }).initialize();

    await assert.rejects(
      backend.create(input),
      (error) => {
        assert.equal(error.code, 'partial-write');
        assert.match(error.message, /initial fields could not be confirmed/);
        assert.deepEqual(error.details, {
          taskId: 'issue-1',
          issueNumber: 1,
          issueUrl: 'https://github.com/example/domain/issues/1',
          projectItemId: 'item-1',
          projectItemCreated: true,
        });
        return true;
      },
    );
    assert.equal(transport.issuePostCount, 1);
    assert.equal(transport.projectItemAddCount, 1);
    assert.equal(transport.listCalls, 0);
    assert.equal(transport.directItemReads, 1);
  });
}

for (const [status, issueStateReason] of [
  ['done', 'COMPLETED'],
  ['rejected', 'NOT_PLANNED'],
]) {
  test(`GitHub create persists ${status} native and Project work status before direct readback`, async () => {
    const transport = strictProjectTransport({ visibleInList: false });
    const backend = await new GitHubTaskBackend({
      backend: 'github',
      repository: 'example/domain',
      projectOwner: 'example',
      projectNumber: 1,
    }, { runGh: transport.runGh }).initialize();

    const created = await backend.create({
      title: `${status} task`,
      status,
    });

    assert.equal(created.status, status);
    assert.equal(created.issueState, 'CLOSED');
    assert.equal(created.issueStateReason, issueStateReason);
    assert.deepEqual(transport.issueWrites, [{
      state: 'closed',
      state_reason: status === 'done' ? 'completed' : 'not_planned',
    }]);
    assert.deepEqual(
      transport.fieldWrites.slice(0, 2).map(({ fieldId, value }) => [fieldId, value]),
      [
        ['status', status],
        ['priority', 'normal'],
      ],
    );
    assert.equal(transport.issuePostCount, 1);
    assert.equal(transport.projectItemAddCount, 1);
    assert.equal(transport.listCalls, 0);
    assert.equal(transport.directItemReads, 1);
  });
}

test('GitHub create reports field API failures as partial writes without repeating creation', async () => {
  const transport = strictProjectTransport({
    visibleInList: false,
    failFieldId: 'priority',
  });
  const backend = await new GitHubTaskBackend({
    backend: 'github',
    repository: 'example/domain',
    projectOwner: 'example',
    projectNumber: 1,
  }, { runGh: transport.runGh }).initialize();

  await assert.rejects(
    backend.create({
      title: 'Task with failed metadata',
      priority: 'high',
    }),
    (error) => {
      assert.equal(error.code, 'partial-write');
      assert.match(error.message, /simulated priority write failure/);
      assert.deepEqual(error.details, {
        taskId: 'issue-1',
        issueNumber: 1,
        issueUrl: 'https://github.com/example/domain/issues/1',
        projectItemId: 'item-1',
        projectItemCreated: true,
      });
      return true;
    },
  );
  assert.equal(transport.issuePostCount, 1);
  assert.equal(transport.projectItemAddCount, 1);
  assert.equal(transport.listCalls, 0);
  assert.equal(transport.directItemReads, 0);
});

for (const [scope, transportOptions] of [
  ['another Project', { directProjectId: 'other-project' }],
  ['another repository', { directRepository: 'example/other' }],
]) {
  test(`GitHub create rejects direct readback from ${scope}`, async () => {
    const transport = strictProjectTransport({
      visibleInList: false,
      ...transportOptions,
    });
    const backend = await new GitHubTaskBackend({
      backend: 'github',
      repository: 'example/domain',
      projectOwner: 'example',
      projectNumber: 1,
    }, { runGh: transport.runGh }).initialize();

    await assert.rejects(
      backend.create({ title: 'Scoped task' }),
      (error) => {
        assert.equal(error.code, 'partial-write');
        assert.match(error.message, /not found in the configured Project/);
        assert.equal(error.details.taskId, 'issue-1');
        assert.equal(error.details.projectItemId, 'item-1');
        return true;
      },
    );
    assert.equal(transport.issuePostCount, 1);
    assert.equal(transport.projectItemAddCount, 1);
    assert.equal(transport.listCalls, 0);
    assert.equal(transport.directItemReads, 1);
  });
}
