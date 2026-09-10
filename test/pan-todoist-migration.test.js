import assert from 'node:assert/strict';
import test from 'node:test';
import { parseMigrationCli } from '../bin/pan-todoist-migrate.js';
import {
  applyTodoistImport,
  planTodoistImport,
  readTodoistSnapshot,
  recoveryPlan,
  todoistImportRecords,
} from '../bin/pan-todoist-migration.js';

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return structuredClone(body);
    },
  };
}

test('Todoist snapshot fully paginates and excludes tasks assigned to another user', async () => {
  const calls = [];
  const fetchImpl = async (input) => {
    const url = new URL(input);
    calls.push(url.href);
    if (url.pathname.endsWith('/user')) return response({ id: 'me' });
    if (url.pathname.endsWith('/tasks')) {
      if (!url.searchParams.get('cursor')) {
        return response({
          results: [
            { id: '1', content: 'Mine', assignee_id: 'me' },
            { id: '2', content: 'Someone else', assignee_id: 'other' },
          ],
          next_cursor: 'task-page-2',
        });
      }
      return response({
        results: [{ id: '3', content: 'Unassigned', assignee_id: null }],
        next_cursor: null,
      });
    }
    if (url.pathname.endsWith('/projects')) {
      return response({ results: [{ id: 'p1', name: 'Home' }], next_cursor: null });
    }
    if (url.pathname.endsWith('/sections')) {
      return response({ results: [{ id: 's1', name: 'Calls' }], next_cursor: null });
    }
    if (url.pathname.endsWith('/labels')) {
      return response({ results: [{ id: 'l1', name: 'context' }], next_cursor: null });
    }
    if (url.pathname.endsWith('/comments')) {
      const taskId = url.searchParams.get('task_id');
      if (taskId === '1' && !url.searchParams.get('cursor')) {
        return response({
          results: [{ id: 'c1', content: 'First', posted_at: '2026-09-01T10:00:00Z' }],
          next_cursor: 'comment-page-2',
        });
      }
      if (taskId === '1') {
        return response({
          results: [{ id: 'c2', content: 'Second', posted_at: '2026-09-02T10:00:00Z' }],
          next_cursor: null,
        });
      }
      return response({ results: [], next_cursor: null });
    }
    throw new Error(`unexpected URL ${url}`);
  };

  const snapshot = await readTodoistSnapshot({
    fetchImpl,
    token: 'secret-for-test',
    baseUrl: 'https://todoist.example/api/v1/',
  });

  assert.deepEqual(snapshot.tasks.map((task) => task.id), ['1', '3']);
  assert.deepEqual(snapshot.tasks[0].comments.map((comment) => comment.id), ['c1', 'c2']);
  assert.deepEqual(snapshot.excluded, [{
    id: '2',
    assigneeId: 'other',
    reason: 'assigned-to-another-user',
  }]);
  assert.equal(calls.filter((url) => url.includes('/tasks?')).length, 2);
  assert.equal(calls.some((url) => url.includes('cursor=comment-page-2')), true);
});

function snapshotFixture() {
  return {
    format: 'pan-todoist-active-snapshot',
    version: 1,
    capturedAt: '2026-09-09T00:00:00Z',
    user: { id: 'me' },
    projects: [{ id: 'p1', name: 'Personal' }],
    sections: [{ id: 's1', name: 'Calls' }],
    labels: [{ id: 'l1', name: 'phone' }],
    excluded: [{ id: 'other', assigneeId: 'another', reason: 'assigned-to-another-user' }],
    tasks: [
      {
        id: '1',
        content: 'Call the clinic',
        description: 'Ask about the cancellation list.',
        project_id: 'p1',
        section_id: 's1',
        labels: ['l1'],
        priority: 4,
        due: {
          date: '2026-09-12',
          string: 'Every Saturday',
          is_recurring: true,
        },
        deadline: { date: '2026-09-15' },
        duration: { amount: 20, unit: 'minute' },
        comments: [{ id: 'c1', content: 'Bring the account number.', posted_at: '2026-09-01T10:00:00Z' }],
      },
      {
        id: '2',
        content: 'File the receipt',
        description: '',
        priority: 1,
        due: null,
        deadline: null,
        comments: [],
      },
    ],
  };
}

test('import records preserve source context, comments, dates, deadlines, and recurrence separately', () => {
  const [record] = todoistImportRecords(snapshotFixture());
  assert.equal(record.priority, 'urgent');
  assert.equal(record.nextActionDate, '2026-09-12');
  assert.equal(record.deadline, '2026-09-15');
  assert.deepEqual(record.recurrence, {
    occurrence: '2026-09-12',
    rule: 'Every Saturday',
  });
  assert.match(record.body, /^Pan: recurrence occurrence 2026-09-12/);
  assert.match(record.body, /Source project: Personal \(p1\)/);
  assert.match(record.body, /Source section: Calls \(s1\)/);
  assert.match(record.body, /Source labels: phone/);
  assert.match(record.body, /completed history was not imported/i);
  assert.deepEqual(record.comments, [{
    id: 'c1',
    content: 'Bring the account number.',
    postedAt: '2026-09-01T10:00:00Z',
  }]);
});

test('import planning is idempotent and fails closed on duplicate source markers', () => {
  const index = new Map([
    ['1', [{ sourceId: '1', issueUrl: 'https://github.com/example/domain/issues/1', state: 'OPEN', inProject: true }]],
    ['2', [
      { sourceId: '2', issueUrl: 'https://github.com/example/domain/issues/2', state: 'OPEN', inProject: true },
      { sourceId: '2', issueUrl: 'https://github.com/example/domain/issues/3', state: 'OPEN', inProject: true },
    ]],
  ]);
  const plan = planTodoistImport(snapshotFixture(), index);
  assert.deepEqual(
    plan.actions.map((action) => [action.sourceId, action.action]),
    [
      ['other', 'excluded-assignee'],
      ['1', 'verify-or-repair'],
      ['2', 'conflict'],
    ],
  );
});

test('partial import continues independent tasks and reports failure without rollback', async () => {
  const plan = planTodoistImport(snapshotFixture(), new Map());
  const attempted = [];
  const store = {
    async importTodoistTask(record) {
      attempted.push(record.sourceId);
      if (record.sourceId === '1') throw new Error('Project write failed');
      return {
        sourceId: record.sourceId,
        issueUrl: `https://github.com/example/domain/issues/${record.sourceId}`,
        itemId: `item-${record.sourceId}`,
        outcome: 'created',
      };
    },
  };
  const report = await applyTodoistImport(plan, store);
  assert.deepEqual(attempted, ['1', '2']);
  assert.equal(report.partial, true);
  assert.equal(report.results.find((result) => result.sourceId === '1').outcome, 'failed');
  assert.equal(report.results.find((result) => result.sourceId === '2').outcome, 'created');
});

test('recovery plan translates current live pilot state and preserves current scheduling', () => {
  const plan = recoveryPlan([
    {
      itemId: 'item-1',
      url: 'https://github.com/example/domain/issues/1',
      status: 'ai-executing',
      nextAction: 'execute',
      workerState: 'paused',
      revision: 9,
      issueState: 'OPEN',
      issueStateReason: null,
      currentActionStatus: 'ai-executing',
      currentActionAction: 'execute',
      currentActionRevision: 9,
      nextActionDetail: 'Continue the pilot.',
      legacyOwner: 'unassigned',
      executionAuthorized: 'yes',
      dependencies: '',
      playbook: 'pilot',
      claimedBy: '',
      leaseUntil: '',
      projection: 'projection',
      nextActionDate: '2026-09-20',
      deadline: '2026-09-30',
      machine: 'machine-a::primary',
      sessionId: 'session',
      claimGeneration: 'generation',
    },
  ]);
  assert.equal(plan.source, 'current-live-state');
  assert.deepEqual(plan.actions[0].legacyTarget, { owner: 'agent', status: 'paused' });
  assert.equal(plan.actions[0].preserve.nextActionDate, '2026-09-20');
  assert.equal(plan.actions[0].current.revision, 9);
});

test('Todoist recovery apply CLI is checked and uses no stale snapshot', () => {
  assert.throws(
    () => parseMigrationCli([
      'recovery-apply',
      '--config', '/config',
      '--checkout', '/pan',
    ]),
    /confirm-writers-stopped/,
  );
  const parsed = parseMigrationCli([
    'recovery-apply',
    '--config', '/config',
    '--checkout', '/pan',
    '--confirm-writers-stopped',
  ]);
  assert.equal(parsed.command, 'recovery-apply');
  assert.equal(parsed.snapshot, undefined);
});
