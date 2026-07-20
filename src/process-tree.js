import { execFile } from "node:child_process";

export async function terminateProcessTree(childProcess) {
  if (!childProcess?.pid) {
    return;
  }
  if (process.platform !== "win32") {
    childProcess.kill("SIGKILL");
    return;
  }
  await new Promise((resolve) => {
    execFile(
      "taskkill.exe",
      ["/PID", String(childProcess.pid), "/T", "/F"],
      { windowsHide: true },
      () => resolve(),
    );
  });
}
