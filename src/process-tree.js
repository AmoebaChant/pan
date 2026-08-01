import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";

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

export async function readProcessIdentity(
  pid,
  {
    execFileImpl = execFile,
    platform = process.platform,
  } = {},
) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return undefined;
  }
  if (platform === "linux") {
    try {
      const [commandLine, stat, systemStat] = await Promise.all([
        readFile(`/proc/${pid}/cmdline`),
        readFile(`/proc/${pid}/stat`, "utf8"),
        readFile("/proc/stat", "utf8"),
      ]);
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const clockTicks = Number(fields[19]);
      const bootTime = Number(
        systemStat.match(/^btime\s+(\d+)$/m)?.[1],
      );
      return {
        commandLine: commandLine.toString("utf8").replaceAll("\0", " ").trim(),
        startedAt:
          Number.isFinite(clockTicks) && Number.isFinite(bootTime)
            ? new Date((bootTime + clockTicks / 100) * 1_000).toISOString()
            : undefined,
      };
    } catch (error) {
      if (error.code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
  }

  if (platform === "win32") {
    const script = [
      `$process = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"`,
      "if ($null -eq $process) { exit 3 }",
      "$process | Select-Object CommandLine,CreationDate | ConvertTo-Json -Compress",
    ].join("; ");
    try {
      const output = await execFileText(execFileImpl, "powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        script,
      ]);
      const value = JSON.parse(output);
      return {
        commandLine: value.CommandLine ?? "",
        startedAt: value.CreationDate
          ? new Date(value.CreationDate).toISOString()
          : undefined,
      };
    } catch (error) {
      if (error.code === 3) {
        return undefined;
      }
      throw error;
    }
  }

  try {
    const output = await execFileText(execFileImpl, "ps", [
      "-p",
      String(pid),
      "-o",
      "lstart=",
      "-o",
      "command=",
    ]);
    const startedAt = output.slice(0, 24).trim();
    return {
      commandLine: output.slice(24).trim(),
      startedAt: startedAt
        ? new Date(startedAt).toISOString()
        : undefined,
    };
  } catch (error) {
    if (error.code === 1) {
      return undefined;
    }
    throw error;
  }
}

function execFileText(execFileImpl, executable, args) {
  return new Promise((resolve, reject) => {
    execFileImpl(
      executable,
      args,
      { windowsHide: true },
      (error, stdout = "") => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stdout.trim());
      },
    );
  });
}
