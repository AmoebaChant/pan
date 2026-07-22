import { execFile } from "node:child_process";

export async function terminateProcessTree(childProcess, options = {}) {
  if (!childProcess?.pid) {
    return;
  }
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    childProcess.kill("SIGKILL");
    return;
  }
  await terminateProcessByPid(childProcess.pid, { ...options, platform });
}

export async function terminateProcessByPid(
  pid,
  {
    execFileImpl = execFile,
    isAlive = processIsAlive,
    kill = process.kill.bind(process),
    platform = process.platform,
    sleep = (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
  } = {},
) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return;
  }
  if (!isAlive(pid)) {
    return;
  }
  let terminationError;
  if (platform !== "win32") {
    try {
      kill(pid, "SIGTERM");
    } catch (error) {
      if (error.code !== "ESRCH") {
        terminationError = error;
      }
    }
  } else {
    terminationError = await new Promise((resolve) => {
      execFileImpl(
        "taskkill.exe",
        ["/PID", String(pid), "/T", "/F"],
        { windowsHide: true },
        (error) => resolve(error),
      );
    });
  }
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (!isAlive(pid)) {
      return;
    }
    await sleep(100);
  }
  throw new Error(`Process ${pid} did not stop`, {
    cause: terminationError,
  });
}

export function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}
