import { planLifecycleRollback } from './pan-lifecycle-migration.js';

const TODOIST_PAGE_SIZE = 200;

function arrayResult(payload) {
  if (Array.isArray(payload)) return { results: payload, nextCursor: null };
  const results = payload?.results ?? payload?.items;
  if (!Array.isArray(results)) throw new Error('Todoist returned an invalid paginated response');
  return {
    results,
    nextCursor: payload.next_cursor ?? payload.nextCursor ?? null,
  };
}

export async function paginateTodoist({
  fetchImpl = fetch,
  baseUrl,
  path,
  token,
  query = {},
}) {
  const results = [];
  let cursor = null;
  const seen = new Set();
  do {
    const url = new URL(path, baseUrl);
    url.searchParams.set('limit', String(TODOIST_PAGE_SIZE));
    for (const [key, value] of Object.entries(query)) {
      if (value !== '' && value != null) url.searchParams.set(key, String(value));
    }
    if (cursor) url.searchParams.set('cursor', cursor);
    const response = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      throw new Error(`Todoist ${url.pathname} returned HTTP ${response.status}`);
    }
    const parsed = arrayResult(await response.json());
    results.push(...parsed.results);
    cursor = parsed.nextCursor;
    if (cursor) {
      if (seen.has(cursor)) throw new Error(`Todoist ${url.pathname} repeated a pagination cursor`);
      seen.add(cursor);
    }
  } while (cursor);
  return results;
}

export async function readTodoistSnapshot({
  fetchImpl = fetch,
  token,
  baseUrl = 'https://api.todoist.com/api/v1/',
}) {
  if (!token) throw new Error('Todoist token is required');
  const userResponse = await fetchImpl(new URL('user', baseUrl), {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!userResponse.ok) throw new Error(`Todoist user returned HTTP ${userResponse.status}`);
  const user = await userResponse.json();
  if (user?.id == null) throw new Error('Todoist user response has no id');

  const [tasks, projects, sections, labels] = await Promise.all([
    paginateTodoist({ fetchImpl, baseUrl, path: 'tasks', token }),
    paginateTodoist({ fetchImpl, baseUrl, path: 'projects', token }),
    paginateTodoist({ fetchImpl, baseUrl, path: 'sections', token }),
    paginateTodoist({ fetchImpl, baseUrl, path: 'labels', token }),
  ]);
  const eligible = [];
  const excluded = [];
  for (const task of tasks) {
    const assigneeId = task.assignee_id ?? task.assigneeId ?? null;
    if (assigneeId != null && String(assigneeId) !== String(user.id)) {
      excluded.push({
        id: String(task.id),
        assigneeId: String(assigneeId),
        reason: 'assigned-to-another-user',
      });
      continue;
    }
    const comments = await paginateTodoist({
      fetchImpl,
      baseUrl,
      path: 'comments',
      token,
      query: { task_id: task.id },
    });
    eligible.push({ ...task, comments });
  }
  return {
    format: 'pan-todoist-active-snapshot',
    version: 1,
    capturedAt: new Date().toISOString(),
    user: { id: String(user.id) },
    projects,
    sections,
    labels,
    tasks: eligible,
    excluded,
  };
}

function nameIndex(values) {
  return new Map((values ?? []).map((value) => [String(value.id), value]));
}

function priorityName(value) {
  const priority = Number(value);
  if (priority >= 4) return 'urgent';
  if (priority === 3) return 'high';
  if (priority === 1) return 'low';
  return 'normal';
}

function sourceDate(value) {
  if (!value) return '';
  const candidate = value.date ?? value.datetime ?? value;
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(String(candidate));
  return match?.[1] ?? '';
}

function sourceName(value) {
  return typeof value === 'string'
    ? value
    : value?.name ?? value?.content ?? '';
}

export function todoistImportRecords(snapshot) {
  if (snapshot?.format !== 'pan-todoist-active-snapshot' || snapshot.version !== 1) {
    throw new Error('snapshot is not a supported Pan Todoist snapshot');
  }
  const projects = nameIndex(snapshot.projects);
  const sections = nameIndex(snapshot.sections);
  const labels = nameIndex(snapshot.labels);
  return snapshot.tasks.map((task) => {
    const project = projects.get(String(task.project_id ?? task.projectId ?? ''));
    const section = sections.get(String(task.section_id ?? task.sectionId ?? ''));
    const labelRecords = (task.labels ?? []).map((label) => {
      if (typeof label === 'string' && labels.has(label)) {
        const found = labels.get(label);
        return { id: String(found.id), name: sourceName(found) };
      }
      if (typeof label === 'object' && label) {
        return { id: String(label.id ?? ''), name: sourceName(label) };
      }
      return { id: '', name: sourceName(label) };
    }).filter((label) => label.name);
    const labelValues = labelRecords.map((label) => label.name);
    const due = task.due ?? null;
    const deadline = task.deadline ?? null;
    const dueDate = sourceDate(due);
    const deadlineDate = sourceDate(deadline);
    const recurrence = due?.is_recurring || due?.isRecurring
      ? {
          occurrence: dueDate,
          rule: due.string ?? due.lang_text ?? due.description ?? '',
        }
      : null;
    const sourceId = String(task.id);
    const sourceUrl = task.url ?? `https://todoist.com/showTask?id=${encodeURIComponent(sourceId)}`;
    const bodyLines = [
      `Source URL: ${sourceUrl}`,
      `Source project: ${project ? `${sourceName(project)} (${project.id})` : '(none)'}`,
      `Source section: ${section ? `${sourceName(section)} (${section.id})` : '(none)'}`,
      `Source parent task: ${task.parent_id ?? task.parentId ?? '(none)'}`,
      `Source order: ${task.order ?? '(none)'}`,
      `Source assignee: ${task.assignee_id ?? task.assigneeId ?? '(unassigned)'}`,
      `Source priority: ${task.priority ?? '(none)'}`,
      `Source labels: ${labelRecords.length
        ? labelRecords.map((label) => label.id ? `${label.name} (${label.id})` : label.name).join(', ')
        : '(none)'}`,
      `Source due: ${due ? JSON.stringify(due) : '(none)'}`,
      `Source deadline: ${deadline ? JSON.stringify(deadline) : '(none)'}`,
      `Source duration: ${task.duration ? JSON.stringify(task.duration) : '(none)'}`,
      '',
      '## Imported active description',
      '',
      task.description ?? '',
      '',
      'Pan import note: active Todoist state only; completed history was not imported.',
    ];
    if (recurrence) {
      if (!recurrence.occurrence || !recurrence.rule) {
        throw new Error(`recurring Todoist task ${sourceId} lacks a usable occurrence or rule`);
      }
      bodyLines.unshift(
        `Pan: recurrence occurrence ${recurrence.occurrence}`,
        '',
      );
      bodyLines.push('', '## Recurrence', '', recurrence.rule);
    }
    return {
      sourceId,
      sourceUrl,
      title: task.content ?? task.title ?? '',
      body: bodyLines.join('\n').trim(),
      comments: (task.comments ?? []).map((comment) => ({
        id: String(comment.id),
        content: comment.content ?? '',
        postedAt: comment.posted_at ?? comment.postedAt ?? null,
      })),
      priority: priorityName(task.priority),
      nextActionDate: dueDate,
      deadline: deadlineDate,
      recurrence,
      project: project ? { id: String(project.id), name: sourceName(project) } : null,
      section: section ? { id: String(section.id), name: sourceName(section) } : null,
      labels: labelValues,
      rawContext: {
        parentId: task.parent_id ?? task.parentId ?? null,
        order: task.order ?? null,
      },
    };
  });
}

export function planTodoistImport(snapshot, sourceIndex = new Map()) {
  const records = todoistImportRecords(snapshot);
  const actions = [];
  for (const excluded of snapshot.excluded ?? []) {
    actions.push({
      sourceId: String(excluded.id),
      action: 'excluded-assignee',
      reason: excluded.reason,
      assigneeId: excluded.assigneeId,
    });
  }
  for (const record of records) {
    const matches = sourceIndex.get(record.sourceId) ?? [];
    if (matches.length > 1) {
      actions.push({
        sourceId: record.sourceId,
        action: 'conflict',
        reason: 'multiple Issues carry the source marker',
        matches,
      });
    } else if (matches.length === 0) {
      actions.push({ sourceId: record.sourceId, action: 'create', record });
    } else if (matches[0].state !== 'OPEN') {
      actions.push({
        sourceId: record.sourceId,
        action: 'conflict',
        reason: 'active Todoist task maps to a closed Issue',
        matches,
      });
    } else {
      actions.push({
        sourceId: record.sourceId,
        action: matches[0].inProject ? 'verify-or-repair' : 'repair-project-membership',
        record,
        match: matches[0],
      });
    }
  }
  return {
    format: 'pan-todoist-import-plan',
    version: 1,
    generatedAt: new Date().toISOString(),
    actions,
    counts: Object.fromEntries(
      [...new Set(actions.map((action) => action.action))]
        .map((name) => [name, actions.filter((action) => action.action === name).length]),
    ),
  };
}

export async function applyTodoistImport(plan, store) {
  const results = [];
  let failed = false;
  for (const action of plan.actions) {
    if (action.action === 'excluded-assignee' || action.action === 'conflict') {
      results.push(action);
      if (action.action === 'conflict') failed = true;
      continue;
    }
    try {
      const result = await store.importTodoistTask(action.record);
      results.push({ ...result, plannedAction: action.action });
    } catch (error) {
      failed = true;
      results.push({
        sourceId: action.sourceId,
        outcome: 'failed',
        plannedAction: action.action,
        error: error.message,
      });
    }
  }
  return {
    format: 'pan-todoist-import-report',
    version: 1,
    completedAt: new Date().toISOString(),
    partial: failed,
    results,
  };
}

export function recoveryPlan(tasks) {
  return planLifecycleRollback(tasks);
}
