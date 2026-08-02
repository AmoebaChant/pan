const GENERIC_RUNNER_TITLE = "Pan Runner";

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
