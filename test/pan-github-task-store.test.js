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
import { planLifecycleMigration } from '../bin/pan-lifecycle-migration.js';
import {
  renderCurrentActionBlock,
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
          'task-revision': '1',
        },
      };
      const comments = [{
        id: 'comment-1',
        author: { login: 'pan' },
        createdAt: '2026-09-01T00:00:00Z',
        updatedAt: '2026-09-01T00:00:00Z',
        url: `${issue.url}#issuecomment-1`,
        body: 'Pan: Todoist source comment c1\n\nstale',
      }];
      const writes = [];
      const node = () => ({
        id: item.id,
        updatedAt: item.updatedAt,
        content: {
          __typename: 'Issue',
          number: issue.number,
          title: issue.title,
          body: issue.body,
          url: issue.url,
          state: issue.state,
          stateReason: issue.stateReason,
          createdAt: issue.createdAt,
          updatedAt: issue.updatedAt,
          closedAt: issue.closedAt,
          repository: { nameWithOwner: 'example/domain' },
        },
        fieldValues: {
          nodes: Object.entries(item.fields).filter(([, value]) => value !== '').map(([name, value]) => {
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
                  items: { nodes: [node()], pageInfo: { hasNextPage: false, endCursor: null } },
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
                  nodes: [{ ...issue }],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          });
        }
        if (query.includes('comments(first:100')) {
          return JSON.stringify({
            data: {
              repository: {
                issue: {
                  comments: {
                    nodes: comments.map((comment) => ({ ...comment })),
                    pageInfo: { hasNextPage: false, endCursor: null },
                  },
                },
              },
            },
          });
        }
        if (args[0] === 'project' && args[1] === 'item-edit') {
          const field = byFieldId.get(valueAfter(args, '--field-id'));
          let value = '';
          if (args.includes('--single-select-option-id')) {
            value = byOptionId.get(valueAfter(args, '--single-select-option-id')).value;
          } else if (args.includes('--text')) value = valueAfter(args, '--text');
          else if (args.includes('--date')) value = valueAfter(args, '--date');
          item.fields[field.name] = value;
          writes.push(`project:${field.name}`);
          return '';
        }
        if (args[0] === 'issue' && args[1] === 'edit') {
          if (args.includes('--title')) issue.title = valueAfter(args, '--title');
          if (args.includes('--body')) issue.body = valueAfter(args, '--body');
          writes.push('issue:edit');
          return '';
        }
        if (args[0] === 'issue' && args[1] === 'view') {
          if (valueAfter(args, '--json') === 'body') {
            return JSON.stringify({ body: issue.body });
          }
          return JSON.stringify({ state: issue.state, stateReason: issue.stateReason });
        }
        if (args[0] === 'issue' && args[1] === 'close') {
          issue.state = 'CLOSED';
          issue.stateReason = valueAfter(args, '--reason') === 'not planned'
            ? 'NOT_PLANNED'
            : 'COMPLETED';
          writes.push('issue:close');
          return '';
        }
        if (args[0] === 'issue' && args[1] === 'comment') {
          comments.push({
            id: `comment-${comments.length + 1}`,
            author: { login: 'pan' },
            createdAt: '2026-09-09T00:00:00Z',
            updatedAt: '2026-09-09T00:00:00Z',
            url: `${issue.url}#issuecomment-${comments.length + 1}`,
            body: valueAfter(args, '--body'),
          });
          writes.push('issue:comment');
          return '';
        }
        if (args[0] === 'api' && args.includes('--paginate')) {
          return JSON.stringify([comments.map((comment) => ({ body: comment.body }))]);
        }
        if (args[0] === 'api' && args.includes('-X') && args.includes('PATCH')) {
          const endpoint = args.find((arg) => String(arg).includes('/issues/comments/'));
          const id = endpoint.split('/').at(-1);
          comments.find((comment) => comment.id === id).body = valueAfter(args, '-f').replace(/^body=/, '');
          writes.push('comment:edit');
          return '{}';
        }
        throw new Error(`unexpected fake gh call: ${args.join(' ')}`);
      };
      return { fields, issue, item, comments, writes, gh };
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

test('terminal lifecycle migration always closes the Issue and repairs the full tuple with revision last', async () => {
      const state = fakeGitHubState();
      state.item.fields.Status = 'done';
      state.item.fields['next-action'] = '';
      state.item.fields['next-action-date'] = '2026-09-01';
      state.item.fields['worker-state'] = '';
      state.item.fields.machine = 'old-machine';
      state.item.fields['session-id'] = 'old-session';
      state.item.fields['claim-generation'] = 'old-generation';
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
      assert.equal(state.item.fields.machine, '');
      assert.equal(state.item.fields['session-id'], '');
      assert.equal(state.item.fields['claim-generation'], '');
      assert.equal(state.writes.at(-1), 'project:task-revision');
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
