import { spawn } from "node:child_process";

import { terminateProcessTree } from "./process-tree.js";

export class ProcessClient {
  async run(executable, args, options = {}) {
    const maxBuffer = options.maxBuffer ?? 10 * 1024 * 1024;
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: options.windowsHide ?? true,
    });

    return new Promise((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      let failure;
      let settled = false;
      const timeout = options.timeout
        ? setTimeout(() => {
            failure = Object.assign(new Error("Process timed out"), {
              code: "ETIMEDOUT",
            });
            void terminateProcessTree(child);
          }, options.timeout)
        : undefined;

      const append = (target, chunk) => {
        const next = target + chunk.toString("utf8");
        if (Buffer.byteLength(next) > maxBuffer && !failure) {
          failure = Object.assign(new Error("Process output exceeded maxBuffer"), {
            code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
          });
          void terminateProcessTree(child);
        }
        return next;
      };
      child.stdout.on("data", (chunk) => {
        stdout = append(stdout, chunk);
      });
      child.stderr.on("data", (chunk) => {
        stderr = append(stderr, chunk);
      });
      child.once("error", (error) => finish(error));
      child.once("close", (code, signal) => {
        if (failure) {
          finish(failure);
        } else if (code !== 0) {
          finish(
            Object.assign(
              new Error(`Process exited with code ${code}, signal ${signal}`),
              { code, signal },
            ),
          );
        } else {
          finish();
        }
      });

      function finish(error) {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        if (!error) {
          resolve(stdout.trim());
          return;
        }
        error.stdout = stdout;
        error.stderr = stderr;
        const detail = stderr.trim();
        reject(
          new Error(
            `${executable} ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`,
            { cause: error },
          ),
        );
      }
    });
  }
}
