import assert from 'node:assert/strict';
import test from 'node:test';
import {
  readAllItems,
  readItemById,
  Runner,
} from '../bin/pan-runner.js';
import { FIELD } from '../bin/pan-runner-poll.js';

const SELECT_FIELDS = new Set([
  FIELD.status,
  FIELD.nextAction,
  FIELD.priority,
  FIELD.playbook,
  FIELD.executionAuthorized,
  FIELD.workerState,
  FIELD.resourceSemantics,
]);

function task({
  id,
  number,
  state = 'OPEN',
  workerState = 'idle',
  machine = '',
  sessionId = '',
  claimGeneration = '',
  revision = '1',
}) {
  return {
    itemId: id,
    issue: {
      number,
      title: `Task ${number}`,
      body: '',
      url: `https://github.com/example/domain/issues/${number}`,
      repo: 'example/domain',
      state,
    },
    fields: {
      [FIELD.status]: 'ready-for-ai',
      [FIELD.nextAction]: 'execute',
      [FIELD.priority]: 'normal',
      [FIELD.playbook]: 'default',
      [FIELD.executionAuthorized]: 'yes',
      [FIELD.dependencies]: '',
      [FIELD.workerState]: workerState,
      [FIELD.machine]: machine,
      [FIELD.sessionId]: sessionId,
      [FIELD.claimGeneration]: claimGeneration,
      [FIELD.claimedBy]: '',
      [FIELD.leaseUntil]: '',
      [FIELD.resourceSemantics]: '',
      [FIELD.taskRevision]: revision,
    },
  };
}

function fieldNode(name, value, select = SELECT_FIELDS.has(name)) {
  return select
    ? {
        __typename: 'ProjectV2ItemFieldSingleSelectValue',
        name: value,
        field: { name },
      }
    : {
        __typename: 'ProjectV2ItemFieldTextValue',
        text: value,
        field: { name },
      };
}

function graphQlNode(source) {
  return {
    id: source.itemId,
    content: {
      __typename: 'Issue',
      number: source.issue.number,
      title: source.issue.title,
      body: source.issue.body,
      url: source.issue.url,
      state: source.issue.state,
      repository: { nameWithOwner: source.issue.repo },
    },
    fieldValues: {
      nodes: Object.entries(source.fields)
        .filter(([, value]) => value !== '')
        .map(([name, value]) => fieldNode(name, value)),
      pageInfo: { hasNextPage: false, endCursor: null },
    },
  };
}

function graphQlRunner(source) {
  const node = graphQlNode(source);
  const queries = [];
  const writes = [];
  const launches = [];
  const cfg = {
    lifecycleVersion: 2,
    project: { owner: 'example', number: 1 },
    machine: 'machine-a',
    identity: 'runner-a',
    leaseMinutes: 15,
    maxConcurrent: 1,
    humanAttentionBackpressure: { mode: 'off', softLimit: 5 },
  };
  const meta = { ownerType: 'user', fields: new Map() };
  const runJson = async (args) => {
    const query = String(args.find((arg) => String(arg).startsWith('query='))).slice(6);
    queries.push(query);
    if (query.includes('items(first:100')) {
      return {
        data: {
          user: {
            projectV2: {
              items: {
                nodes: [structuredClone(node)],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        },
      };
    }
    if (query.includes('node(id:$id)')) {
      return { data: { node: structuredClone(node) } };
    }
    throw new Error(`unexpected GraphQL query: ${query}`);
  };
  const setField = (field, value, select) => {
    const existing = node.fieldValues.nodes.find((entry) => entry.field?.name === field);
    if (existing) {
      if (select) existing.name = value;
      else existing.text = value;
    } else if (value !== '') {
      node.fieldValues.nodes.push(fieldNode(field, value, select));
    }
    writes.push({ field, value });
  };
  const runner = new Runner(
    cfg,
    meta,
    new Map([['default', {
      capacity: 1,
      humanAttention: 'may-request',
      checkpointRelease: 'forbidden',
    }]]),
    {
      readAllItems: () => readAllItems(cfg, meta, runJson),
      readItemById: (itemId) => readItemById(itemId, runJson),
      setTextField: async (_cfg, _meta, _itemId, field, value) => {
        setField(field, value == null ? '' : String(value), false);
      },
      setSelectField: async (_cfg, _meta, _itemId, field, value) => {
        setField(field, value, true);
      },
      updateIssueCurrentAction: async () => {},
      gh: async () => '',
    },
  );
  runner.launchWorker = async (item) => {
    launches.push(item.itemId);
  };
  return { cfg, meta, node, queries, writes, launches, runJson, runner };
}

test('production-shaped Project reads preserve Issue state through selection, claim, and resume', async () => {
  const fresh = graphQlRunner(task({ id: 'fresh', number: 1 }));
  const parsedFresh = await readAllItems(fresh.cfg, fresh.meta, fresh.runJson);
  assert.equal(parsedFresh[0].issue.state, 'OPEN');
  assert.equal((await fresh.runner.pollAndClaim()).claimed, 1);
  assert.deepEqual(fresh.launches, ['fresh']);
  assert.equal(
    fresh.node.fieldValues.nodes.find((entry) => entry.field?.name === FIELD.status)?.name,
    'ai-executing',
  );
  assert.ok(
    fresh.queries.filter((query) => query.includes('node(id:$id)')).length >= 2,
    'claim must use fresh and post-write Project item reads',
  );

  const generation = '11111111-1111-4111-8111-111111111111';
  const resume = graphQlRunner(task({
    id: 'resume',
    number: 2,
    workerState: 'paused',
    machine: 'machine-a',
    sessionId: '22222222-2222-4222-8222-222222222222',
    claimGeneration: generation,
    revision: '9',
  }));
  assert.equal((await resume.runner.pollAndClaim()).claimed, 1);
  assert.deepEqual(resume.launches, ['resume']);
  const parsedResume = await readItemById('resume', resume.runJson);
  assert.equal(parsedResume.issue.state, 'OPEN');
  assert.equal(parsedResume.fields[FIELD.claimGeneration], generation);
  assert.ok(
    resume.queries.filter((query) => query.includes('node(id:$id)')).length >= 2,
    'resume must use fresh and post-write Project item reads',
  );

  for (const query of [...fresh.queries, ...resume.queries].filter((value) =>
    value.includes('... on Issue'))) {
    assert.match(query, /\.\.\. on Issue\s*\{[^}]*\bstate\b/);
  }
});

test('production-shaped CLOSED Issue is rejected by both selection and fresh claim re-read', async () => {
  const source = task({ id: 'closed', number: 3, state: 'CLOSED' });
  const fixture = graphQlRunner(source);
  const [parsed] = await readAllItems(fixture.cfg, fixture.meta, fixture.runJson);
  assert.equal(parsed.issue.state, 'CLOSED');
  assert.equal((await fixture.runner.pollAndClaim()).claimed, 0);

  const staleOpen = structuredClone(parsed);
  staleOpen.issue.state = 'OPEN';
  assert.equal(await fixture.runner.claimAndLaunch(staleOpen), false);
  assert.deepEqual(fixture.writes, []);
  assert.deepEqual(fixture.launches, []);
});
