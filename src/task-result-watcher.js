export async function waitForTaskResult(
  readResult,
  {
    signal,
    pollIntervalMs = 500,
    sleep = waitForDelay,
  } = {},
) {
  while (!signal?.aborted) {
    const result = await readResult();
    if (result) {
      return result;
    }
    if (signal?.aborted) {
      break;
    }
    await sleep(pollIntervalMs, signal);
  }
  return undefined;
}

export async function waitForTaskWorkerOutcome({
  childExit,
  readResult,
  stopChild,
}) {
  const controller = new AbortController();
  const firstOutcome = await Promise.race([
    childExit.then((exit) => ({ type: "exit", exit })),
    waitForTaskResult(readResult, { signal: controller.signal }).then(
      (result) => ({ type: "result", result }),
      (error) => ({ type: "result-error", error }),
    ),
  ]);

  try {
    if (firstOutcome.type === "result" && firstOutcome.result) {
      await stopChild();
      return {
        exit: await childExit,
        result: firstOutcome.result,
      };
    }
    if (firstOutcome.type === "result-error") {
      await stopChild();
      return {
        exit: await childExit,
        resultError: firstOutcome.error,
      };
    }
    return { exit: firstOutcome.exit };
  } finally {
    controller.abort();
  }
}

async function waitForDelay(milliseconds, signal) {
  if (signal?.aborted) {
    return;
  }
  await new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    signal?.addEventListener("abort", finish, { once: true });
  });
}
