const GENERIC_RUNNER_TITLE = "Pan Runner";
const MAX_TASK_TITLE_LENGTH = 60;
const MAX_REPO_LENGTH = 40;
const MAX_SESSION_NAME_LENGTH = 120;
const MAX_SESSION_NAME_CODE_POINTS = 256;
const TASK_PREFIX = "Pan";
const CHAT_PREFIX = "Pan Chat";
const ELLIPSIS = "…";
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g;
const BIDI_CONTROLS = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
const WHITESPACE_RUNS = /\s+/g;
const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, {
  granularity: "grapheme",
});

function sanitizeText(value) {
  if (value === undefined || value === null) {
    return "";
  }
  return String(value)
    .replace(CONTROL_CHARACTERS, "")
    .replace(BIDI_CONTROLS, "")
    .replace(WHITESPACE_RUNS, " ")
    .trim();
}

function truncate(value, maxLength) {
  const clusters = [];
  for (const { segment } of GRAPHEME_SEGMENTER.segment(value)) {
    clusters.push(segment);
  }
  if (clusters.length <= maxLength) {
    return value;
  }
  return `${clusters.slice(0, maxLength - 1).join("").trim()}${ELLIPSIS}`;
}

// Backstop the code-point count: the grapheme truncate can't bound it because combining marks collapse into a single cluster.
function clampCodePoints(value, maxCodePoints) {
  const points = Array.from(value);
  if (points.length <= maxCodePoints) return value;
  return points.slice(0, maxCodePoints).join("");
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : undefined;
}

export function formatTaskSessionName(options = {}) {
  const { issueNumber, repository, title } = options ?? {};
  const number = positiveInteger(issueNumber);
  const prefix = number ? `${TASK_PREFIX} #${number}` : TASK_PREFIX;
  const repoValue = sanitizeText(repository);
  let repoShort = repoValue ? repoValue.slice(repoValue.lastIndexOf("/") + 1) : "";
  repoShort = truncate(repoShort, MAX_REPO_LENGTH);
  let titleText = sanitizeText(title);
  if (!titleText) {
    titleText = number ? `Task ${number}` : "Task";
  }
  titleText = truncate(titleText, MAX_TASK_TITLE_LENGTH);
  const result = repoShort
    ? `${prefix} ${repoShort}: ${titleText}`
    : `${prefix}: ${titleText}`;
  return clampCodePoints(truncate(result, MAX_SESSION_NAME_LENGTH), MAX_SESSION_NAME_CODE_POINTS);
}

export function formatChatSessionName(options = {}) {
  const { repository } = options ?? {};
  const repoValue = truncate(sanitizeText(repository), MAX_REPO_LENGTH);
  if (!repoValue) {
    return clampCodePoints(truncate(CHAT_PREFIX, MAX_SESSION_NAME_LENGTH), MAX_SESSION_NAME_CODE_POINTS);
  }
  return clampCodePoints(truncate(`${CHAT_PREFIX}: ${repoValue}`, MAX_SESSION_NAME_LENGTH), MAX_SESSION_NAME_CODE_POINTS);
}

export function formatRunnerWindowTitle(taskNumbers = []) {
  const numbers = [
    ...new Set(
      taskNumbers
        .map((value) => Number(value))
        .filter((value) => Number.isInteger(value) && value > 0),
    ),
  ].sort((first, second) => first - second);
  if (numbers.length === 0) {
    return GENERIC_RUNNER_TITLE;
  }
  if (numbers.length === 1) {
    return `${GENERIC_RUNNER_TITLE}: Task ${numbers[0]}`;
  }
  return `${GENERIC_RUNNER_TITLE}: Tasks ${numbers.join(", ")}`;
}

export function windowTitleSequence(title) {
  return `\u001b]0;${title}\u0007`;
}

export function createWindowTitleWriter(stream = process.stdout) {
  return (title) => {
    if (!stream?.isTTY) {
      return;
    }
    stream.write(windowTitleSequence(title));
  };
}
