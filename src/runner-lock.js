import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export async function acquireRunnerLock(profile) {
  await mkdir(profile.stateDirectory, { recursive: true });
  const lockPath = path.join(
    profile.stateDirectory,
    `${profile.id.replace(/[^A-Za-z0-9_.-]/g, "_")}.lock`,
  );

  const token = randomUUID();
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const handle = await open(lockPath, "wx");
      await handle.writeFile(
        `${JSON.stringify({
          pid: process.pid,
          runner: profile.id,
          startedAt: new Date().toISOString(),
          token,
        })}\n`,
      );
      await handle.close();
      return {
        path: lockPath,
        async release() {
          const owner = await readLock(lockPath);
          if (owner?.token === token) {
            await rm(lockPath, { force: true });
          }
        },
      };
    } catch (error) {
      if (error.code !== "EEXIST") {
        throw error;
      }
      const owner = await readLock(lockPath);
      if (owner?.pid && processIsAlive(owner.pid)) {
        throw new Error(
          `Runner ${profile.id} is already active in process ${owner.pid}`,
        );
      }
      const quarantine = `${lockPath}.stale-${process.pid}-${randomUUID()}`;
      try {
        await rename(lockPath, quarantine);
        await rm(quarantine, { force: true });
      } catch (reclaimError) {
        if (!["ENOENT", "EEXIST"].includes(reclaimError.code)) {
          throw reclaimError;
        }
      }
    }
  }
  throw new Error(`Unable to acquire runner lock ${lockPath}`);
}

async function readLock(lockPath) {
  try {
    return JSON.parse(await readFile(lockPath, "utf8"));
  } catch {
    return undefined;
  }
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}
