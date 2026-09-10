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

export async function ensureIssueComment(
  runGh,
  repoSlug,
  number,
  marker,
  body,
) {
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
  if (
    pages
      .flat()
      .some((comment) => typeof comment.body === 'string' && comment.body.includes(marker))
  ) {
    return;
  }

  await runGh([
    'issue',
    'comment',
    String(number),
    '--repo',
    repoSlug,
    '--body',
    body.includes(marker) ? body : `${body}\n\n${marker}`,
  ]);
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
