const elements = {
  connection: document.querySelector('#connection-status'),
  empty: document.querySelector('#empty-state'),
  briefing: document.querySelector('#briefing'),
  completion: document.querySelector('#completion'),
  completionSummary: document.querySelector('#completion-summary'),
  completionDetails: document.querySelector('#completion-details'),
  revision: document.querySelector('#revision'),
  summary: document.querySelector('#summary'),
  phase: document.querySelector('#phase'),
  tasks: document.querySelector('#tasks'),
  generalFeedback: document.querySelector('#general-feedback'),
  submissionMessage: document.querySelector('#submission-message'),
  submit: document.querySelector('#submit-review'),
};

let snapshot = null;
let draft = null;
let submitting = false;

function draftKey(proposal) {
  return `pan-briefing:${proposal.briefingId}:${proposal.revision}`;
}

function emptyDraft(proposal) {
  return {
    generalFeedback: '',
    tasks: Object.fromEntries(
      proposal.tasks.map((task) => [
        task.id,
        { decision: 'agree', feedback: '' },
      ]),
    ),
  };
}

function normalizeDraft(proposal, saved) {
  const normalized = emptyDraft(proposal);
  normalized.generalFeedback = saved?.generalFeedback ?? '';
  for (const task of proposal.tasks) {
    const previous = saved?.tasks?.[task.id];
    if (!previous) continue;
    normalized.tasks[task.id] = {
      decision: previous.decision === 'disagree' ? 'disagree' : 'agree',
      feedback: previous.feedback ?? '',
    };
  }
  return normalized;
}

function loadDraft(proposal) {
  try {
    const stored = localStorage.getItem(draftKey(proposal));
    if (stored) return normalizeDraft(proposal, JSON.parse(stored));
  } catch {
    // A private browsing policy may disable local storage; the page still works in memory.
  }
  return emptyDraft(proposal);
}

function saveDraft() {
  if (!snapshot?.proposal || !draft) return;
  try {
    localStorage.setItem(draftKey(snapshot.proposal), JSON.stringify(draft));
  } catch {
    // The current in-memory draft remains usable.
  }
}

function needsRevision() {
  if (!snapshot?.proposal || !draft) return false;
  if (draft.generalFeedback.trim()) return true;
  return snapshot.proposal.tasks.some(
    (task) => draft.tasks[task.id]?.decision === 'disagree',
  );
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function formatDate(value) {
  if (!value) return 'unscheduled';
  const date = new Date(`${value}T12:00:00`);
  if (Number.isNaN(date.valueOf())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
  }).format(date);
}

function displayReason(reason) {
  if (!reason) return '';
  return reason.replace(
    /^accepted\b(?:\s*[:—-]\s*)?/i,
    'Pan incorporated your feedback: ',
  );
}

function completionItemText(item) {
  if (typeof item === 'string') return item;
  return item?.title || item?.name || item?.message || '';
}

function completionList(title, items, renderItem = null) {
  if (!Array.isArray(items) || items.length === 0) return null;
  const section = element('section', 'completion-section');
  section.append(element('h3', null, `${title} (${items.length})`));
  const list = element('ul');
  for (const item of items) {
    const row = element('li');
    if (renderItem) {
      renderItem(row, item);
    } else {
      row.textContent = completionItemText(item);
    }
    list.append(row);
  }
  section.append(list);
  return section;
}

function renderCompletion(result) {
  const completion = result && typeof result === 'object' ? result : {};
  elements.completionSummary.textContent = completion.summary
    || completion.message
    || 'The approved plan has been applied and verified.';

  const sections = [
    completionList('Today', completion.today),
    completionList(
      'Planning guidance updated',
      completion.planningGuidanceUpdated,
      (row, item) => {
        const title = completionItemText(item);
        row.append(element('strong', null, title));
        if (item?.guidance) {
          row.append(document.createTextNode(` — ${item.guidance}`));
        }
      },
    ),
    completionList(
      'Agent attention',
      completion.agentAttention,
      (row, item) => {
        const title = completionItemText(item);
        if (item?.url) {
          const link = element('a', null, title);
          link.href = item.url;
          row.append(link);
        } else {
          row.append(element('strong', null, title));
        }
        const detail = item?.instruction || item?.status;
        if (detail) row.append(document.createTextNode(` — ${detail}`));
      },
    ),
  ].filter(Boolean);

  elements.completionDetails.replaceChildren(...sections);
}

function taskGroup(task) {
  if (task.group === 'today' || task.group === 'not-today') return task.group;
  return task.proposedDate && task.proposedDate === snapshot.proposal.today
    ? 'today'
    : 'not-today';
}

function radioChoice(name, value, label, checked, disabled) {
  const wrapper = element('label', 'choice');
  wrapper.title = label;
  const input = document.createElement('input');
  input.type = 'radio';
  input.name = name;
  input.value = value;
  input.checked = checked;
  input.disabled = disabled;
  input.setAttribute('aria-label', label);
  wrapper.append(input);
  return { wrapper, input };
}

function renderTask(task, index) {
  const waiting = snapshot.phase === 'review-submitted';
  const taskDraft = draft.tasks[task.id] ?? { decision: 'agree', feedback: '' };
  draft.tasks[task.id] = taskDraft;

  const row = element('article', 'task-row');
  const main = element('div', 'task-main');
  const copy = element('div', 'task-copy');
  const titleLine = element('div', 'task-title-line');
  titleLine.append(element('h3', 'task-title', task.title));
  copy.append(titleLine);
  if (task.reason) copy.append(element('p', 'reason', displayReason(task.reason)));
  if (task.planningGuidance) {
    const guidance = element('p', 'planning-guidance');
    guidance.append(
      element('strong', null, 'Guidance: '),
      document.createTextNode(task.planningGuidance),
    );
    copy.append(guidance);
  }
  if (task.feedbackResponse) {
    const response = element('p', 'feedback-response');
    response.append(
      element('strong', null, 'Pan’s response: '),
      document.createTextNode(task.feedbackResponse),
    );
    copy.append(response);
  }
  const meta = taskGroup(task) === 'today'
    ? 'Planned for today'
    : task.proposedDate
      ? `Proposed date: ${formatDate(task.proposedDate)}`
      : 'Reconsidered in every daily briefing';
  copy.append(element('div', 'task-meta', meta));

  const radioName = `task-${index}`;
  const agree = radioChoice(
    radioName,
    'agree',
    `Agree with the recommendation for ${task.title}`,
    taskDraft.decision === 'agree',
    waiting,
  );
  const disagree = radioChoice(
    radioName,
    'disagree',
    `Disagree with the recommendation for ${task.title}`,
    taskDraft.decision === 'disagree',
    waiting,
  );
  main.append(copy, agree.wrapper, disagree.wrapper);
  row.append(main);

  const feedbackRow = element('div', 'feedback-row');
  const feedback = document.createElement('textarea');
  feedback.rows = 2;
  feedback.placeholder = 'What should Pan reconsider? For example: next week, or on a quiet day.';
  feedback.value = taskDraft.feedback;
  feedback.disabled = waiting;
  feedback.setAttribute('aria-label', `Feedback about ${task.title}`);
  feedbackRow.append(feedback);
  feedbackRow.hidden = taskDraft.decision !== 'disagree';
  row.append(feedbackRow);

  agree.input.addEventListener('change', () => {
    taskDraft.decision = 'agree';
    feedbackRow.hidden = true;
    changed();
  });
  disagree.input.addEventListener('change', () => {
    taskDraft.decision = 'disagree';
    feedbackRow.hidden = false;
    feedback.focus();
    changed();
  });
  feedback.addEventListener('input', () => {
    taskDraft.feedback = feedback.value;
    changed();
  });

  return row;
}

function columnHeadings() {
  const headings = element('div', 'column-headings');
  headings.setAttribute('aria-hidden', 'true');
  headings.append(
    element('span', null, 'Recommendation'),
    element('span', null, 'Agree'),
    element('span', null, 'Disagree'),
  );
  return headings;
}

function renderGroup(group, label) {
  const tasks = snapshot.proposal.tasks.filter((task) => taskGroup(task) === group);
  const section = element('section', `task-group task-group-${group}`);
  const heading = element('div', 'group-heading');
  heading.append(
    element('h2', null, label),
    element('span', 'group-count', String(tasks.length)),
  );
  section.append(heading, columnHeadings());
  const list = element('div', 'task-list');
  if (tasks.length === 0) {
    list.append(element('p', 'empty-group', `No tasks are recommended for ${label.toLowerCase()}.`));
  } else {
    list.append(...tasks.map((task) => renderTask(
      task,
      snapshot.proposal.tasks.indexOf(task),
    )));
  }
  section.append(list);
  return section;
}

function changed() {
  saveDraft();
  elements.submit.textContent = needsRevision() ? 'Send feedback' : 'Approve';
  elements.submissionMessage.textContent = needsRevision()
    ? 'Your complete markup will be sent together.'
    : 'All recommendations are accepted.';
}

function render(nextSnapshot) {
  const previousRevision = snapshot?.proposal
    ? `${snapshot.proposal.briefingId}:${snapshot.proposal.revision}`
    : null;
  snapshot = nextSnapshot;
  const nextRevision = snapshot?.proposal
    ? `${snapshot.proposal.briefingId}:${snapshot.proposal.revision}`
    : null;

  elements.empty.hidden = snapshot.phase !== 'empty';
  elements.briefing.hidden = !snapshot.proposal || snapshot.phase === 'complete';
  elements.completion.hidden = snapshot.phase !== 'complete';

  if (snapshot.phase === 'complete') {
    elements.revision.textContent = 'Complete';
    elements.phase.textContent = 'Plan confirmed';
    elements.submit.disabled = true;
    elements.submit.textContent = 'Complete';
    renderCompletion(snapshot.completion);
    return;
  }
  if (!snapshot.proposal) {
    elements.submit.disabled = true;
    return;
  }

  if (previousRevision !== nextRevision || !draft) draft = loadDraft(snapshot.proposal);
  const waiting = snapshot.phase === 'review-submitted';
  elements.revision.textContent = `Revision ${snapshot.proposal.revision}`;
  elements.summary.textContent = snapshot.proposal.summary || '';
  elements.phase.textContent = waiting ? 'Pan is thinking…' : 'Ready';
  elements.generalFeedback.value = draft.generalFeedback;
  elements.generalFeedback.disabled = waiting;
  elements.tasks.replaceChildren(
    renderGroup('today', 'Today'),
    renderGroup('not-today', 'Not today'),
  );
  elements.submit.disabled = submitting || waiting;
  elements.submit.textContent = waiting
    ? 'Submitted'
    : needsRevision()
      ? 'Send feedback'
      : 'Approve';
  elements.submissionMessage.textContent = waiting
    ? 'Your review was delivered. Pan is preparing the next revision.'
    : needsRevision()
      ? 'Your complete markup will be sent together.'
      : 'All recommendations are accepted.';
}

function reviewPayload(action) {
  return {
    briefingId: snapshot.proposal.briefingId,
    revision: snapshot.proposal.revision,
    action,
    proposal: snapshot.proposal,
    generalFeedback: draft.generalFeedback.trim(),
    tasks: snapshot.proposal.tasks.map((task) => ({
      id: task.id,
      recommendation: task.recommendation ?? null,
      proposedDate: task.proposedDate ?? null,
      decision: draft.tasks[task.id]?.decision === 'disagree' ? 'disagree' : 'accept',
      requestedDate: null,
      feedback: draft.tasks[task.id]?.decision === 'disagree'
        ? draft.tasks[task.id]?.feedback.trim() || null
        : null,
    })),
  };
}

async function submit() {
  if (!snapshot?.proposal || submitting) return;
  const action = needsRevision() ? 'revise' : 'approve';
  submitting = true;
  render(snapshot);
  let submissionError = null;
  try {
    const response = await fetch(
      `/api/briefings/${encodeURIComponent(snapshot.proposal.briefingId)}/review`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reviewPayload(action)),
      },
    );
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || 'Review submission failed');
    try {
      localStorage.removeItem(draftKey(snapshot.proposal));
    } catch {
      // No cleanup is required when local storage is unavailable.
    }
    render(body);
  } catch (error) {
    submissionError = error.message;
  } finally {
    submitting = false;
    if (snapshot) render(snapshot);
    if (submissionError) elements.submissionMessage.textContent = submissionError;
  }
}

elements.generalFeedback.addEventListener('input', () => {
  draft.generalFeedback = elements.generalFeedback.value;
  changed();
});
elements.submit.addEventListener('click', submit);

async function load() {
  const response = await fetch('/api/briefing', { cache: 'no-store' });
  if (!response.ok) throw new Error('Could not load the briefing service');
  render(await response.json());
}

function connectEvents() {
  const events = new EventSource('/api/events');
  events.addEventListener('open', () => {
    elements.connection.textContent = 'Connected';
  });
  events.addEventListener('error', () => {
    elements.connection.textContent = 'Reconnecting';
  });
  events.addEventListener('briefing', (event) => {
    render(JSON.parse(event.data));
  });
}

load()
  .then(connectEvents)
  .catch((error) => {
    elements.connection.textContent = 'Offline';
    elements.empty.querySelector('p').textContent = error.message;
  });
