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
  ...['playbook', 'workstream', 'session-id'].map((name) => ({
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
  test(`GitHub Project initialization resolves ${ownerLabel} owner without invalid owner queries`, async () => {
    const transport = strictOwnerTransport(ownerType);
    const backend = new GitHubTaskBackend({
      backend: 'github',
      repository: 'example/domain',
      projectOwner: 'example',
      projectNumber: 1,
    }, { runGh: transport.runGh });

    assert.equal(await backend.initialize(), backend);
    assert.equal(transport.calls, 1);
  });
}
