const MAX_IDLE_POLL_SECONDS = 300;
const RATE_LIMIT_BACKOFF_SECONDS = 900;

export function nextPollDelaySeconds(baseSeconds, idlePolls) {
  if (!Number.isFinite(baseSeconds) || baseSeconds <= 0) {
    throw new TypeError("baseSeconds must be positive");
  }
  if (!Number.isInteger(idlePolls) || idlePolls < 0) {
    throw new TypeError("idlePolls must be a non-negative integer");
  }
  return Math.min(
    Math.max(MAX_IDLE_POLL_SECONDS, baseSeconds),
    baseSeconds * 2 ** Math.min(idlePolls, 10),
  );
}

export function rateLimitBackoffSeconds() {
  return RATE_LIMIT_BACKOFF_SECONDS;
}

export function isRateLimitError(error, seen = new Set()) {
  if (!error || seen.has(error)) {
    return false;
  }
  seen.add(error);
  if (
    /(?:rate limit.*exceed|exceed.*rate limit|secondary rate limit)/i.test(
      `${error.message ?? ""}\n${error.stderr ?? ""}`,
    )
  ) {
    return true;
  }
  return (
    isRateLimitError(error.cause, seen) ||
    (Array.isArray(error.errors) &&
      error.errors.some((entry) => isRateLimitError(entry, seen)))
  );
}

export async function waitForNextPoll({ sleep, milliseconds, signal }) {
  if (signal?.aborted) {
    return;
  }
  if (!signal) {
    await sleep(milliseconds);
    return;
  }
  await new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", finish, { once: true });
    if (signal.aborted) {
      finish();
    }
  });
}
