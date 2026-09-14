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
    || 'The approved plan has been checked.';
  const heading = elements.completion.querySelector('h2');
  heading.textContent = completion.status === 'confirmed'
    ? 'Briefing actions confirmed'
    : completion.status === 'partial'
      ? 'Briefing partially applied'
      : 'Briefing could not be applied';

  const sections = [
    completionList('Confirmed human plan', completion.confirmedHumanPlan),
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
    ...[
      ['Agents launched', completion.agentsLaunched],
      ['Agents queued', completion.agentsQueued],
      ['Waiting workers', completion.waitingWorkers],
      ['Partial failures', completion.partialFailures],
      ['Agent attention', completion.agentAttention],
    ].map(([title, items]) => completionList(
      title,
      items,
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
    )),
  ].filter(Boolean);

  elements.completionDetails.replaceChildren(...sections);
}

function taskGroup(task) {
  if (['today', 'agent-starts', 'needs-attention', 'not-today'].includes(task.group)) {
    return task.group;
  }
  return task.proposedDate && task.proposedDate === snapshot.proposal.today
    ? 'today'
    : 'not-today';
}

function humanDateEffect(task) {
  if (task.humanDateAction === 'set') {
    return `Human date: set to ${formatDate(task.proposedDate)}`;
  }
  if (task.humanDateAction === 'clear') return 'Human date: clear';
  if (task.humanDateAction === 'keep') return 'Human date: unchanged';
  if (taskGroup(task) === 'today') return 'Human date: set to today';
  if (taskGroup(task) === 'not-today') {
    return task.proposedDate
      ? `Human date: set to ${formatDate(task.proposedDate)}`
      : 'Human date: clear';
  }
  return 'Human date: unchanged';
}

function agentEffect(task) {
  const kind = task.agentAction === 'request-new'
    ? 'new conversation'
    : task.agentAction === 'request-resume'
      ? 'existing session resume'
      : null;
  if (!kind) return null;
  if (task.agentAuthorization === 'standing') {
    return `Agent: ${kind} request is standing-authorized and does not await this approval`;
  }
  if (task.agentAuthorization === 'already-requested') {
    return `Agent: ${kind} request is already queued`;
  }
  if (task.agentAction === 'request-new') {
    return 'Agent: request a new conversation if this proposal is approved';
  }
  return 'Agent: request the existing session to resume if this proposal is approved';
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
  const title = element('h3', 'task-title');
  if (task.url) {
    const link = element('a', null, task.title);
    link.href = task.url;
    title.append(link);
  } else {
    title.textContent = task.title;
  }
  titleLine.append(title);
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
  const effects = element('div', 'task-effects');
  effects.append(element('span', 'effect-pill', humanDateEffect(task)));
  const agent = agentEffect(task);
  if (agent) {
    effects.append(element('span', 'effect-pill effect-agent', agent));
  }
  if (task.checkpointPriority && task.checkpointPriority !== 'none') {
    effects.append(element(
      'span',
      'effect-pill effect-checkpoint',
      `Checkpoint: ${task.checkpointPriority === 'today' ? 'prioritize today' : 'leave for later'}`,
    ));
  }
  copy.append(effects);
  if (task.playbook || task.workMode) {
    copy.append(element('p', 'task-detail', `Mode: ${task.playbook || task.workMode}`));
  }
  if (task.expectedOutcome) {
    copy.append(element('p', 'task-detail', `Expected outcome: ${task.expectedOutcome}`));
  }
  if (task.laterHumanCheckpoint) {
    copy.append(element('p', 'task-detail', `Later human checkpoint: ${task.laterHumanCheckpoint}`));
  }
  if (task.requestedHumanAction) {
    copy.append(element('p', 'task-detail', `Requested action: ${task.requestedHumanAction}`));
  }
  if (task.terminalContext) {
    copy.append(element('p', 'task-detail', `Worker terminal: ${task.terminalContext}`));
  }

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
    const completionStatus = snapshot.completion?.status;
    elements.revision.textContent = 'Complete';
    elements.phase.textContent = completionStatus === 'confirmed'
      ? 'Actions confirmed'
      : completionStatus === 'partial'
        ? 'Partially applied'
        : 'Apply failed';
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
    renderGroup('today', 'Your Today plan'),
    renderGroup('agent-starts', 'Proposed agent starts'),
    renderGroup('needs-attention', 'Needs your attention'),
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
      humanDateAction: task.humanDateAction ?? null,
      agentAction: task.agentAction ?? 'none',
      checkpointPriority: task.checkpointPriority ?? 'none',
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
