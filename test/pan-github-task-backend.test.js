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

function strictProjectTransport() {
  let issue = null;
  let item = null;
  const fieldWrites = [];

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
          return {
            data: {
              repositoryOwner: {
                projectV2: {
                  items: {
                    nodes: item ? [item] : [],
                    pageInfo: { hasNextPage: false, endCursor: null },
                  },
                },
              },
            },
          };
        }
        if (query.includes('mutation AddProjectItem')) {
          assert.equal(variables.projectId, 'project');
          assert.equal(variables.contentId, issue.id);
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
