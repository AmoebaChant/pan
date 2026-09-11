import assert from 'node:assert/strict';
import test from 'node:test';
import {
  completeTaskStoreItemFieldValues,
  computeRecurringSuccessor,
  GitHubTaskStore,
  resolveRecurringSuccessorEvidence,
} from '../bin/pan-github-task-store.js';
import { completeItemFieldValues } from '../bin/pan-runner.js';
import { CANONICAL_FIELDS } from '../bin/pan-project-schema.js';
import {
  applyLifecycleMigration,
  applyLifecycleRollback,
  planLifecycleMigration,
  planLifecycleRollback,
} from '../bin/pan-lifecycle-migration.js';
import {
  applyTodoistImport,
  planTodoistImport,
  todoistImportRecords,
  verifyTodoistImport,
} from '../bin/pan-todoist-migration.js';
import {
  parseCurrentActionBlock,
  renderCurrentActionBlock,
  transitionComment,
  upsertCurrentActionBlock,
} from '../bin/pan-task-model.js';

function recurring(occurrence, rule) {
  return [
    `Pan: recurrence occurrence ${occurrence}`,
    '',
    '# Outcome',
    '',
    'Keep the recurring commitment.',
    '',
    '## Recurrence',
    '',
    rule,
  ].join('\n');
}

function verifiedCutover(task, classification, overrides = {}) {
  return {
    itemId: task.itemId,
    classification,
    projection: task.projection,
    status: task.status,
    owner: task.legacyOwner || 'unassigned',
    issueState: task.issueState,
    workerState: task.workerState || '',
    machine: task.machine || '',
    sessionId: task.sessionId || '',
    claimGeneration: task.claimGeneration || '',
    claimedBy: task.claimedBy || '',
    leaseUntil: task.leaseUntil || '',
    needsHumanSince: task.needsHumanSince || '',
    action: classification === 'verifiedDeliberateHold' ? 'hold' : 'approve',
    detail: classification === 'verifiedDeliberateHold'
      ? 'Keep paused until the user explicitly marks the outcome ready again.'
      : 'Approve publishing the verified mobile build, or discuss the build number.',
    targetWorkerState: 'checkpointed',
    executionAuthorized: false,
    verifiedDeadProcess: true,
    verifiedWritersStopped: true,
    ...overrides,
  };
}

test('weekly recurrence derives from nominal occurrence and closed day, recording skipped slots', () => {
  assert.deepEqual(
    computeRecurringSuccessor(recurring('2026-09-04', 'Every Friday.'), '2026-09-18'),
    {
      occurrence: '2026-09-04',
      rule: 'Every Friday.',
      nextOccurrence: '2026-09-25',
      skipped: ['2026-09-11', '2026-09-18'],
    },
  );
});

test('multi-week and monthly recurrence reject arbitrary or inconsistent dates', () => {
  assert.equal(
    computeRecurringSuccessor(
      recurring('2026-09-07', 'Every two weeks on Monday.'),
      '2026-09-20',
    ).nextOccurrence,
    '2026-09-21',
  );
  assert.equal(
    computeRecurringSuccessor(
      recurring('2026-09-07', 'The first Monday of every month.'),
      '2026-11-15',
    ).nextOccurrence,
    '2026-12-07',
  );
  assert.throws(
    () => computeRecurringSuccessor(
      recurring('2026-09-08', 'Every Friday.'),
      '2026-09-09',
    ),
    /does not satisfy/,
  );
  assert.throws(
    () => computeRecurringSuccessor(recurring('2026-09-04', 'Whenever convenient.'), '2026-09-09'),
    /unsupported/,
  );
  assert.throws(
    () => computeRecurringSuccessor(
      `Intro\n${recurring('2026-09-04', 'Every Friday.')}`,
      '2026-09-09',
    ),
    /first-line/,
  );
});

test('recurrence recovery uses the reverse marker after backlink failure and verifies targets', () => {
  const currentUrl = 'https://github.com/example/domain/issues/1';
  const successor = {
    url: 'https://github.com/example/domain/issues/2',
    body: `Pan: recurrence occurrence 2026-09-11\nPan: previous occurrence ${currentUrl}`,
  };
  assert.equal(resolveRecurringSuccessorEvidence({
    currentUrl,
    domainSlug: 'example/domain',
    comments: [],
    issues: [successor],
  }), successor);
  assert.throws(
    () => resolveRecurringSuccessorEvidence({
      currentUrl,
      domainSlug: 'example/domain',
      comments: [{ body: 'Pan: next occurrence https://github.com/example/domain/issues/404' }],
      issues: [successor],
    }),
    /disagree/,
  );
  assert.throws(
    () => resolveRecurringSuccessorEvidence({
      currentUrl,
      domainSlug: 'example/domain',
      comments: [{ body: 'Pan: next occurrence https://github.com/other/domain/issues/2' }],
      issues: [],
    }),
    /outside/,
  );
  const backlinkOnly = {
    url: 'https://github.com/example/domain/issues/3',
    body: 'Pan: recurrence occurrence 2026-09-11',
  };
  assert.equal(resolveRecurringSuccessorEvidence({
    currentUrl,
    domainSlug: 'example/domain',
    comments: [{ body: `Pan: next occurrence ${backlinkOnly.url}` }],
    issues: [backlinkOnly],
  }), backlinkOnly);
});

test('both Project readers paginate beyond the first fieldValues page and reject cursor loops', async () => {
  const first = {
    id: 'PVTI_1',
    fieldValues: {
      nodes: [{ text: 'ready-for-ai', field: { name: 'Status-shadow' } }],
      pageInfo: { hasNextPage: true, endCursor: 'page-2' },
    },
  };
  const page = {
    data: {
      node: {
        fieldValues: {
          nodes: [{ text: '17', field: { name: 'task-revision' } }],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    },
  };
  for (const reader of [completeTaskStoreItemFieldValues, completeItemFieldValues]) {
    const calls = [];
    const complete = await reader(first, async (args) => {
      calls.push(args);
      return page;
    });
    assert.equal(calls.length, 1);
    assert.equal(complete.fieldValues.nodes.length, 2);
    assert.ok(calls[0].includes('cursor=page-2'));
    await assert.rejects(
      reader(first, async () => ({
        data: {
          node: {
            fieldValues: {
              nodes: [],
              pageInfo: { hasNextPage: true, endCursor: 'page-2' },
            },
          },
        },
      })),
      /repeated a field-value cursor/,
    );
  }
});

function fakeGitHubState({ projectReadNodes = null } = {}) {
      const fields = CANONICAL_FIELDS.map((field, index) => ({
        __typename: field.type === 'single-select' ? 'ProjectV2SingleSelectField' : 'ProjectV2Field',
        id: `field-${index}`,
        name: field.name,
        dataType: field.type === 'single-select'
          ? 'SINGLE_SELECT'
          : field.type === 'date'
            ? 'DATE'
            : 'TEXT',
        options: field.options?.map((name, optionIndex) => ({
          id: `option-${index}-${optionIndex}`,
          name,
        })),
      }));
      const byFieldId = new Map(fields.map((field) => [field.id, field]));
      const byOptionId = new Map(fields.flatMap((field) =>
        (field.options ?? []).map((option) => [option.id, { field: field.name, value: option.name }])));
      const issue = {
        number: 1,
        title: 'Old title',
        body: 'Pan: Todoist source task todo-1\n\nOld metadata',
        html_url: 'https://github.com/example/domain/issues/1',
        url: 'https://github.com/example/domain/issues/1',
        state: 'OPEN',
        stateReason: null,
        createdAt: '2026-09-01T00:00:00Z',
        updatedAt: '2026-09-01T00:00:00Z',
        closedAt: null,
      };
      const item = {
        id: 'item-1',
        updatedAt: '2026-09-01T00:00:00Z',
        issue,
        fields: {
          Status: 'ready-for-human',
          'next-action': 'act',
          priority: 'low',
          'execution-authorized': 'no',
          'worker-state': 'idle',
          'next-action-date': '2026-09-01',
          deadline: '',
          workstream: '',
          playbook: '',
          dependencies: '',
          'needs-human-since': '',
          'claimed-by': '',
          'lease-until': '',
          machine: '',
          'session-id': '',
          'claim-generation': '',
          'resource-semantics': '',
          'task-revision': '1',
        },
      };
      const issues = [issue];
      const items = [item];
      const comments = [{
        id: 'comment-1',
        author: { login: 'pan' },
        createdAt: '2026-09-01T00:00:00Z',
        updatedAt: '2026-09-01T00:00:00Z',
        url: `${issue.url}#issuecomment-1`,
        body: 'Pan: Todoist source comment c1\n\nstale',
      }];
      const commentsByIssue = new Map([[issue.number, comments]]);
      const writes = [];
      const queries = [];
      let projectReadCount = 0;
      const node = (projectItem = item) => ({
        id: projectItem.id,
        updatedAt: projectItem.updatedAt,
        project: { id: 'project-1' },
        content: {
          __typename: 'Issue',
          number: projectItem.issue.number,
          title: projectItem.issue.title,
          body: projectItem.issue.body,
          url: projectItem.issue.url,
          state: projectItem.issue.state,
          stateReason: projectItem.issue.stateReason,
          createdAt: projectItem.issue.createdAt,
          updatedAt: projectItem.issue.updatedAt,
          closedAt: projectItem.issue.closedAt,
          repository: { nameWithOwner: 'example/domain' },
        },
        fieldValues: {
          nodes: Object.entries(projectItem.fields).filter(([, value]) => value !== '').map(([name, value]) => {
            const field = fields.find((candidate) => candidate.name === name);
            if (field.dataType === 'SINGLE_SELECT') {
              return { __typename: 'ProjectV2ItemFieldSingleSelectValue', name: value, field: { name } };
            }
            if (field.dataType === 'DATE') {
              return { __typename: 'ProjectV2ItemFieldDateValue', date: value, field: { name } };
            }
            return { __typename: 'ProjectV2ItemFieldTextValue', text: value, field: { name } };
          }),
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      });
      const valueAfter = (args, flag) => args[args.indexOf(flag) + 1];
      const gh = async (args) => {
        const query = args.find((arg) => String(arg).startsWith('query=')) ?? '';
        if (query) queries.push(query.slice('query='.length));
        if (query.includes('mutation TodoistProjectFields')) {
          const data = {};
          const operationPattern = /field(\d+):(updateProjectV2ItemFieldValue|clearProjectV2ItemFieldValue)\(input:\{projectId:("[^"]+"),itemId:("[^"]+"),fieldId:("[^"]+")(?:,value:\{(singleSelectOptionId|date|text):("(?:\\.|[^"])*")\})?\}\)/g;
          for (const match of query.matchAll(operationPattern)) {
            const [, index, operation, , itemIdJson, fieldIdJson, valueType, valueJson] = match;
            const projectItem = items.find((entry) => entry.id === JSON.parse(itemIdJson));
            const field = byFieldId.get(JSON.parse(fieldIdJson));
            let value = '';
            if (operation !== 'clearProjectV2ItemFieldValue') {
              const parsedValue = JSON.parse(valueJson);
              value = valueType === 'singleSelectOptionId'
                ? byOptionId.get(parsedValue).value
                : parsedValue;
            }
            projectItem.fields[field.name] = value;
            writes.push(`project:${field.name}`);
            data[`field${index}`] = { projectV2Item: { id: projectItem.id } };
          }
          return JSON.stringify({ data });
        }
        if (query.includes('repositoryOwner')) {
          return JSON.stringify({ data: { repositoryOwner: { __typename: 'User' } } });
        }
        if (query.includes('fields(first:50')) {
          return JSON.stringify({
            data: {
              user: {
                projectV2: {
                  id: 'project-1',
                  fields: { nodes: fields, pageInfo: { hasNextPage: false, endCursor: null } },
                },
              },
            },
          });
        }
        if (query.includes('items(first:100')) {
          let nodes = items.map((entry) => node(entry));
          if (projectReadNodes) {
            nodes = projectReadNodes(nodes, projectReadCount);
          }
          projectReadCount += 1;
          return JSON.stringify({
            data: {
              user: {
                projectV2: {
                  items: { nodes, pageInfo: { hasNextPage: false, endCursor: null } },
                },
              },
            },
          });
        }
        if (query.includes('issues(last:1')) {
          return JSON.stringify({
            data: {
              repository: {
                issues: { totalCount: issues.length },
              },
            },
          });
        }
        if (query.includes('issues(first:100')) {
          return JSON.stringify({
            data: {
              repository: {
                issues: {
                  nodes: issues.map((entry) => ({ ...entry })),
                  pageInfo: { hasNextPage: false, endCursor: null },
                  totalCount: issues.length,
                },
              },
            },
          });
        }
        if (query.includes('search(query:$searchQuery')) {
          const searchQuery = args.find((arg) => String(arg).startsWith('searchQuery='))
            ?.slice('searchQuery='.length);
          const markerMatch = String(searchQuery).match(/"Pan: Todoist source task ([^"]+)"/);
          const sourceId = markerMatch?.[1];
          return JSON.stringify({
            data: {
              search: {
                nodes: issues
                  .filter((entry) =>
                    sourceId
                    && entry.body.includes(`Pan: Todoist source task ${sourceId}`))
                  .map((entry) => ({
                    ...entry,
                    repository: { nameWithOwner: 'example/domain' },
                  })),
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          });
        }
        if (query.includes('projectItems(first:100')) {
          const numberArg = args.find((arg) => String(arg).startsWith('number='));
          const targetIssue = issues.find(
            (entry) => entry.number === Number(String(numberArg).slice('number='.length)),
          );
          return JSON.stringify({
            data: {
              repository: {
                issue: targetIssue ? {
                  ...targetIssue,
                  projectItems: {
                    nodes: items
                      .filter((entry) => entry.issue.url === targetIssue.url)
                      .map((entry) => node(entry)),
                    pageInfo: { hasNextPage: false, endCursor: null },
                  },
                } : null,
              },
            },
          });
        }
        if (query.includes('node(id:$id)')) {
          const itemId = args.find((arg) => String(arg).startsWith('id='))?.slice('id='.length);
          const target = items.find((entry) => entry.id === itemId);
          return JSON.stringify({ data: { node: target ? node(target) : null } });
        }
        if (
          args[0] === 'api'
          && args[1] === 'repos/example/domain/issues'
          && !args.includes('graphql')
        ) {
          const number = Math.max(0, ...issues.map((entry) => entry.number)) + 1;
          const title = args.find((arg) => String(arg).startsWith('title='))?.slice('title='.length);
          const body = args.find((arg) => String(arg).startsWith('body='))?.slice('body='.length);
          const created = {
            number,
            title,
            body,
            html_url: `https://github.com/example/domain/issues/${number}`,
            url: `https://github.com/example/domain/issues/${number}`,
            state: 'OPEN',
            stateReason: null,
            createdAt: '2026-09-09T12:00:00Z',
            updatedAt: '2026-09-09T12:00:00Z',
            closedAt: null,
          };
          issues.push(created);
          commentsByIssue.set(number, []);
          writes.push('issue:create');
          return JSON.stringify({
            ...created,
            state: 'open',
            state_reason: null,
            created_at: created.createdAt,
            updated_at: created.updatedAt,
            closed_at: null,
          });
        }
        if (args[0] === 'project' && args[1] === 'item-add') {
          const url = valueAfter(args, '--url');
          const existing = items.find((entry) => entry.issue.url === url);
          if (existing) return JSON.stringify({ id: existing.id });
          const targetIssue = issues.find((entry) => entry.url === url);
          const projectItem = {
            id: `item-${targetIssue.number}`,
            updatedAt: '2026-09-09T12:00:00Z',
            issue: targetIssue,
            fields: {},
          };
          items.push(projectItem);
          writes.push('project:add');
          return JSON.stringify({ id: projectItem.id });
        }
        if (query.includes('comments(first:100')) {
          const numberArg = args.find((arg) => String(arg).startsWith('number='));
          const issueComments = commentsByIssue.get(Number(String(numberArg).slice('number='.length))) ?? [];
          return JSON.stringify({
            data: {
              repository: {
                issue: {
                  comments: {
                    nodes: issueComments.map((comment) => ({ ...comment })),
                    pageInfo: { hasNextPage: false, endCursor: null },
                  },
                },
              },
            },
          });
        }
        if (args[0] === 'project' && args[1] === 'item-edit') {
          const field = byFieldId.get(valueAfter(args, '--field-id'));
          const projectItem = items.find((entry) => entry.id === valueAfter(args, '--id')) ?? item;
          let value = '';
          if (args.includes('--single-select-option-id')) {
            value = byOptionId.get(valueAfter(args, '--single-select-option-id')).value;
          } else if (args.includes('--text')) value = valueAfter(args, '--text');
          else if (args.includes('--date')) value = valueAfter(args, '--date');
          projectItem.fields[field.name] = value;
          writes.push(`project:${field.name}`);
          return '';
        }
        if (args[0] === 'issue' && args[1] === 'edit') {
          const targetIssue = issues.find((entry) => entry.number === Number(args[2])) ?? issue;
          if (args.includes('--title')) targetIssue.title = valueAfter(args, '--title');
          if (args.includes('--body')) targetIssue.body = valueAfter(args, '--body');
          writes.push('issue:edit');
          return '';
        }
        if (args[0] === 'issue' && args[1] === 'view') {
          const targetIssue = issues.find((entry) => entry.number === Number(args[2])) ?? issue;
          if (valueAfter(args, '--json') === 'body') {
            return JSON.stringify({ body: targetIssue.body });
          }
          return JSON.stringify({ state: targetIssue.state, stateReason: targetIssue.stateReason });
        }
        if (args[0] === 'issue' && args[1] === 'close') {
          const targetIssue = issues.find((entry) => entry.number === Number(args[2])) ?? issue;
          targetIssue.state = 'CLOSED';
          targetIssue.stateReason = valueAfter(args, '--reason') === 'not planned'
            ? 'NOT_PLANNED'
            : 'COMPLETED';
          writes.push('issue:close');
          return '';
        }
        if (args[0] === 'issue' && args[1] === 'comment') {
          const issueNumber = Number(args[2]);
          const issueComments = commentsByIssue.get(issueNumber) ?? [];
          const targetIssue = issues.find((entry) => entry.number === issueNumber) ?? issue;
          issueComments.push({
            id: `comment-${issueNumber}-${issueComments.length + 1}`,
            author: { login: 'pan' },
            createdAt: '2026-09-09T00:00:00Z',
            updatedAt: '2026-09-09T00:00:00Z',
            url: `${targetIssue.url}#issuecomment-${issueComments.length + 1}`,
            body: valueAfter(args, '--body'),
          });
          commentsByIssue.set(issueNumber, issueComments);
          writes.push('issue:comment');
          return '';
        }
        if (args[0] === 'api' && args.includes('--paginate')) {
          const match = String(args.at(-1)).match(/\/issues\/(\d+)\/comments/);
          const issueComments = commentsByIssue.get(Number(match?.[1])) ?? [];
          return JSON.stringify([issueComments.map((comment) => ({ body: comment.body }))]);
        }
        if (args[0] === 'api' && args.includes('-X') && args.includes('PATCH')) {
          const endpoint = args.find((arg) => String(arg).includes('/issues/comments/'));
          const id = endpoint.split('/').at(-1);
          const target = [...commentsByIssue.values()]
            .flat()
            .find((comment) => comment.id === id);
          target.body = valueAfter(args, '-f').replace(/^body=/, '');
          writes.push('comment:edit');
          return '{}';
        }
        throw new Error(`unexpected fake gh call: ${args.join(' ')}`);
      };
      return {
        fields,
        issue,
        item,
        issues,
        items,
        comments,
        commentsByIssue,
        writes,
        queries,
        gh,
      };
    }

async function fakeStore(state = fakeGitHubState()) {
      const store = await new GitHubTaskStore({
        project: { owner: 'example', number: 1 },
        domain: { owner: 'example', name: 'domain', slug: 'example/domain' },
        allowedRepos: new Set(['example/domain']),
      }, {
        gh: state.gh,
        now: () => new Date('2026-09-09T12:00:00.000Z'),
      }).initialize();
      return { store, state };
    }

test('task-store projection preserves Issue state and state reason from Project GraphQL', async () => {
      const { store, state } = await fakeStore();
      let task = (await store.list()).tasks[0];
      assert.equal(task.issueState, 'OPEN');
      assert.equal(task.issueStateReason, null);
      const itemQuery = state.queries.find((query) => query.includes('items(first:100'));
      assert.match(itemQuery, /\.\.\. on Issue\s*\{[^}]*\bstate\b[^}]*\bstateReason\b/);

      state.issue.state = 'CLOSED';
      state.issue.stateReason = 'NOT_PLANNED';
      state.issue.closedAt = '2026-09-09T00:00:00Z';
      task = (await store.list()).tasks[0];
      assert.equal(task.issueState, 'CLOSED');
      assert.equal(task.issueStateReason, 'NOT_PLANNED');
});

test('Todoist repair reconciles exact Issue, comments, fields, and writes revision last', async () => {
      const { store, state } = await fakeStore();
      state.item.fields['resource-semantics'] = 'historical-provenance';
      const record = {
        sourceId: 'todo-1',
        title: 'Current title',
        body: 'Source URL: https://todoist.com/showTask?id=todo-1\n\n## Imported active description\n\nCurrent content.',
        comments: [{ id: 'c1', content: 'Current comment.', postedAt: '2026-09-08T00:00:00Z' }],
        priority: 'urgent',
        nextActionDate: '2026-09-12',
        deadline: '2026-09-15',
        workstream: '',
        recurrence: null,
      };

      const result = await store.importTodoistTask(record);

      assert.equal(result.outcome, 'repaired');
      assert.equal(state.issue.title, record.title);
      assert.match(state.issue.body, /^Pan: Todoist source task todo-1/);
      assert.match(state.issue.body, /Current content\./);
      assert.equal(state.item.fields.priority, 'urgent');
      assert.equal(state.item.fields['next-action-date'], '2026-09-12');
      assert.equal(state.item.fields.deadline, '2026-09-15');
      assert.equal(state.item.fields['resource-semantics'], '');
      assert.equal(state.item.fields['task-revision'], '2');
      assert.equal(state.comments[0].body, 'Pan: Todoist source comment c1\n\nImported 2026-09-08T00:00:00Z:\n\nCurrent comment.');
      assert.equal(state.writes.at(-1), 'project:task-revision');
      assert.equal((await store.verifyTodoistTask(record)).outcome, 'verified');
      const writesAfterRepair = state.writes.length;
      assert.equal((await store.importTodoistTask(record)).outcome, 'verified');
      assert.equal(state.writes.length, writesAfterRepair);
});

test('Todoist apply repairs 215 interrupted items with bounded full-list reads and exact reruns', async () => {
      const taskCount = 215;
      const snapshot = {
        format: 'pan-todoist-active-snapshot',
        version: 1,
        capturedAt: '2026-09-09T00:00:00Z',
        user: { id: 'me' },
        projects: [],
        sections: [],
        labels: [],
        excluded: [],
        tasks: Array.from({ length: taskCount }, (_, index) => ({
          id: `bulk-${index + 1}`,
          content: `Bulk task ${index + 1}`,
          description: `Imported description ${index + 1}.`,
          priority: 2,
          comments: [],
        })),
      };
      const records = todoistImportRecords(snapshot);
      const state = fakeGitHubState();
      state.issues.length = 0;
      state.items.length = 0;
      state.commentsByIssue.clear();
      for (const [index, record] of records.entries()) {
        const number = index + 1;
        const url = `https://github.com/example/domain/issues/${number}`;
        const importedBody = `Pan: Todoist source task ${record.sourceId}\n\n${record.body}`;
        const issue = {
          number,
          title: record.title,
          body: upsertCurrentActionBlock(importedBody, renderCurrentActionBlock({
            status: 'ready-for-human',
            action: 'act',
            detail: 'Perform or reconsider the imported active task.',
            revision: 1,
            updatedAt: '2026-09-09T00:00:00.000Z',
          })),
          html_url: url,
          url,
          state: 'OPEN',
          stateReason: null,
          createdAt: '2026-09-09T00:00:00Z',
          updatedAt: '2026-09-09T00:00:00Z',
          closedAt: null,
        };
        state.issues.push(issue);
        state.items.push({
          id: `item-${number}`,
          updatedAt: '2026-09-09T00:00:00Z',
          issue,
          fields: {},
        });
        state.commentsByIssue.set(number, []);
      }

      const statusField = state.fields.find((field) => field.name === 'Status');
      const liveGh = state.gh;
      let injectedFailure = false;
      state.gh = async (args) => {
        const query = args.find((arg) => String(arg).startsWith('query=')) ?? '';
        if (
          !injectedFailure
          && query.includes('mutation TodoistProjectFields')
          && query.includes('itemId:"item-108"')
          && query.includes(`fieldId:"${statusField.id}"`)
        ) {
          injectedFailure = true;
          throw new Error('injected independent field failure');
        }
        return liveGh(args);
      };

      const { store } = await fakeStore(state);
      const firstPlan = planTodoistImport(snapshot, await store.todoistSourceIndex());
      const firstReport = await applyTodoistImport(firstPlan, store, snapshot);
      assert.equal(firstReport.partial, true);
      assert.equal(
        firstReport.results.filter((result) => result.outcome === 'repaired').length,
        taskCount - 1,
      );
      assert.match(
        firstReport.results.find((result) => result.sourceId === 'bulk-108').error,
        /injected independent field failure/,
      );

      state.gh = liveGh;
      const { store: resumedStore } = await fakeStore(state);
      const resumedPlan = planTodoistImport(
        snapshot,
        await resumedStore.todoistSourceIndex(),
      );
      const resumedReport = await applyTodoistImport(resumedPlan, resumedStore, snapshot);
      assert.equal(resumedReport.partial, false);
      assert.equal(
        resumedReport.results.filter((result) => result.outcome === 'repaired').length,
        1,
      );
      assert.equal(
        resumedReport.results.filter((result) => result.outcome === 'verified').length,
        taskCount - 1,
      );

      const verification = await verifyTodoistImport(snapshot, resumedStore);
      assert.equal(verification.complete, true);
      assert.equal(verification.results.length, taskCount);
      assert.equal(
        state.issues.flatMap((issue) =>
          issue.body.match(/^Pan: Todoist source task [^\r\n]+$/gm) ?? []).length,
        taskCount,
      );
      assert.equal(new Set(state.issues.map((issue) => issue.url)).size, taskCount);
      assert.equal(new Set(state.items.map((item) => item.issue.url)).size, taskCount);
      assert.equal(
        state.queries.filter((query) => query.includes('issues(first:100')).length,
        2,
      );
      assert.equal(
        state.queries.filter((query) => query.includes('items(first:100')).length,
        2,
      );
      assert.ok(
        state.queries.filter((query) => query.includes('search(query:$searchQuery')).length
          <= taskCount * 5,
      );
      for (const item of state.items) {
        assert.equal(item.fields['resource-semantics'] || '', '');
        const transition = (state.commentsByIssue.get(item.issue.number) ?? []).find(
          (comment) => comment.body.startsWith('Pan: task transition 1'),
        );
        assert.equal(
          transition?.body,
          transitionComment({
            revision: 1,
            fromStatus: '',
            fromAction: '',
            toStatus: 'ready-for-human',
            toAction: 'act',
            detail: 'Perform or reconsider the imported active task.',
            actor: 'Pan Todoist migration',
          }),
        );
      }
});

test('Todoist create updates the run index and verifies without another full scan', async () => {
      const snapshot = {
        format: 'pan-todoist-active-snapshot',
        version: 1,
        capturedAt: '2026-09-09T00:00:00Z',
        user: { id: 'me' },
        projects: [],
        sections: [],
        labels: [],
        excluded: [],
        tasks: [{
          id: 'new-1',
          content: 'New imported task',
          description: 'Created during this run.',
          priority: 2,
          comments: [],
        }],
      };
      const state = fakeGitHubState();
      state.issues.length = 0;
      state.items.length = 0;
      state.commentsByIssue.clear();
      const { store } = await fakeStore(state);
      const plan = planTodoistImport(snapshot, await store.todoistSourceIndex());

      const report = await applyTodoistImport(plan, store, snapshot);
      const verification = await verifyTodoistImport(snapshot, store);

      assert.equal(report.partial, false, JSON.stringify(report));
      assert.equal(report.results[0].outcome, 'created');
      assert.equal(verification.complete, true);
      assert.equal(state.issues.length, 1);
      assert.equal(state.items.length, 1);
      assert.equal(
        state.queries.filter((query) => query.includes('issues(first:100')).length,
        1,
      );
      assert.equal(
        state.queries.filter((query) => query.includes('items(first:100')).length,
        1,
      );
});

test('Todoist create race fails closed when another source Issue appears', async () => {
      const snapshot = {
        format: 'pan-todoist-active-snapshot',
        version: 1,
        capturedAt: '2026-09-09T00:00:00Z',
        user: { id: 'me' },
        projects: [],
        sections: [],
        labels: [],
        excluded: [],
        tasks: [{
          id: 'race-1',
          content: 'Race-safe import',
          description: '',
          priority: 2,
          comments: [],
        }],
      };
      const state = fakeGitHubState();
      state.issues.length = 0;
      state.items.length = 0;
      state.commentsByIssue.clear();
      const liveGh = state.gh;
      let raced = false;
      state.gh = async (args) => {
        if (
          !raced
          && args[0] === 'api'
          && args[1] === 'repos/example/domain/issues'
          && !args.includes('graphql')
        ) {
          raced = true;
          const body = args.find((arg) => String(arg).startsWith('body='))?.slice('body='.length);
          state.issues.push({
            number: 1,
            title: 'Concurrent duplicate',
            body,
            html_url: 'https://github.com/example/domain/issues/1',
            url: 'https://github.com/example/domain/issues/1',
            state: 'OPEN',
            stateReason: null,
            createdAt: '2026-09-09T12:00:00Z',
            updatedAt: '2026-09-09T12:00:00Z',
            closedAt: null,
          });
          state.commentsByIssue.set(1, []);
        }
        return liveGh(args);
      };
      const { store } = await fakeStore(state);
      const plan = planTodoistImport(snapshot, await store.todoistSourceIndex());
      const checkpoints = [];

      const report = await applyTodoistImport(plan, store, snapshot, {
        onProgress(checkpoint) {
          checkpoints.push(checkpoint);
        },
      });

      assert.equal(report.partial, true);
      assert.match(report.results[0].error, /changed after the Todoist run snapshot/);
      assert.equal(report.results[0].createdByRun, true);
      assert.equal(report.results[0].createdIssueUrl, 'https://github.com/example/domain/issues/2');
      assert.match(report.results[0].recovery, /left intact/);
      assert.equal(checkpoints.at(-1).results[0].createdIssueUrl, report.results[0].createdIssueUrl);
      assert.equal(state.issues.length, 2);
      assert.equal(state.items.length, 0);
});

test('Todoist create rechecks marker uniqueness after a body-only race and writes nothing', async () => {
      const snapshot = {
        format: 'pan-todoist-active-snapshot',
        version: 1,
        capturedAt: '2026-09-09T00:00:00Z',
        user: { id: 'me' },
        projects: [],
        sections: [],
        labels: [],
        excluded: [],
        tasks: [{
          id: 'precreate-race',
          content: 'Pre-create race',
          description: '',
          priority: 2,
          comments: [],
        }],
      };
      const state = fakeGitHubState();
      const liveGh = state.gh;
      let sourceSearches = 0;
      state.gh = async (args) => {
        const query = args.find((arg) => String(arg).startsWith('query=')) ?? '';
        if (query.includes('search(query:$searchQuery')) {
          sourceSearches += 1;
          if (sourceSearches === 2) {
            state.issue.body += '\n\nPan: Todoist source task precreate-race';
          }
        }
        return liveGh(args);
      };
      const { store } = await fakeStore(state);
      const plan = planTodoistImport(snapshot, await store.todoistSourceIndex());

      const report = await applyTodoistImport(plan, store, snapshot);

      assert.equal(report.partial, true);
      assert.match(report.results[0].error, /changed after the run snapshot/);
      assert.equal(state.writes.includes('issue:create'), false);
      assert.equal(state.issues.length, 1);
});

test('Todoist verification globally detects a body-only duplicate marker race', async () => {
      const snapshot = {
        format: 'pan-todoist-active-snapshot',
        version: 1,
        capturedAt: '2026-09-09T00:00:00Z',
        user: { id: 'me' },
        projects: [],
        sections: [],
        labels: [],
        excluded: [],
        tasks: [{
          id: 'verify-race',
          content: 'Verify race',
          description: '',
          priority: 2,
          comments: [],
        }],
      };
      const state = fakeGitHubState();
      const { store } = await fakeStore(state);
      const plan = planTodoistImport(snapshot, await store.todoistSourceIndex());
      assert.equal((await applyTodoistImport(plan, store, snapshot)).partial, false);
      state.issue.body += '\n\nPan: Todoist source task verify-race';

      const report = await verifyTodoistImport(snapshot, store);

      assert.equal(report.complete, false);
      assert.equal(report.results[0].outcome, 'conflict');
      assert.match(report.results[0].error, /changed after the run snapshot/);
});

test('Todoist planning rejects a source marker outside its canonical body position', async () => {
      const state = fakeGitHubState();
      state.issue.body = 'Imported note.\n\nPan: Todoist source task todo-1';
      const { store } = await fakeStore(state);
      const index = await store.todoistSourceIndex();
      const snapshot = {
        format: 'pan-todoist-active-snapshot',
        version: 1,
        capturedAt: '2026-09-09T00:00:00Z',
        user: { id: 'me' },
        projects: [],
        sections: [],
        labels: [],
        excluded: [],
        tasks: [{
          id: 'todo-1',
          content: 'Existing import',
          description: '',
          priority: 2,
          comments: [],
        }],
      };

      const plan = planTodoistImport(snapshot, index);

      assert.equal(plan.actions[0].action, 'conflict');
      assert.match(plan.actions[0].reason, /non-canonical/);
});

test('Todoist repair completes an exact interrupted revision-last commit', async () => {
      const { store, state } = await fakeStore();
      const record = {
        sourceId: 'todo-1',
        title: 'Current title',
        body: 'Source URL: https://todoist.com/showTask?id=todo-1\n\n## Imported active description\n\nCurrent content.',
        comments: [{ id: 'c1', content: 'Current comment.', postedAt: '2026-09-08T00:00:00Z' }],
        priority: 'urgent',
        nextActionDate: '2026-09-12',
        deadline: '2026-09-15',
        workstream: '',
        recurrence: null,
      };
      await store.importTodoistTask(record);
      state.item.fields['task-revision'] = '1';
      state.writes.length = 0;
      const { store: resumedStore } = await fakeStore(state);

      const result = await resumedStore.importTodoistTask(record);

      assert.equal(result.outcome, 'repaired');
      assert.deepEqual(state.writes, ['project:task-revision']);
      assert.equal(state.item.fields['task-revision'], '2');
      assert.equal(parseCurrentActionBlock(state.issue.body).revision, 2);
});

test('Todoist revision-last recovery rejects independent priority drift without writes', async () => {
      const { store, state } = await fakeStore();
      const record = {
        sourceId: 'todo-1',
        title: 'Current title',
        body: 'Source URL: https://todoist.com/showTask?id=todo-1\n\n## Imported active description\n\nCurrent content.',
        comments: [{ id: 'c1', content: 'Current comment.', postedAt: '2026-09-08T00:00:00Z' }],
        priority: 'urgent',
        nextActionDate: '2026-09-12',
        deadline: '2026-09-15',
        workstream: '',
        recurrence: null,
      };
      await store.importTodoistTask(record);
      state.item.fields['task-revision'] = '1';
      state.item.fields.priority = 'low';
      state.writes.length = 0;
      const { store: resumedStore } = await fakeStore(state);

      await assert.rejects(
        resumedStore.importTodoistTask(record),
        /revision-last recovery.*non-revision projection drift/,
      );
      assert.equal(state.item.fields.priority, 'low');
      assert.equal(state.item.fields['task-revision'], '1');
      assert.deepEqual(state.writes, []);
});

test('Todoist revision-last recovery recreates a missing transition receipt before commit', async () => {
      const { store, state } = await fakeStore();
      const record = {
        sourceId: 'todo-1',
        title: 'Current title',
        body: 'Source URL: https://todoist.com/showTask?id=todo-1\n\n## Imported active description\n\nCurrent content.',
        comments: [{ id: 'c1', content: 'Current comment.', postedAt: '2026-09-08T00:00:00Z' }],
        priority: 'urgent',
        nextActionDate: '2026-09-12',
        deadline: '2026-09-15',
        workstream: '',
        recurrence: null,
      };
      await store.importTodoistTask(record);
      state.item.fields['task-revision'] = '1';
      const transitionIndex = state.comments.findIndex(
        (comment) => comment.body.startsWith('Pan: task transition 2'),
      );
      state.comments.splice(transitionIndex, 1);
      state.writes.length = 0;
      const { store: resumedStore } = await fakeStore(state);

      const result = await resumedStore.importTodoistTask(record);

      assert.equal(result.outcome, 'repaired');
      assert.deepEqual(state.writes, ['issue:comment', 'project:task-revision']);
      assert.equal(
        state.comments.filter((comment) => comment.body.startsWith('Pan: task transition 2')).length,
        1,
      );
});

test('Todoist import repairs an exact transition receipt payload and verifies it', async () => {
      const { store, state } = await fakeStore();
      const record = {
        sourceId: 'todo-1',
        title: 'Current title',
        body: 'Source URL: https://todoist.com/showTask?id=todo-1\n\n## Imported active description\n\nCurrent content.',
        comments: [{ id: 'c1', content: 'Current comment.', postedAt: '2026-09-08T00:00:00Z' }],
        priority: 'urgent',
        nextActionDate: '2026-09-12',
        deadline: '2026-09-15',
        workstream: '',
        recurrence: null,
      };
      await store.importTodoistTask(record);
      const transition = state.comments.find(
        (comment) => comment.body.startsWith('Pan: task transition 2'),
      );
      transition.body = transition.body.replace(
        '- Actor: Pan Todoist migration',
        '- Actor: Corrupted migration',
      );
      state.writes.length = 0;
      const { store: resumedStore } = await fakeStore(state);

      const result = await resumedStore.importTodoistTask(record);

      assert.equal(result.outcome, 'repaired');
      assert.deepEqual(state.writes, ['comment:edit']);
      assert.match(transition.body, /- Actor: Pan Todoist migration$/);
      assert.equal((await resumedStore.verifyTodoistTask(record)).outcome, 'verified');
});

test('Todoist import conflicts on a transition receipt whose historical metadata is unsafe', async () => {
      const { store, state } = await fakeStore();
      const record = {
        sourceId: 'todo-1',
        title: 'Current title',
        body: 'Source URL: https://todoist.com/showTask?id=todo-1\n\n## Imported active description\n\nCurrent content.',
        comments: [{ id: 'c1', content: 'Current comment.', postedAt: '2026-09-08T00:00:00Z' }],
        priority: 'urgent',
        nextActionDate: '2026-09-12',
        deadline: '2026-09-15',
        workstream: '',
        recurrence: null,
      };
      await store.importTodoistTask(record);
      const transition = state.comments.find(
        (comment) => comment.body.startsWith('Pan: task transition 2'),
      );
      transition.body = transition.body.replace(
        '- From: ready-for-human/act',
        '- From: corrupted',
      );
      state.writes.length = 0;
      const { store: resumedStore } = await fakeStore(state);

      await assert.rejects(
        resumedStore.importTodoistTask(record),
        /unsafe metadata/,
      );
      assert.deepEqual(state.writes, []);
      const verification = await resumedStore.verifyTodoistTask(record);
      assert.equal(verification.outcome, 'conflict');
      assert.match(verification.error, /mismatched lifecycle transition receipt/);
});

test('Todoist verification rejects a non-canonical source receipt', async () => {
      const { store, state } = await fakeStore();
      const record = {
        sourceId: 'todo-1',
        title: 'Current title',
        body: 'Source URL: https://todoist.com/showTask?id=todo-1\n\n## Imported active description\n\nCurrent content.',
        comments: [{ id: 'c1', content: 'Current comment.', postedAt: '2026-09-08T00:00:00Z' }],
        priority: 'urgent',
        nextActionDate: '2026-09-12',
        deadline: '2026-09-15',
        workstream: '',
        recurrence: null,
      };
      await store.importTodoistTask(record);
      state.comments.find(
        (comment) => comment.body.startsWith('Pan: Todoist source comment c1'),
      ).body = 'Imported receipt:\nPan: Todoist source comment c1';
      const { store: resumedStore } = await fakeStore(state);

      const verification = await resumedStore.verifyTodoistTask(record);

      assert.equal(verification.outcome, 'conflict');
      assert.match(verification.error, /non-canonical Todoist source comment/);
});

test('Todoist verification rejects inherited resource semantics', async () => {
      const { store, state } = await fakeStore();
      const record = {
        sourceId: 'todo-1',
        title: 'Current title',
        body: 'Source URL: https://todoist.com/showTask?id=todo-1\n\n## Imported active description\n\nCurrent content.',
        comments: [{ id: 'c1', content: 'Current comment.', postedAt: '2026-09-08T00:00:00Z' }],
        priority: 'urgent',
        nextActionDate: '2026-09-12',
        deadline: '2026-09-15',
        workstream: '',
        recurrence: null,
      };
      await store.importTodoistTask(record);
      state.item.fields['resource-semantics'] = 'held-affinity';
      const { store: resumedStore } = await fakeStore(state);

      const verification = await resumedStore.verifyTodoistTask(record);

      assert.equal(verification.outcome, 'conflict');
      assert.match(verification.error, /lifecycle projection/);
});

function recurrenceRevisionRecoveryState() {
      const state = fakeGitHubState();
      const currentBody = recurring('2026-09-04', 'Every Friday.');
      state.issue.body = upsertCurrentActionBlock(currentBody, renderCurrentActionBlock({
        status: 'ready-for-human',
        action: 'act',
        detail: 'Perform this occurrence.',
        revision: 1,
        updatedAt: '2026-09-01T00:00:00.000Z',
      }));
      state.item.fields.Status = 'ready-for-human';
      state.item.fields['next-action'] = 'act';
      state.item.fields['next-action-date'] = '2026-09-04';
      const successor = {
        number: 2,
        title: state.issue.title,
        body: upsertCurrentActionBlock([
          'Pan: recurrence occurrence 2026-09-11',
          `Pan: previous occurrence ${state.issue.url}`,
          '',
          '# Outcome',
          '',
          'Keep the recurring commitment.',
          '',
          '## Recurrence',
          '',
          'Every Friday.',
        ].join('\n'), renderCurrentActionBlock({
          status: 'ready-for-human',
          action: 'act',
          detail: 'Perform the recurrence occurrence scheduled for 2026-09-11.',
          revision: 2,
          updatedAt: '2026-09-09T12:00:00.000Z',
        })),
        url: 'https://github.com/example/domain/issues/2',
        state: 'OPEN',
        stateReason: null,
        createdAt: '2026-09-09T12:00:00.000Z',
        updatedAt: '2026-09-09T12:00:00.000Z',
        closedAt: null,
      };
      const successorItem = {
        id: 'item-2',
        updatedAt: '2026-09-09T12:00:00.000Z',
        issue: successor,
        fields: {
          ...state.item.fields,
          Status: 'ready-for-human',
          'next-action': 'act',
          'execution-authorized': 'no',
          'worker-state': 'idle',
          'next-action-date': '2026-09-11',
          playbook: '',
          dependencies: '',
          'task-revision': '1',
        },
      };
      state.issues.push(successor);
      state.items.push(successorItem);
      state.commentsByIssue.set(2, [{
        id: 'transition-2',
        author: { login: 'pan' },
        createdAt: '2026-09-09T12:00:00.000Z',
        updatedAt: '2026-09-09T12:00:00.000Z',
        url: `${successor.url}#issuecomment-transition-2`,
        body: transitionComment({
          revision: 2,
          fromStatus: 'ready-for-human',
          fromAction: 'act',
          toStatus: 'ready-for-human',
          toAction: 'act',
          detail: 'Perform the recurrence occurrence scheduled for 2026-09-11.',
          actor: 'Pan recurrence rollover',
        }),
      }]);
      return { state, successor, successorItem };
}

test('recurrence repair completes an exact interrupted revision-last commit', async () => {
      const { state, successor, successorItem } = recurrenceRevisionRecoveryState();
      const { store } = await fakeStore(state);
      const detail = await store.detail('item-1');

      await store.mutate({
        itemId: detail.itemId,
        revision: detail.revision,
        projection: detail.projection,
        operation: 'finish',
        detail: 'Occurrence complete.',
      });

      assert.equal(successorItem.fields['task-revision'], '2');
      assert.equal(parseCurrentActionBlock(successor.body).revision, 2);
});

test('recurrence revision-last recovery rejects independent priority drift', async () => {
      const { state, successorItem } = recurrenceRevisionRecoveryState();
      successorItem.fields.priority = 'urgent';
      const { store } = await fakeStore(state);
      const detail = await store.detail('item-1');
      state.writes.length = 0;

      await assert.rejects(
        store.mutate({
          itemId: detail.itemId,
          revision: detail.revision,
          projection: detail.projection,
          operation: 'finish',
          detail: 'Occurrence complete.',
        }),
        /revision-last recovery.*non-revision projection drift/,
      );

      assert.equal(successorItem.fields.priority, 'urgent');
      assert.equal(successorItem.fields['task-revision'], '1');
      assert.deepEqual(state.writes, []);
});

test('recurrence revision repair fails unless the Project revision is reread exactly', async () => {
      const { state, successor, successorItem } = recurrenceRevisionRecoveryState();
      const revisionFieldId = state.fields.find((field) => field.name === 'task-revision').id;
      const gh = state.gh;
      state.gh = async (args) => {
        if (
          args[0] === 'project'
          && args[1] === 'item-edit'
          && args.includes(revisionFieldId)
          && args.includes('item-2')
        ) {
          state.writes.push('project:task-revision-ignored');
          return '';
        }
        return gh(args);
      };
      const { store } = await fakeStore(state);
      const detail = await store.detail('item-1');

      await assert.rejects(
        store.mutate({
          itemId: detail.itemId,
          revision: detail.revision,
          projection: detail.projection,
          operation: 'finish',
          detail: 'Occurrence complete.',
        }),
        /did not verify recurring successor revision repair/,
      );

      assert.equal(parseCurrentActionBlock(successor.body).revision, 2);
      assert.equal(successorItem.fields['task-revision'], '1');
});

test('Todoist import fails closed on duplicate source comment markers', async () => {
      const state = fakeGitHubState();
      state.comments.push({ ...state.comments[0], id: 'comment-duplicate' });
      const { store } = await fakeStore(state);
      await assert.rejects(
        store.importTodoistTask({
          sourceId: 'todo-1',
          title: 'Title',
          body: 'Body',
          comments: [{ id: 'c1', content: 'Comment', postedAt: null }],
          priority: 'normal',
          nextActionDate: '',
          deadline: '',
          recurrence: null,
        }),
        /duplicate comment marker/,
      );
});

test('task mutation requires an exact Issue and Project projection before writes', async () => {
      const { store, state } = await fakeStore();
      const detail = await store.detail('item-1');
      state.issue.title = 'Changed elsewhere';
      const before = state.writes.length;
      await assert.rejects(
        store.mutate({
          itemId: 'item-1',
          revision: detail.revision,
          projection: detail.projection,
          operation: 'hold',
          detail: 'Pause intentionally.',
        }),
        /stale task projection/,
      );
      assert.equal(state.writes.length, before);
      await assert.rejects(store.detail('foreign-item'), /task not found/);
});

test('terminal lifecycle migration closes the Issue and preserves historical provenance', async () => {
      const state = fakeGitHubState();
      state.issue.state = 'CLOSED';
      state.issue.stateReason = 'COMPLETED';
      state.item.fields.Status = 'done';
      state.item.fields['next-action'] = '';
      state.item.fields['next-action-date'] = '2026-09-01';
      state.item.fields['worker-state'] = '';
      state.item.fields.machine = 'machine-a';
      state.item.fields['session-id'] = 'session-a';
      state.item.fields['claim-generation'] = '';
      state.item.fields['task-revision'] = '';
      const { store } = await fakeStore(state);
      const task = (await store.list()).tasks[0];
      const plan = planLifecycleMigration([task]);
      assert.equal(plan.actions[0].action, 'migrate');

      const result = await store.migrateLegacyItem(plan.actions[0]);

      assert.equal(result.outcome, 'migrated');
      assert.equal(state.issue.state, 'CLOSED');
      assert.equal(state.issue.stateReason, 'COMPLETED');
      assert.equal(state.item.fields['next-action-date'], '');
      assert.equal(state.item.fields['worker-state'], 'stopped');
      assert.equal(state.item.fields.machine, 'machine-a');
      assert.equal(state.item.fields['session-id'], 'session-a');
      assert.equal(state.item.fields['claim-generation'], '');
      assert.equal(state.item.fields['resource-semantics'], 'historical-provenance');
      assert.equal(state.writes.at(-1), 'project:task-revision');

      const converged = planLifecycleMigration((await store.list()).tasks);
      assert.equal(converged.actions[0].action, 'already-current');
      const before = state.writes.length;
      const reapplied = await applyLifecycleMigration(converged, store);
      assert.equal(reapplied.partial, false);
      assert.equal(state.writes.length, before);
});

test('verified legacy checkpoint and deliberate hold migrations clear only stale claims and converge', async () => {
      const cases = [
        {
          classification: 'verifiedHumanCheckpoint',
          configure(state) {
            state.item.fields.Status = 'paused';
            state.item.fields.owner = 'agent';
            state.item.fields['worker-state'] = '';
            state.item.fields['claimed-by'] = 'old-runner';
            state.item.fields['lease-until'] = '2026-09-09T08:00:00.000Z';
            state.item.fields['needs-human-since'] = '2026-09-09T07:30:00.000Z';
            state.item.fields.machine = 'machine-a';
            state.item.fields['session-id'] = 'session-a';
            state.item.fields['claim-generation'] = '';
          },
          expected: {
            status: 'ready-for-human',
            action: 'approve',
            workerState: 'checkpointed',
          },
        },
        {
          classification: 'verifiedDeliberateHold',
          configure(state) {
            state.item.fields.Status = 'blocked';
            state.item.fields.owner = 'agent';
            state.item.fields['worker-state'] = '';
            state.item.fields['claimed-by'] = '';
            state.item.fields['lease-until'] = '';
            state.item.fields['needs-human-since'] = '2026-09-09T07:30:00.000Z';
            state.item.fields.machine = 'machine-a';
            state.item.fields['session-id'] = 'session-a';
            state.item.fields['claim-generation'] = '';
          },
          expected: {
            status: 'deliberate-hold',
            action: 'hold',
            workerState: 'checkpointed',
          },
        },
      ];

      for (const entry of cases) {
        const state = fakeGitHubState();
        entry.configure(state);
        const { store } = await fakeStore(state);
        const task = (await store.list()).tasks[0];
        const authorization = verifiedCutover(task, entry.classification);
        const plan = planLifecycleMigration([task], {
          now: Date.parse('2026-09-09T12:00:00.000Z'),
          authorizations: [authorization],
        });
        assert.equal(plan.actions[0].action, 'migrate', entry.classification);
        assert.equal(plan.actions[0].cutoverClassification, entry.classification);
        assert.equal(plan.actions[0].cutoverAuthorization.detail, authorization.detail);
        assert.equal(plan.actions[0].cutoverAuthorization.projection, authorization.projection);
        assert.equal(plan.actions[0].expected.projection, authorization.projection);

        const report = await applyLifecycleMigration(plan, store);
        assert.equal(report.partial, false, entry.classification);
        assert.equal(report.results[0].cutoverClassification, entry.classification);
        assert.equal(state.item.fields.Status, entry.expected.status);
        assert.equal(state.item.fields['next-action'], entry.expected.action);
        assert.equal(state.item.fields['worker-state'], entry.expected.workerState);
        assert.equal(state.item.fields['execution-authorized'], 'no');
        assert.equal(state.item.fields['claimed-by'], '');
        assert.equal(state.item.fields['lease-until'], '');
        assert.equal(state.item.fields['needs-human-since'], '2026-09-09T07:30:00.000Z');
        assert.equal(state.item.fields.machine, 'machine-a');
        assert.equal(state.item.fields['session-id'], 'session-a');
        assert.equal(state.item.fields['claim-generation'], '');
        assert.equal(state.item.fields['resource-semantics'], 'held-affinity');
        assert.equal(state.issue.state, 'OPEN');
        assert.equal(parseCurrentActionBlock(state.issue.body).detail, authorization.detail);

        const converged = planLifecycleMigration((await store.list()).tasks, {
          authorizations: [authorization],
        });
        assert.equal(converged.actions[0].action, 'already-current');
        const before = state.writes.length;
        const reapplied = await applyLifecycleMigration(converged, store);
        assert.equal(reapplied.partial, false);
        assert.equal(state.writes.length, before);
      }
});

test('lifecycle plan and apply use one canonical projection across production-shaped independent reads', async () => {
      const state = fakeGitHubState({
        projectReadNodes(nodes, readIndex) {
          const shaped = structuredClone(nodes);
          for (const node of shaped) {
            node.fieldValues.nodes.reverse();
            const present = new Set(node.fieldValues.nodes.map((value) => value.field?.name));
            if (readIndex % 2 === 0) {
              for (const field of CANONICAL_FIELDS) {
                if (present.has(field.name)) continue;
                if (field.type === 'single-select') {
                  node.fieldValues.nodes.push({
                    __typename: 'ProjectV2ItemFieldSingleSelectValue',
                    name: '',
                    field: { name: field.name },
                  });
                } else if (field.type === 'date') {
                  node.fieldValues.nodes.push({
                    __typename: 'ProjectV2ItemFieldDateValue',
                    date: '',
                    field: { name: field.name },
                  });
                } else {
                  node.fieldValues.nodes.push({
                    __typename: 'ProjectV2ItemFieldTextValue',
                    text: '',
                    field: { name: field.name },
                  });
                }
              }
              node.content.stateReason ??= null;
              node.content.closedAt ??= null;
              if (node.content.body === '') node.content.body = null;
            } else {
              node.fieldValues.nodes = node.fieldValues.nodes.filter((value) =>
                value.text !== '' && value.name !== '' && value.date !== '');
              if (node.content.stateReason == null) delete node.content.stateReason;
              if (node.content.closedAt == null) delete node.content.closedAt;
              if (node.content.body == null) delete node.content.body;
            }
          }
          return readIndex % 2 === 0 ? shaped : shaped.reverse();
        },
      });
      const cases = [
        { name: 'untriaged-unassigned', status: 'untriaged', owner: 'unassigned', body: '' },
        { name: 'untriaged-human', status: 'untriaged', owner: 'human', body: '' },
        { name: 'needs-detail-human', status: 'needs-detail', owner: 'human' },
        { name: 'needs-detail-agent', status: 'needs-detail', owner: 'agent' },
        { name: 'ready-human', status: 'ready', owner: 'human' },
        { name: 'ready-agent', status: 'ready', owner: 'agent', authorization: 'execute' },
        { name: 'ready-unassigned', status: 'ready', owner: 'unassigned' },
        { name: 'paused-human', status: 'paused', owner: 'human' },
        { name: 'paused-unassigned', status: 'paused', owner: 'unassigned' },
        { name: 'in-progress-human', status: 'in-progress', owner: 'human' },
        { name: 'in-review-human', status: 'in-review', owner: 'human' },
        { name: 'in-review-agent', status: 'in-review', owner: 'agent' },
        { name: 'blocked-human', status: 'blocked', owner: 'human' },
        { name: 'blocked-unassigned', status: 'blocked', owner: 'unassigned' },
        { name: 'done', status: 'done', owner: 'human', terminal: 'COMPLETED' },
        { name: 'rejected', status: 'rejected', owner: 'human', terminal: 'NOT_PLANNED' },
        {
          name: 'done-terminal-provenance',
          status: 'done',
          owner: 'agent',
          terminal: 'COMPLETED',
          provenance: true,
        },
        {
          name: 'rejected-terminal-provenance',
          status: 'rejected',
          owner: 'agent',
          terminal: 'NOT_PLANNED',
          provenance: true,
        },
        { name: 'verified-checkpoint-stale-claim', status: 'paused', owner: 'agent', cutover: 'verifiedHumanCheckpoint', staleClaim: true },
        { name: 'verified-checkpoint', status: 'paused', owner: 'agent', cutover: 'verifiedHumanCheckpoint' },
        { name: 'verified-hold-stale-claim', status: 'blocked', owner: 'agent', cutover: 'verifiedDeliberateHold', staleClaim: true },
        { name: 'verified-hold', status: 'blocked', owner: 'agent', cutover: 'verifiedDeliberateHold' },
        { name: 'durable-hold', status: 'blocked', owner: 'human', durableHold: true },
      ];
      const configure = (item, issue, entry, index) => {
        item.id = `item-${index + 1}`;
        item.updatedAt = `2026-09-${String((index % 8) + 1).padStart(2, '0')}T00:00:00Z`;
        issue.number = index + 1;
        issue.title = entry.name;
        issue.url = `https://github.com/example/domain/issues/${index + 1}`;
        issue.html_url = issue.url;
        issue.body = Object.hasOwn(entry, 'body') ? entry.body : `Legacy outcome ${entry.name}.`;
        issue.state = entry.terminal ? 'CLOSED' : 'OPEN';
        issue.stateReason = entry.terminal ?? null;
        issue.closedAt = entry.terminal ? '2026-09-09T00:00:00Z' : null;
        item.fields = {
          Status: entry.status,
          'next-action': '',
          owner: entry.owner,
          priority: index % 2 ? 'normal' : 'high',
          'next-action-date': entry.terminal ? '2026-09-01' : '',
          deadline: index % 3 ? '' : '2026-09-30',
          playbook: entry.authorization === 'execute' ? 'tool-development' : '',
          workstream: index % 4 ? '' : 'product',
          'execution-authorized': '',
          dependencies: '',
          'worker-state': '',
          'needs-human-since': '',
          'claimed-by': '',
          'lease-until': '',
          machine: '',
          'session-id': '',
          'claim-generation': '',
          'resource-semantics': '',
          'task-revision': '',
        };
        if (entry.provenance) {
          item.fields.machine = `machine-${index}`;
          item.fields['session-id'] = `session-${index}`;
        }
        if (entry.cutover) {
          item.fields['needs-human-since'] = '2026-09-09T07:30:00.000Z';
          item.fields.machine = `machine-${index}`;
          item.fields['session-id'] = `session-${index}`;
          if (entry.staleClaim) {
            item.fields['claimed-by'] = 'old-runner';
            item.fields['lease-until'] = '2026-09-09T08:00:00.000Z';
          }
        }
        if (entry.durableHold) {
          issue.body = renderCurrentActionBlock({
            status: 'deliberate-hold',
            action: 'hold',
            detail: 'Keep this outcome deliberately paused.',
            revision: 1,
            updatedAt: '2026-09-09T01:00:00.000Z',
          });
          item.fields['worker-state'] = 'checkpointed';
          item.fields.machine = `machine-${index}`;
          item.fields['session-id'] = `session-${index}`;
          item.fields['claim-generation'] = `generation-${index}`;
          item.fields['task-revision'] = '1';
        }
      };
      configure(state.item, state.issue, cases[0], 0);
      for (let index = 1; index < cases.length; index += 1) {
        const issue = structuredClone(state.issue);
        const item = {
          id: '',
          updatedAt: '',
          issue,
          fields: {},
        };
        configure(item, issue, cases[index], index);
        state.issues.push(issue);
        state.items.push(item);
        state.commentsByIssue.set(issue.number, []);
      }
      const { store } = await fakeStore(state);
      const tasks = (await store.list()).tasks;
      const byId = new Map(tasks.map((task) => [task.itemId, task]));
      const authorizations = [];
      for (const [index, entry] of cases.entries()) {
        const task = byId.get(`item-${index + 1}`);
        if (entry.authorization === 'execute') {
          authorizations.push({
            itemId: task.itemId,
            playbook: task.playbook,
            dependencies: task.dependencies,
            executionAuthorized: true,
          });
        }
        if (entry.cutover) {
          authorizations.push(verifiedCutover(task, entry.cutover));
        }
      }
      const plan = planLifecycleMigration(tasks, {
        now: Date.parse('2026-09-09T12:00:00.000Z'),
        authorizations,
      });
      assert.equal(plan.actions.length, 23);
      assert.deepEqual(
        plan.actions.filter((action) => action.action !== 'migrate'),
        [],
      );

      const report = await applyLifecycleMigration(plan, store);

      assert.equal(
        report.partial,
        false,
        JSON.stringify(report.results.filter((result) => result.outcome !== 'migrated')),
      );
      assert.equal(report.results.length, 23);
      assert.deepEqual(
        report.results.filter((result) => result.outcome !== 'migrated'),
        [],
      );
      assert.equal(
        state.items.find((item) => item.id === 'item-17').fields['resource-semantics'],
        'historical-provenance',
      );
      assert.equal(
        state.items.find((item) => item.id === 'item-19').fields['resource-semantics'],
        'held-affinity',
      );
      assert.equal(
        state.items.find((item) => item.id === 'item-21').fields['resource-semantics'],
        'held-affinity',
      );
});

test('verified cutover apply refuses stale claim changes before clearing ownership', async () => {
      const state = fakeGitHubState();
      state.item.fields.Status = 'paused';
      state.item.fields.owner = 'agent';
      state.item.fields['worker-state'] = '';
      state.item.fields['claimed-by'] = 'old-runner';
      state.item.fields['lease-until'] = '2026-09-09T08:00:00.000Z';
      state.item.fields['needs-human-since'] = '2026-09-09T07:30:00.000Z';
      state.item.fields.machine = 'machine-a';
      state.item.fields['session-id'] = 'session-a';
      state.item.fields['claim-generation'] = '';
      const { store } = await fakeStore(state);
      const task = (await store.list()).tasks[0];
      const plan = planLifecycleMigration([task], {
        now: Date.parse('2026-09-09T12:00:00.000Z'),
        authorizations: [verifiedCutover(task, 'verifiedHumanCheckpoint')],
      });
      assert.equal(plan.actions[0].action, 'migrate');
      state.item.fields['claimed-by'] = 'new-runner';
      const before = state.writes.length;

      await assert.rejects(
        store.migrateLegacyItem(plan.actions[0]),
        /changed after the migration plan/,
      );
      assert.equal(state.writes.length, before);
      assert.equal(state.item.fields['claimed-by'], 'new-runner');
      assert.equal(state.item.fields['lease-until'], '2026-09-09T08:00:00.000Z');
});

test('durable deliberate hold migration preserves passive session evidence and stays non-runnable', async () => {
      const state = fakeGitHubState();
      state.issue.body = renderCurrentActionBlock({
        status: 'deliberate-hold',
        action: 'hold',
        detail: 'Hold until the user deliberately resumes this outcome.',
        revision: 1,
        updatedAt: '2026-09-01T00:00:00.000Z',
      });
      state.item.fields.Status = 'blocked';
      state.item.fields['next-action'] = '';
      state.item.fields.owner = 'human';
      state.item.fields['worker-state'] = 'checkpointed';
      state.item.fields.machine = 'machine-a';
      state.item.fields['session-id'] = 'session-a';
      state.item.fields['claim-generation'] = 'generation-a';
      const { store } = await fakeStore(state);
      const plan = planLifecycleMigration((await store.list()).tasks);
      assert.equal(plan.actions[0].action, 'migrate');

      await store.migrateLegacyItem(plan.actions[0]);

      assert.equal(state.item.fields.Status, 'deliberate-hold');
      assert.equal(state.item.fields['next-action'], 'hold');
      assert.equal(state.item.fields['execution-authorized'], 'no');
      assert.equal(state.item.fields['worker-state'], 'checkpointed');
      assert.equal(state.item.fields.machine, 'machine-a');
      assert.equal(state.item.fields['session-id'], 'session-a');
      assert.equal(state.item.fields['claim-generation'], 'generation-a');
      assert.equal(state.item.fields['resource-semantics'], 'held-affinity');
      assert.equal(state.item.fields['claimed-by'], '');
      assert.equal(state.item.fields['lease-until'], '');
      assert.equal(state.issue.state, 'OPEN');
});

test('valid open nonterminal migrations converge for legacy, current repair, and durable hold', async () => {
      const cases = [
        {
          name: 'legacy',
          expectedAction: 'migrate',
          configure(state) {
            state.item.fields.Status = 'ready';
            state.item.fields['next-action'] = '';
            state.item.fields.owner = 'human';
            state.item.fields['worker-state'] = '';
            state.item.fields['task-revision'] = '';
          },
        },
        {
          name: 'current repair',
          expectedAction: 'repair-current',
          configure() {},
        },
        {
          name: 'durable hold',
          expectedAction: 'migrate',
          configure(state) {
            state.issue.body = renderCurrentActionBlock({
              status: 'deliberate-hold',
              action: 'hold',
              detail: 'Hold until the user deliberately resumes this outcome.',
              revision: 1,
              updatedAt: '2026-09-01T00:00:00.000Z',
            });
            state.item.fields.Status = 'blocked';
            state.item.fields['next-action'] = '';
            state.item.fields.owner = 'human';
            state.item.fields['worker-state'] = 'checkpointed';
            state.item.fields.machine = 'machine-a';
            state.item.fields['session-id'] = 'session-a';
            state.item.fields['claim-generation'] = 'generation-a';
          },
        },
      ];

      for (const entry of cases) {
        const state = fakeGitHubState();
        entry.configure(state);
        const { store } = await fakeStore(state);
        const initial = planLifecycleMigration((await store.list()).tasks);
        assert.equal(initial.actions[0].action, entry.expectedAction, entry.name);

        const applied = await applyLifecycleMigration(initial, store);
        assert.equal(applied.partial, false, entry.name);
        assert.equal(state.issue.state, 'OPEN', entry.name);

        const converged = planLifecycleMigration((await store.list()).tasks);
        assert.equal(converged.actions[0].action, 'already-current', entry.name);
        const before = state.writes.length;
        const reapplied = await applyLifecycleMigration(converged, store);
        assert.equal(reapplied.partial, false, entry.name);
        assert.equal(state.writes.length, before, entry.name);
      }
});

test('closed nonterminal migrations remain write-free during apply and direct store repair', async () => {
      const cases = [
        {
          name: 'legacy',
          configure(state) {
            state.item.fields.Status = 'ready';
            state.item.fields['next-action'] = '';
            state.item.fields.owner = 'human';
            state.item.fields['worker-state'] = '';
            state.item.fields['task-revision'] = '';
          },
        },
        {
          name: 'current repair',
          configure() {},
        },
        {
          name: 'durable hold',
          configure(state) {
            state.issue.body = renderCurrentActionBlock({
              status: 'deliberate-hold',
              action: 'hold',
              detail: 'Hold until the user deliberately resumes this outcome.',
              revision: 1,
              updatedAt: '2026-09-01T00:00:00.000Z',
            });
            state.item.fields.Status = 'blocked';
            state.item.fields['next-action'] = '';
            state.item.fields.owner = 'human';
            state.item.fields['worker-state'] = 'checkpointed';
            state.item.fields.machine = 'machine-a';
            state.item.fields['session-id'] = 'session-a';
            state.item.fields['claim-generation'] = 'generation-a';
          },
        },
      ];

      for (const entry of cases) {
        const state = fakeGitHubState();
        entry.configure(state);
        state.issue.state = 'CLOSED';
        state.issue.stateReason = 'COMPLETED';
        const { store } = await fakeStore(state);
        const plan = planLifecycleMigration((await store.list()).tasks);
        assert.equal(plan.actions[0].action, 'invalid-state', entry.name);
        const before = state.writes.length;

        const report = await applyLifecycleMigration(plan, store);
        assert.equal(report.partial, true, entry.name);
        assert.equal(state.writes.length, before, entry.name);
        await assert.rejects(
          store.migrateLegacyItem(plan.actions[0]),
          /closed Issue.*nonterminal.*reconciliation/i,
          entry.name,
        );
        assert.equal(state.writes.length, before, entry.name);
        assert.equal(state.issue.state, 'CLOSED', entry.name);
      }
});

test('deliberate hold migration leaves an open checkpoint untouched for reconciliation', async () => {
      const state = fakeGitHubState();
      state.issue.body = renderCurrentActionBlock({
        status: 'deliberate-hold',
        action: 'hold',
        detail: 'Hold until the user deliberately resumes this outcome.',
        revision: 1,
        updatedAt: '2026-09-01T00:00:00.000Z',
      });
      state.item.fields.Status = 'blocked';
      state.item.fields['next-action'] = '';
      state.item.fields.owner = 'human';
      state.item.fields['worker-state'] = 'checkpointed';
      state.item.fields['needs-human-since'] = '2026-09-01T01:00:00Z';
      state.item.fields.machine = 'machine-a';
      state.item.fields['session-id'] = 'session-a';
      state.item.fields['claim-generation'] = 'generation-a';
      const { store } = await fakeStore(state);
      const plan = planLifecycleMigration((await store.list()).tasks);
      assert.equal(plan.actions[0].action, 'requires-cutover-hold');
      const before = state.writes.length;

      const report = await applyLifecycleMigration(plan, store);

      assert.equal(report.partial, true);
      assert.equal(state.writes.length, before);
      assert.equal(state.item.fields['needs-human-since'], '2026-09-01T01:00:00Z');
      assert.equal(state.item.fields['resource-semantics'], '');
      assert.equal(state.item.fields.Status, 'blocked');
});

test('lifecycle migration refuses playbook or Issue drift from its complete planned projection', async () => {
      const state = fakeGitHubState();
      state.item.fields.Status = 'ready';
      state.item.fields['next-action'] = '';
      state.item.fields.owner = 'human';
      state.item.fields['worker-state'] = '';
      state.item.fields['task-revision'] = '';
      const { store } = await fakeStore(state);
      const plan = planLifecycleMigration((await store.list()).tasks);
      assert.equal(plan.actions[0].action, 'migrate');
      state.item.fields.playbook = 'changed-after-plan';
      state.issue.title = 'Changed after plan';
      const before = state.writes.length;

      await assert.rejects(
        store.migrateLegacyItem(plan.actions[0]),
        /changed after the migration plan/,
      );
      assert.equal(state.writes.length, before);
});

test('legacy execution authorization default still rejects a substantive live change', async () => {
      const state = fakeGitHubState();
      state.item.fields.Status = 'ready';
      state.item.fields['next-action'] = '';
      state.item.fields.owner = 'human';
      state.item.fields['execution-authorized'] = '';
      state.item.fields['task-revision'] = '';
      const { store } = await fakeStore(state);
      const plan = planLifecycleMigration((await store.list()).tasks);
      assert.equal(plan.actions[0].expected.executionAuthorized, 'no');
      state.item.fields['execution-authorized'] = 'yes';
      const before = state.writes.length;

      await assert.rejects(
        store.migrateLegacyItem(plan.actions[0]),
        /changed after the migration plan/,
      );
      assert.equal(state.writes.length, before);
});

test('browser terminal actions refuse retained checkpoint affinity before any write', async () => {
      for (const operation of ['finish', 'reject']) {
        const state = fakeGitHubState();
        state.issue.body = renderCurrentActionBlock({
          status: 'ready-for-human',
          action: 'approve',
          detail: 'Approve the completed worker output.',
          revision: 1,
          updatedAt: '2026-09-01T00:00:00.000Z',
        });
        state.item.fields.Status = 'ready-for-human';
        state.item.fields['next-action'] = 'approve';
        state.item.fields['worker-state'] = 'checkpointed';
        state.item.fields.machine = 'machine-a';
        state.item.fields['session-id'] = 'session-a';
        state.item.fields['claim-generation'] = 'generation-a';
        const { store } = await fakeStore(state);
        const detail = await store.detail('item-1');
        const before = state.writes.length;

        await assert.rejects(
          store.mutate({
            itemId: detail.itemId,
            revision: detail.revision,
            projection: detail.projection,
            operation,
            detail: operation === 'finish' ? 'Complete.' : 'Reject.',
          }),
          /retained workspace affinity/,
        );
        assert.equal(state.writes.length, before);
        assert.equal(state.issue.state, 'OPEN');
        assert.equal(state.item.fields.machine, 'machine-a');
        assert.equal(state.item.fields['session-id'], 'session-a');
        assert.equal(state.item.fields['claim-generation'], 'generation-a');
      }
});

test('browser mutations cannot turn historical provenance into resumable work', async () => {
      const mutations = [
        { operation: 'edit', changes: { workerState: 'paused' } },
        { operation: 'edit', changes: { resourceSemantics: 'held-affinity' } },
        { operation: 'hold', detail: 'Hold this historical record.' },
        { operation: 'handoff-ai', detail: 'Resume this historical record.' },
        { operation: 'handoff-human', action: 'review', detail: 'Review this record.' },
        { operation: 'external-wait', detail: 'Wait on this historical record.' },
      ];
      for (const mutation of mutations) {
        const state = fakeGitHubState();
        state.issue.body = renderCurrentActionBlock({
          status: 'done',
          action: 'none',
          detail: 'Outcome complete.',
          revision: 3,
          updatedAt: '2026-09-01T00:00:00.000Z',
        });
        state.issue.state = 'CLOSED';
        state.issue.stateReason = 'COMPLETED';
        Object.assign(state.item.fields, {
          Status: 'done',
          'next-action': 'none',
          playbook: 'isolated',
          'execution-authorized': 'no',
          'worker-state': 'stopped',
          machine: 'machine-a',
          'session-id': 'session-a',
          'claim-generation': 'generation-a',
          'resource-semantics': 'historical-provenance',
          'task-revision': '3',
        });
        const { store } = await fakeStore(state);
        const detail = await store.detail('item-1');
        const beforeFields = structuredClone(state.item.fields);
        const beforeWrites = state.writes.length;

        await assert.rejects(
          store.mutate({
            itemId: detail.itemId,
            revision: detail.revision,
            projection: detail.projection,
            ...mutation,
          }),
          /cannot reclassify or resume historical provenance/,
        );

        assert.equal(state.writes.length, beforeWrites, mutation.operation);
        assert.deepEqual(state.item.fields, beforeFields, mutation.operation);
        assert.equal(state.issue.state, 'CLOSED');
        assert.equal(state.issue.stateReason, 'COMPLETED');
      }
});

test('browser handoff resumes a legitimate open nonterminal checkpoint', async () => {
      const state = fakeGitHubState();
      state.issue.body = renderCurrentActionBlock({
        status: 'ready-for-human',
        action: 'approve',
        detail: 'Approve the checkpoint.',
        revision: 1,
        updatedAt: '2026-09-01T00:00:00.000Z',
      });
      Object.assign(state.item.fields, {
        Status: 'ready-for-human',
        'next-action': 'approve',
        playbook: 'isolated',
        'execution-authorized': 'no',
        'worker-state': 'checkpointed',
        machine: 'machine-a',
        'session-id': 'session-a',
        'claim-generation': 'generation-a',
        'resource-semantics': '',
      });
      const { store } = await fakeStore(state);
      const detail = await store.detail('item-1');

      await store.mutate({
        itemId: detail.itemId,
        revision: detail.revision,
        projection: detail.projection,
        operation: 'handoff-ai',
        detail: 'Continue from the approved checkpoint.',
      });

      assert.equal(state.issue.state, 'OPEN');
      assert.equal(state.item.fields.Status, 'ready-for-ai');
      assert.equal(state.item.fields['next-action'], 'execute');
      assert.equal(state.item.fields['execution-authorized'], 'yes');
      assert.equal(state.item.fields['worker-state'], 'paused');
      assert.equal(state.item.fields['resource-semantics'], '');
      assert.equal(state.item.fields.machine, 'machine-a');
      assert.equal(state.item.fields['session-id'], 'session-a');
      assert.equal(state.item.fields['claim-generation'], 'generation-a');
});

test('checked lifecycle rollback preserves pilot progress and is idempotent after a fresh live plan', async () => {
      const state = fakeGitHubState();
      const baseBody = '# Outcome\n\nKeep the completed pilot analysis.';
      state.issue.body = upsertCurrentActionBlock(baseBody, renderCurrentActionBlock({
        status: 'external-waiting',
        action: 'wait',
        detail: 'Wait for the permit.',
        revision: 3,
        updatedAt: '2026-09-01T00:00:00.000Z',
      }));
      state.item.fields.Status = 'external-waiting';
      state.item.fields['next-action'] = 'wait';
      state.item.fields.priority = 'urgent';
      state.item.fields.playbook = 'permit-monitor';
      state.item.fields.dependencies = 'County review';
      state.item.fields['next-action-date'] = '2026-09-20';
      state.item.fields.deadline = '2026-09-30';
      state.item.fields['task-revision'] = '3';
      const { store } = await fakeStore(state);
      const plan = planLifecycleRollback((await store.list()).tasks);
      assert.equal(plan.actions[0].action, 'rollback');

      const report = await applyLifecycleRollback(plan, store);

      assert.equal(report.partial, false);
      assert.equal(state.item.fields.owner, 'human');
      assert.equal(state.item.fields.Status, 'blocked');
      assert.equal(state.item.fields['next-action'], 'wait');
      assert.equal(state.item.fields.priority, 'urgent');
      assert.equal(state.item.fields.playbook, 'permit-monitor');
      assert.equal(state.item.fields.dependencies, 'County review');
      assert.equal(state.item.fields['next-action-date'], '2026-09-20');
      assert.equal(state.item.fields.deadline, '2026-09-30');
      assert.equal(state.item.fields['task-revision'], '4');
      assert.match(state.issue.body, /Keep the completed pilot analysis/);
      assert.equal(parseCurrentActionBlock(state.issue.body).status, 'external-waiting');
      assert.equal(state.writes.at(-1), 'project:task-revision');

      const writes = state.writes.length;
      const secondPlan = planLifecycleRollback((await store.list()).tasks);
      assert.equal(secondPlan.actions[0].action, 'already-rolled-back');
      const second = await applyLifecycleRollback(secondPlan, store);
      assert.equal(second.partial, false);
      assert.equal(state.writes.length, writes);
});

test('checked lifecycle rollback preserves terminal provenance without using it as release authority', async () => {
      const state = fakeGitHubState();
      state.issue.body = renderCurrentActionBlock({
        status: 'done',
        action: 'none',
        detail: 'Outcome complete.',
        revision: 3,
        updatedAt: '2026-09-01T00:00:00.000Z',
      });
      state.issue.state = 'CLOSED';
      state.issue.stateReason = 'COMPLETED';
      state.item.fields.Status = 'done';
      state.item.fields['next-action'] = 'none';
      state.item.fields.owner = 'human';
      state.item.fields['next-action-date'] = '';
      state.item.fields['worker-state'] = 'stopped';
      state.item.fields.machine = 'machine-a';
      state.item.fields['session-id'] = 'session-a';
      state.item.fields['claim-generation'] = '';
      state.item.fields['resource-semantics'] = 'historical-provenance';
      state.item.fields['task-revision'] = '3';
      const { store } = await fakeStore(state);
      const plan = planLifecycleRollback((await store.list()).tasks);
      assert.equal(plan.actions[0].action, 'rollback');

      await store.rollbackLifecycleItem(plan.actions[0]);

      assert.equal(state.item.fields.Status, 'done');
      assert.equal(state.item.fields.owner, 'unassigned');
      assert.equal(state.item.fields['worker-state'], 'stopped');
      assert.equal(state.item.fields.machine, 'machine-a');
      assert.equal(state.item.fields['session-id'], 'session-a');
      assert.equal(state.item.fields['claim-generation'], '');
      assert.equal(state.item.fields['resource-semantics'], 'historical-provenance');
      assert.equal(state.item.fields['claimed-by'], '');
      assert.equal(state.item.fields['lease-until'], '');
});

test('checked lifecycle rollback refuses stale complete projection without writes', async () => {
      const state = fakeGitHubState();
      state.issue.body = renderCurrentActionBlock({
        status: 'ready-for-human',
        action: 'act',
        detail: 'Perform the next action.',
        revision: 1,
        updatedAt: '2026-09-01T00:00:00.000Z',
      });
      const { store } = await fakeStore(state);
      const plan = planLifecycleRollback((await store.list()).tasks);
      state.issue.title = 'Externally changed';
      const before = state.writes.length;

      const report = await applyLifecycleRollback(plan, store);

      assert.equal(report.partial, true);
      assert.match(report.results[0].error, /changed after the current-state plan/);
      assert.equal(state.writes.length, before);
});

test('rollback plan and apply reject the same uncertain worker state without writes', async () => {
      const state = fakeGitHubState();
      state.issue.body = renderCurrentActionBlock({
        status: 'ready-for-human',
        action: 'act',
        detail: 'Perform the next action.',
        revision: 1,
        updatedAt: '2026-09-01T00:00:00.000Z',
      });
      state.item.fields['worker-state'] = 'uncertain';
      const { store } = await fakeStore(state);
      const plan = planLifecycleRollback((await store.list()).tasks);
      const blocked = plan.actions[0];
      assert.equal(blocked.action, 'invalid-state');
      assert.match(blocked.reason, /live or uncertain worker/);

      let called = false;
      const report = await applyLifecycleRollback(plan, {
        async rollbackLifecycleItem() {
          called = true;
          throw new Error('unsafe rollback must not be invoked');
        },
      });
      assert.equal(called, false);
      assert.equal(report.partial, true);

      const before = state.writes.length;
      await assert.rejects(
        store.rollbackLifecycleItem({
          ...blocked,
          action: 'rollback',
          legacyTarget: { owner: 'human', status: 'ready' },
        }),
        (error) => {
          assert.equal(error.message, blocked.reason);
          return true;
        },
      );
      assert.equal(state.writes.length, before);
});

test('recurring cancellation refuses an existing or unverifiable successor before clearing its date', async () => {
      const state = fakeGitHubState();
      const recurrence = recurring('2026-09-04', 'Every Friday.');
      state.issue.body = upsertCurrentActionBlock(recurrence, renderCurrentActionBlock({
        status: 'ready-for-human',
        action: 'act',
        detail: 'Perform this occurrence.',
        revision: 1,
        updatedAt: '2026-09-01T00:00:00.000Z',
      }));
      state.comments.push({
        id: 'next-comment',
        author: { login: 'pan' },
        createdAt: '2026-09-01T00:00:00Z',
        updatedAt: '2026-09-01T00:00:00Z',
        url: `${state.issue.url}#issuecomment-next`,
        body: 'Pan: next occurrence https://github.com/example/domain/issues/2',
      });
      const { store } = await fakeStore(state);
      const detail = await store.detail('item-1');
      const before = state.writes.length;

      await assert.rejects(
        store.mutate({
          itemId: detail.itemId,
          revision: detail.revision,
          projection: detail.projection,
          operation: 'reject',
          detail: 'Cancel series.',
        }),
        /could not be verified/,
      );
      assert.equal(state.item.fields['next-action-date'], '2026-09-01');
      assert.equal(state.issue.state, 'OPEN');
      assert.equal(state.writes.length, before);
});
