const viewDefinitions = [
  ['today', 'Today', 'Explicitly agreed human attention for today.'],
  ['needs-me', 'Needs me', 'Exact human checkpoints not already committed to Today.'],
  ['in-motion', 'In motion', 'AI-ready, AI-executing, and external-waiting outcomes.'],
  ['recent', 'Recent activity', 'Quiet terminal history. Nothing here needs clearing.'],
  ['all', 'All tasks', 'The complete canonical task set.'],
];

const elements = {
  binding: document.querySelector('#binding'),
  serviceStatus: document.querySelector('#service-status'),
  refresh: document.querySelector('#refresh'),
  showCapture: document.querySelector('#show-capture'),
  views: document.querySelector('#views'),
  eyebrow: document.querySelector('#eyebrow'),
  viewTitle: document.querySelector('#view-title'),
  viewDescription: document.querySelector('#view-description'),
  search: document.querySelector('#search'),
  error: document.querySelector('#error'),
  list: document.querySelector('#task-list'),
  detailPane: document.querySelector('#detail-pane'),
  detailEmpty: document.querySelector('#detail-empty'),
  detail: document.querySelector('#detail'),
  captureDialog: document.querySelector('#capture-dialog'),
  captureForm: document.querySelector('#capture-form'),
  captureError: document.querySelector('#capture-error'),
  captureSubmit: document.querySelector('#capture-submit'),
};

let snapshot = null;
let selectedId = null;
let selectedDetail = null;
let currentView = localStorage.getItem('pan-task-view') || 'today';
let busy = false;

function isTerminalStatus(status) {
  return status === 'done' || status === 'rejected';
}

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function labelText(value) {
  return String(value || '').replaceAll('-', ' ');
}

function formatDate(value) {
  if (!value) return 'Unscheduled';
  const date = new Date(`${value}T12:00:00`);
  if (Number.isNaN(date.valueOf())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: value.slice(0, 4) === snapshot.today.slice(0, 4) ? undefined : 'numeric',
  }).format(date);
}

function showError(message) {
  elements.error.hidden = !message;
  elements.error.textContent = message || '';
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    cache: 'no-store',
    ...options,
    headers: options.body
      ? { 'Content-Type': 'application/json', ...(options.headers || {}) }
      : options.headers,
  });
  let body;
  try {
    body = await response.json();
  } catch {
    body = { error: `Service returned HTTP ${response.status}` };
  }
  if (!response.ok) {
    const error = new Error(body.error || `Request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return body;
}

function taskById(id) {
  return snapshot?.tasks.find((task) => task.id === id) || null;
}

function tasksForView() {
  if (!snapshot) return [];
  const ids = snapshot.views[currentView] || [];
  const query = elements.search.value.trim().toLowerCase();
  return ids
    .map(taskById)
    .filter(Boolean)
    .filter((task) => !query || [
      task.title,
      task.nextActionDetail,
      task.workstream,
      task.status,
      task.nextAction,
    ].some((value) => String(value || '').toLowerCase().includes(query)));
}

function renderViews() {
  elements.views.replaceChildren(...viewDefinitions.map(([id, label]) => {
    const button = node('button', `view-button${currentView === id ? ' active' : ''}`);
    button.type = 'button';
    const count = snapshot?.views[id]?.length ?? 0;
    button.append(node('span', null, label), node('span', 'view-count', String(count)));
    button.addEventListener('click', () => {
      currentView = id;
      localStorage.setItem('pan-task-view', id);
      render();
    });
    return button;
  }));
}

function statusPill(task) {
  const pill = node('span', `pill pill-${task.status}`, labelText(task.status));
  pill.title = `Next action: ${labelText(task.nextAction)}`;
  return pill;
}

function renderTask(task) {
  const card = node('button', `task-card${selectedId === task.id ? ' selected' : ''}`);
  card.type = 'button';
  const heading = node('div', 'task-card-heading');
  const title = node('h2', null, task.title);
  heading.append(title, statusPill(task));
  const action = node('p', 'task-action', task.nextActionDetail || `Next: ${labelText(task.nextAction)}`);
  const meta = node('div', 'task-meta');
  meta.append(
    node('span', `priority priority-${task.priority}`, task.priority),
    node('span', null, task.nextActionDate
      ? `${task.overdue ? 'Overdue · ' : ''}${formatDate(task.nextActionDate)}`
      : 'Unscheduled'),
  );
  if (task.workstream) meta.append(node('span', null, task.workstream));
  if (task.workerState && task.workerState !== 'idle' && task.workerState !== 'stopped') {
    meta.append(node('span', 'worker-meta', `Worker ${labelText(task.workerState)}`));
  }
  card.append(heading, action, meta);
  card.addEventListener('click', () => selectTask(task.id));
  return card;
}

function renderList() {
  const tasks = tasksForView();
  if (!tasks.length) {
    const empty = node('section', 'empty-list');
    empty.append(
      node('h2', null, elements.search.value ? 'No matching tasks' : 'Nothing here'),
      node('p', null, currentView === 'recent'
        ? 'Recent completions will appear quietly here.'
        : 'Use Capture to create a stable outcome.'),
    );
    elements.list.replaceChildren(empty);
    return;
  }
  elements.list.replaceChildren(...tasks.map(renderTask));
}

function field(label, control) {
  const wrapper = node('label', 'detail-field');
  wrapper.append(node('span', null, label), control);
  return wrapper;
}

function input(name, value, type = 'text') {
  const control = document.createElement('input');
  control.name = name;
  control.type = type;
  control.value = value || '';
  return control;
}

function select(name, value, options) {
  const control = document.createElement('select');
  control.name = name;
  for (const optionValue of options) {
    const option = node('option', null, labelText(optionValue));
    option.value = optionValue;
    option.selected = value === optionValue;
    control.append(option);
  }
  return control;
}

function canMutateWorker(detail) {
  return !['starting', 'running', 'waiting-human', 'uncertain'].includes(detail.workerState)
    && !detail.claimedBy
    && !detail.leaseUntil;
}

function actionButton(label, operation, className = 'ghost', extra = () => ({})) {
  const button = node('button', `button ${className}`, label);
  button.type = 'button';
  button.disabled = busy;
  button.addEventListener('click', async () => {
    const payload = extra();
    if (payload === null) return;
    await mutate(operation, payload);
  });
  return button;
}

function renderHistory(detail) {
  const section = node('section', 'detail-section');
  section.append(node('h3', null, `History (${detail.comments.length})`));
  const list = node('div', 'history-list');
  for (const comment of [...detail.comments].reverse()) {
    const row = node('article', 'history-row');
    const heading = node('div', 'history-heading');
    heading.append(
      node('strong', null, comment.author || 'unknown'),
      node('time', null, new Date(comment.createdAt).toLocaleString()),
    );
    const body = node('p', null, comment.body);
    row.append(heading, body);
    list.append(row);
  }
  section.append(list);
  return section;
}

function renderArtifacts(detail) {
  const section = node('section', 'detail-section');
  section.append(node('h3', null, `Artifacts (${detail.artifacts.length})`));
  if (!detail.artifacts.length) {
    section.append(node('p', 'muted', 'No linked GitHub artifacts found in task history.'));
  } else {
    const list = node('ul', 'artifact-list');
    for (const artifact of detail.artifacts) {
      const item = node('li');
      const link = node('a', null, artifact.url);
      link.href = artifact.url;
      link.target = '_blank';
      link.rel = 'noreferrer';
      item.append(link);
      list.append(item);
    }
    section.append(list);
  }
  return section;
}

function renderDetail(detail) {
  elements.detailEmpty.hidden = true;
  elements.detail.hidden = false;
  const header = node('div', 'detail-header');
  const copy = node('div');
  copy.append(node('p', 'eyebrow', `${detail.repo} #${detail.number}`), node('h2', null, detail.title));
  const link = node('a', 'button ghost', 'Open Issue');
  link.href = detail.url;
  link.target = '_blank';
  link.rel = 'noreferrer';
  const headerActions = node('div', 'top-actions');
  const close = node('button', 'button ghost detail-close', 'Close');
  close.type = 'button';
  close.addEventListener('click', () => {
    selectedId = null;
    selectedDetail = null;
    elements.detail.hidden = true;
    elements.detailEmpty.hidden = false;
    elements.detailEmpty.querySelector('h2').textContent = 'Select a task';
    renderList();
  });
  headerActions.append(link, close);
  header.append(copy, headerActions);

  const actionBox = node('section', 'current-action');
  actionBox.append(
    node('div', 'current-action-heading', `${labelText(detail.status)} · ${labelText(detail.nextAction)}`),
    node('p', null, detail.nextActionDetail || 'No valid current-next-action detail.'),
  );
  if (detail.bodyConflict) actionBox.append(node('p', 'error-inline', detail.bodyConflict));

  if (!canMutateWorker(detail)) {
    const live = node('section', 'worker-callout');
    live.append(
      node('strong', null, `Worker ${labelText(detail.workerState || 'active')}`),
      node('p', null, detail.machine
        ? `Continue this checkpoint honestly in the worker terminal on ${detail.machine}. Browser chat is not connected to that session.`
        : 'A live or uncertain worker owns this task. Continue in its terminal or checkpoint it first.'),
    );
    actionBox.append(live);
  }

  const form = node('form', 'detail-form');
  const title = input('title', detail.title);
  title.maxLength = 256;
  const details = document.createElement('textarea');
  details.name = 'details';
  details.rows = 7;
  details.value = detail.details || '';
  const currentActionDetail = input('currentActionDetail', detail.nextActionDetail);
  currentActionDetail.maxLength = 2000;
  const status = select('status', detail.status, [
    'ready-for-human', 'ready-for-ai', 'ai-executing',
    'external-waiting', 'deliberate-hold', 'done', 'rejected',
  ]);
  const nextAction = select('nextAction', detail.nextAction, [
    'clarify', 'discuss', 'approve', 'review', 'act',
    'execute', 'wait', 'hold', 'none',
  ]);
  status.disabled = true;
  nextAction.disabled = true;
  const priority = select('priority', detail.priority, ['urgent', 'high', 'normal', 'low']);
  const authorization = select(
    'executionAuthorized',
    detail.executionAuthorized,
    ['no', 'yes'],
  );
  const grid = node('div', 'form-grid');
  grid.append(
    field('Priority', priority),
    field('Workstream', input('workstream', detail.workstream)),
    field('Attention date', input('nextActionDate', detail.nextActionDate, 'date')),
    field('Deadline', input('deadline', detail.deadline, 'date')),
    field('State', status),
    field('Next action', nextAction),
    field('AI authorized', authorization),
    field('Playbook', input('playbook', detail.playbook)),
  );
  const dependencies = document.createElement('textarea');
  dependencies.name = 'dependencies';
  dependencies.rows = 2;
  dependencies.value = detail.dependencies || '';
  form.append(
    field('Title', title),
    field('Details', details),
    grid,
    field('Current action detail', currentActionDetail),
    field('Dependencies', dependencies),
  );
  const save = node('button', 'button primary', 'Save checked edit');
  save.type = 'submit';
  save.disabled = busy || !canMutateWorker(detail);
  form.append(save);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const values = new FormData(form);
    await mutate('edit', {
      changes: {
        ...Object.fromEntries([...values.entries()].map(([key, value]) => [key, value])),
        status: detail.status,
        nextAction: detail.nextAction,
      },
    });
  });

  const actions = node('section', 'detail-section');
  actions.append(node('h3', null, 'Actions'));
  const actionRow = node('div', 'action-row');
  if (canMutateWorker(detail) && !isTerminalStatus(detail.status)) {
    actionRow.append(
      actionButton(
        detail.nextActionDate === snapshot.today ? 'Unselect Today' : 'Select Today',
        'defer',
        'ghost',
        () => {
          const selecting = detail.nextActionDate !== snapshot.today;
          if (!confirm(selecting
            ? 'Explicitly commit human attention to this task today?'
            : 'Remove this task from today’s explicit commitment?')) {
            return null;
          }
          return {
            date: selecting ? snapshot.today : '',
            detail: selecting
              ? 'Explicitly selected for Today.'
              : 'Removed from the explicit Today commitment.',
          };
        },
      ),
      actionButton('Hand to AI', 'handoff-ai', 'secondary', () => ({
        detail: prompt('What exact AI step is authorized?', detail.nextActionDetail) || detail.nextActionDetail,
      })),
      actionButton('Needs human', 'handoff-human', 'ghost', () => {
        const action = prompt('Exact action: clarify, discuss, approve, review, or act', 'clarify');
        if (!action) return null;
        const actionDetail = prompt('What exactly is needed?', detail.nextActionDetail);
        if (!actionDetail) return null;
        return { action, detail: actionDetail };
      }),
      actionButton('Wait externally', 'external-wait', 'ghost', () => {
        const reason = prompt('What external event are we waiting for?', detail.nextActionDetail);
        return reason ? { detail: reason } : null;
      }),
      actionButton('Hold', 'hold', 'ghost', () => {
        const reason = prompt('Why are you deliberately holding this outcome?', detail.nextActionDetail);
        return reason ? { detail: reason } : null;
      }),
      actionButton('Defer', 'defer', 'ghost', () => {
        const date = prompt('Attention date (YYYY-MM-DD), or empty for unscheduled', detail.nextActionDate);
        if (date === null) return null;
        return { date, detail: 'Human attention schedule explicitly updated.' };
      }),
      actionButton('Finish', 'finish', 'success', () => {
        if (!confirm('Mark the whole outcome complete?')) return null;
        return {
          detail: detail.recurring
            ? 'Occurrence complete; the cadence-derived successor was created or verified.'
            : 'Outcome explicitly completed.',
        };
      }),
      actionButton('Reject', 'reject', 'danger', () =>
        confirm('Reject this outcome as not planned?') ? { detail: 'Outcome explicitly rejected.' } : null),
    );
  } else if (isTerminalStatus(detail.status)) {
    actions.append(node('p', 'muted', 'Terminal history is informational and not clearable.'));
  }
  actions.append(actionRow);

  const facts = node('section', 'detail-section');
  facts.append(node('h3', null, 'Runtime and schedule'));
  const factsGrid = node('dl', 'facts-grid');
  const pairs = [
    ['Revision', detail.revision],
    ['Worker', labelText(detail.workerState || 'idle')],
    ['Machine / slot', detail.machine || 'Unassigned'],
    ['Session', detail.sessionId || 'None'],
    ['Attention', detail.nextActionDate ? formatDate(detail.nextActionDate) : 'Unscheduled'],
    ['Deadline', detail.deadline ? formatDate(detail.deadline) : 'None'],
  ];
  for (const [term, value] of pairs) {
    factsGrid.append(node('dt', null, term), node('dd', null, String(value)));
  }
  facts.append(factsGrid);

  elements.detail.replaceChildren(
    header,
    actionBox,
    form,
    actions,
    facts,
    renderArtifacts(detail),
    renderHistory(detail),
  );
}

async function selectTask(id) {
  selectedId = id;
  renderList();
  elements.detail.hidden = true;
  elements.detailEmpty.hidden = false;
  elements.detailEmpty.querySelector('h2').textContent = 'Loading…';
  try {
    selectedDetail = await api(`/api/tasks/${encodeURIComponent(id)}`);
    renderDetail(selectedDetail);
  } catch (error) {
    showError(error.message);
  }
}

async function mutate(operation, payload = {}) {
  if (!selectedDetail || busy) return;
  busy = true;
  showError('');
  try {
    selectedDetail = await api(
      `/api/tasks/${encodeURIComponent(selectedDetail.id)}/actions`,
      {
        method: 'POST',
        body: JSON.stringify({
          revision: selectedDetail.revision,
          projection: selectedDetail.projection,
          operation,
          ...payload,
        }),
      },
    );
    await loadTasks({ keepSelection: true });
    renderDetail(selectedDetail);
  } catch (error) {
    showError(error.status === 409
      ? `${error.message} Refresh to review the live task before retrying.`
      : error.message);
  } finally {
    busy = false;
    if (selectedDetail) renderDetail(selectedDetail);
  }
}

function render() {
  renderViews();
  const definition = viewDefinitions.find(([id]) => id === currentView) || viewDefinitions[0];
  elements.eyebrow.textContent = snapshot
    ? `${snapshot.domainRepo} · Project ${snapshot.project}`
    : '';
  elements.viewTitle.textContent = definition[1];
  elements.viewDescription.textContent = definition[2];
  renderList();
}

async function loadTasks({ keepSelection = false } = {}) {
  elements.serviceStatus.textContent = 'Refreshing';
  const next = await api('/api/tasks');
  snapshot = next;
  elements.binding.textContent = `${next.domainRepo} · ${next.today}`;
  elements.serviceStatus.textContent = 'Live';
  showError('');
  if (!keepSelection && selectedId && !taskById(selectedId)) {
    selectedId = null;
    selectedDetail = null;
  }
  render();
}

elements.search.addEventListener('input', renderList);
elements.refresh.addEventListener('click', async () => {
  try {
    await loadTasks({ keepSelection: true });
    if (selectedId) await selectTask(selectedId);
  } catch (error) {
    elements.serviceStatus.textContent = 'Error';
    showError(error.message);
  }
});
elements.showCapture.addEventListener('click', () => {
  elements.captureError.hidden = true;
  elements.captureDialog.showModal();
});
elements.captureForm.addEventListener('submit', async (event) => {
  if (event.submitter?.value === 'cancel') return;
  event.preventDefault();
  const values = Object.fromEntries(new FormData(elements.captureForm));
  const recurrence = values.recurrenceRule || values.recurrenceOccurrence
    ? { rule: values.recurrenceRule, occurrence: values.recurrenceOccurrence }
    : null;
  elements.captureSubmit.disabled = true;
  try {
    const created = await api('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({
        title: values.title,
        details: values.details,
        priority: values.priority,
        workstream: values.workstream,
        nextActionDate: values.nextActionDate,
        deadline: values.deadline,
        currentActionDetail: values.currentActionDetail,
        recurrence,
      }),
    });
    elements.captureDialog.close();
    elements.captureForm.reset();
    await loadTasks();
    await selectTask(created.id);
  } catch (error) {
    elements.captureError.hidden = false;
    elements.captureError.textContent = error.message;
  } finally {
    elements.captureSubmit.disabled = false;
  }
});

loadTasks()
  .catch((error) => {
    elements.serviceStatus.textContent = 'Offline';
    showError(error.message);
  });
