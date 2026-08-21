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
    `${body}\n\n${marker}`,
  ]);
}
