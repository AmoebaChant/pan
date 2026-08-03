const GENERIC_RUNNER_TITLE = "Pan Runner";
const MAX_TASK_TITLE_LENGTH = 60;
const TASK_PREFIX = "Pan";
const CHAT_PREFIX = "Pan Chat";
const ELLIPSIS = "…";
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g;
const WHITESPACE_RUNS = /\s+/g;

function sanitizeText(value) {
  if (value === undefined || value === null) {
    return "";
  }
  return String(value)
    .replace(CONTROL_CHARACTERS, "")
    .replace(WHITESPACE_RUNS, " ")
    .trim();
}

function truncate(value, maxLength) {
  const characters = Array.from(value);
  if (characters.length <= maxLength) {
    return value;
  }
  return `${characters.slice(0, maxLength - 1).join("").trim()}${ELLIPSIS}`;
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
  const repoShort = repoValue ? repoValue.slice(repoValue.lastIndexOf("/") + 1) : "";
  let titleText = sanitizeText(title);
  if (!titleText) {
    titleText = number ? `Task ${number}` : "Task";
  }
  titleText = truncate(titleText, MAX_TASK_TITLE_LENGTH);
  if (repoShort) {
    return `${prefix} ${repoShort}: ${titleText}`;
  }
  return `${prefix}: ${titleText}`;
}

export function formatChatSessionName(options = {}) {
  const { repository } = options ?? {};
  const repoValue = sanitizeText(repository);
  if (!repoValue) {
    return CHAT_PREFIX;
  }
  return `${CHAT_PREFIX}: ${repoValue}`;
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
