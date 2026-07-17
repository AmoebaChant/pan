import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export class GhCommandError extends Error {
  constructor(args, cause) {
    const stderr = cause.stderr?.trim();
    super(`gh ${args.join(" ")} failed${stderr ? `: ${stderr}` : ""}`, { cause });
    this.name = "GhCommandError";
    this.args = args;
    this.exitCode = cause.code;
    this.stderr = cause.stderr;
    this.stdout = cause.stdout;
  }
}

export class GhClient {
  constructor({ executable = "gh", env = process.env } = {}) {
    this.executable = executable;
    this.env = env;
  }

  async run(args) {
    try {
      const { stdout } = await execFileAsync(this.executable, args, {
        encoding: "utf8",
        env: this.env,
        maxBuffer: 10 * 1024 * 1024,
        windowsHide: true,
      });
      return stdout.trim();
    } catch (error) {
      throw new GhCommandError(args, error);
    }
  }

  async runJson(args) {
    const output = await this.run(args);
    if (!output) {
      throw new Error(`gh ${args.join(" ")} returned no JSON`);
    }
    return JSON.parse(output);
  }
}
