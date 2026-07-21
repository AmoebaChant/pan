import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { format } from "node:util";
import { once } from "node:events";

export async function createServiceLogger({
  name,
  logFile,
  consoleTarget = console,
  now = () => new Date(),
}) {
  if (!name?.trim()) {
    throw new TypeError("logger name is required");
  }
  let stream;
  if (logFile) {
    await mkdir(path.dirname(logFile), { recursive: true });
    stream = createWriteStream(logFile, { flags: "a" });
    await once(stream, "open");
    stream.on("error", (error) => {
      const line = `${now().toISOString()} [${name}] ERROR File logging failed: ${format(error)}`;
      consoleTarget.error?.call(consoleTarget, line);
      stream = undefined;
    });
  }

  const write = (level, args) => {
    const line = `${now().toISOString()} [${name}] ${level.toUpperCase()} ${format(...args)}`;
    const consoleMethod =
      level === "error"
        ? consoleTarget.error
        : level === "warn"
          ? consoleTarget.warn
          : consoleTarget.log ?? consoleTarget.info;
    consoleMethod?.call(consoleTarget, line);
    stream?.write(`${line}\n`);
  };

  return {
    info: (...args) => write("info", args),
    warn: (...args) => write("warn", args),
    error: (...args) => write("error", args),
    async close() {
      const activeStream = stream;
      stream = undefined;
      if (!activeStream) {
        return;
      }
      activeStream.end();
      if (activeStream.closed) {
        return;
      }
      await new Promise((resolve) => {
        activeStream.once("finish", resolve);
        activeStream.once("close", resolve);
      });
    },
  };
}
