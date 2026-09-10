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

function fakeGitHubState() {
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
      const node = (projectItem = item) => ({
        id: projectItem.id,
        updatedAt: projectItem.updatedAt,
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
          return JSON.stringify({
            data: {
              user: {
                projectV2: {
                  items: { nodes: items.map((entry) => node(entry)), pageInfo: { hasNextPage: false, endCursor: null } },
                },
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
                },
              },
            },
          });
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
      assert.equal(state.item.fields['task-revision'], '2');
      assert.equal(state.comments[0].body, 'Pan: Todoist source comment c1\n\nImported 2026-09-08T00:00:00Z:\n\nCurrent comment.');
      assert.equal(state.writes.at(-1), 'project:task-revision');
      assert.equal((await store.verifyTodoistTask(record)).outcome, 'verified');
      const writesAfterRepair = state.writes.length;
      assert.equal((await store.importTodoistTask(record)).outcome, 'verified');
      assert.equal(state.writes.length, writesAfterRepair);
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

      const result = await store.importTodoistTask(record);

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

      await assert.rejects(
        store.importTodoistTask(record),
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

      const result = await store.importTodoistTask(record);

      assert.equal(result.outcome, 'repaired');
      assert.deepEqual(state.writes, ['issue:comment', 'project:task-revision']);
      assert.equal(
        state.comments.filter((comment) => comment.body.startsWith('Pan: task transition 2')).length,
        1,
      );
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
      state.item.fields.Status = 'done';
      state.item.fields['next-action'] = '';
      state.item.fields['next-action-date'] = '2026-09-01';
      state.item.fields['worker-state'] = '';
      state.item.fields.machine = 'machine-a';
      state.item.fields['session-id'] = 'session-a';
      state.item.fields['claim-generation'] = 'generation-a';
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
      assert.equal(state.item.fields['claim-generation'], 'generation-a');
      assert.equal(state.item.fields['resource-semantics'], 'historical-provenance');
      assert.equal(state.writes.at(-1), 'project:task-revision');
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
      state.item.fields['claim-generation'] = 'generation-a';
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
      assert.equal(state.item.fields['claim-generation'], 'generation-a');
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
