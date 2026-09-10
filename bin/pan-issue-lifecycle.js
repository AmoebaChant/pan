import {
  parseCurrentActionBlock,
  renderCurrentActionBlock,
  transitionComment,
  transitionMarker,
  upsertCurrentActionBlock,
} from './pan-task-model.js';

async function readIssueState(runGh, repoSlug, number) {
  const raw = await runGh([
    'issue',
    'view',
    String(number),
    '--repo',
    repoSlug,
    '--json',
    'state,stateReason',
  ]);
  const issue = JSON.parse(raw);
  if (issue.state !== 'OPEN' && issue.state !== 'CLOSED') {
    throw new Error(`GitHub returned an invalid state for ${repoSlug}#${number}.`);
  }
  return issue;
}

export async function ensureIssueClosed(runGh, repoSlug, number) {
  const current = await readIssueState(runGh, repoSlug, number);
  if (current.state === 'CLOSED') {
    if (current.stateReason !== 'COMPLETED') {
      throw new Error(
        `${repoSlug}#${number} is closed as ${current.stateReason || 'unknown'}, not completed.`,
      );
    }

    return;
  }

  await runGh([
    'issue',
    'close',
    String(number),
    '--repo',
    repoSlug,
    '--reason',
    'completed',
  ]);

  const confirmed = await readIssueState(runGh, repoSlug, number);
  if (
    confirmed.state !== 'CLOSED' ||
    confirmed.stateReason !== 'COMPLETED'
  ) {
    throw new Error(`GitHub did not confirm closure of ${repoSlug}#${number}.`);
  }
}

export async function ensureIssueRejected(runGh, repoSlug, number) {
  const current = await readIssueState(runGh, repoSlug, number);
  if (current.state === 'CLOSED') {
    if (current.stateReason !== 'NOT_PLANNED') {
      throw new Error(
        `${repoSlug}#${number} is closed as ${current.stateReason || 'unknown'}, not not planned.`,
      );
    }
    return;
  }
  await runGh([
    'issue',
    'close',
    String(number),
    '--repo',
    repoSlug,
    '--reason',
    'not planned',
  ]);
  const confirmed = await readIssueState(runGh, repoSlug, number);
  if (
    confirmed.state !== 'CLOSED'
    || confirmed.stateReason !== 'NOT_PLANNED'
  ) {
    throw new Error(`GitHub did not confirm not-planned closure of ${repoSlug}#${number}.`);
  }
}

function commentMarkerPlacement(marker) {
  if (
    /^Pan: task transition (?:0|[1-9]\d*)$/.test(marker)
    || /^Pan: next occurrence https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/issues\/[1-9]\d*$/
      .test(marker)
  ) {
    return 'first';
  }
  if (
    /^<!-- pan-result:[A-Za-z0-9._:-]+ -->$/.test(marker)
    || /^<!-- pan-finalization-failed:[A-Za-z0-9._:-]+ -->$/.test(marker)
  ) {
    return 'last';
  }
  throw new Error(`invalid Pan Issue comment marker: ${JSON.stringify(marker)}`);
}

function markerMatch(body, marker, placement) {
  const lines = String(body ?? '').replace(/\r\n/g, '\n').trimEnd().split('\n');
  const occurrences = lines.filter((line) => line === marker).length;
  const canonical = placement === 'first'
    ? lines[0] === marker
    : lines.at(-1) === marker;
  return { occurrences, canonical: occurrences === 1 && canonical };
}

async function readIssueComments(runGh, repoSlug, number) {
  const raw = await runGh([
    'api',
    '--paginate',
    '--slurp',
    `repos/${repoSlug}/issues/${number}/comments?per_page=100`,
  ]);
  const pages = JSON.parse(raw);
  if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page))) {
    throw new Error(`GitHub returned invalid comments for ${repoSlug}#${number}.`);
  }
  return pages.flat();
}

export async function ensureIssueComment(
  runGh,
  repoSlug,
  number,
  marker,
  body,
) {
  const placement = commentMarkerPlacement(marker);
  const comments = await readIssueComments(runGh, repoSlug, number);
  const exact = [];
  for (const comment of comments) {
    const match = markerMatch(comment.body, marker, placement);
    if (match.occurrences > 0 && !match.canonical) {
      throw new Error(
        `${repoSlug}#${number} has a non-canonical placement for marker ${marker}.`,
      );
    }
    if (match.canonical) exact.push(comment);
  }
  if (exact.length > 1) {
    throw new Error(`${repoSlug}#${number} has duplicate exact marker ${marker}.`);
  }
  if (exact.length === 1) {
    return;
  }

  const markerInBody = markerMatch(body, marker, placement);
  if (markerInBody.occurrences > 0 && !markerInBody.canonical) {
    throw new Error(`comment body has a non-canonical placement for marker ${marker}.`);
  }
  const markedBody = markerInBody.canonical
    ? body
    : placement === 'first'
      ? `${marker}\n\n${body}`
      : `${body}\n\n${marker}`;
  await runGh([
    'issue',
    'comment',
    String(number),
    '--repo',
    repoSlug,
    '--body',
    markedBody,
  ]);
  const confirmed = await readIssueComments(runGh, repoSlug, number);
  const confirmedMatches = [];
  for (const comment of confirmed) {
    const match = markerMatch(comment.body, marker, placement);
    if (match.occurrences > 0 && !match.canonical) {
      throw new Error(
        `${repoSlug}#${number} has a non-canonical placement for marker ${marker}.`,
      );
    }
    if (match.canonical) confirmedMatches.push(comment);
  }
  if (confirmedMatches.length !== 1) {
    throw new Error(
      `GitHub did not verify exactly one canonical marker ${marker} for ${repoSlug}#${number}.`,
    );
  }
}

async function readIssueBody(runGh, repoSlug, number) {
  const raw = await runGh([
    'issue',
    'view',
    String(number),
    '--repo',
    repoSlug,
    '--json',
    'body',
  ]);
  const parsed = JSON.parse(raw);
  if (typeof parsed.body !== 'string') {
    throw new Error(`GitHub returned an invalid body for ${repoSlug}#${number}.`);
  }
  return parsed.body;
}

export async function updateIssueCurrentAction(
  runGh,
  repoSlug,
  number,
  {
    expectedRevision,
    revision,
    status,
    action,
    detail,
    actor,
    claimGeneration = '',
    updatedAt = new Date().toISOString(),
    fromStatus = '',
    fromAction = '',
  },
) {
  const currentBody = await readIssueBody(runGh, repoSlug, number);
  const currentBlock = parseCurrentActionBlock(currentBody);
  if (currentBlock && currentBlock.revision !== expectedRevision) {
    throw new Error(
      `${repoSlug}#${number} current-next-action revision is ${currentBlock.revision}, ` +
      `expected ${expectedRevision}.`,
    );
  }
  const block = renderCurrentActionBlock({
    status,
    action,
    detail,
    revision,
    updatedAt,
  });
  const nextBody = upsertCurrentActionBlock(currentBody, block);
  if (nextBody !== currentBody) {
    await runGh([
      'issue',
      'edit',
      String(number),
      '--repo',
      repoSlug,
      '--body',
      nextBody,
    ]);
  }
  const confirmedBody = await readIssueBody(runGh, repoSlug, number);
  const confirmedBlock = parseCurrentActionBlock(confirmedBody);
  if (
    !confirmedBlock
    || confirmedBlock.revision !== revision
    || confirmedBlock.status !== status
    || confirmedBlock.action !== action
  ) {
    throw new Error(`GitHub did not confirm the current next action for ${repoSlug}#${number}.`);
  }

  const marker = transitionMarker(revision);
  await ensureIssueComment(
    runGh,
    repoSlug,
    number,
    marker,
    transitionComment({
      revision,
      fromStatus,
      fromAction,
      toStatus: status,
      toAction: action,
      detail,
      actor,
      claimGeneration,
    }),
  );
}
