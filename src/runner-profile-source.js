import { readdir } from "node:fs/promises";
import path from "node:path";

import { buildRunnerAvailability } from "./runner-availability.js";
import { loadRunnerProfile } from "./runner-profile.js";

export class RunnerProfileSource {
  constructor({ directory, profileLoader = loadRunnerProfile }) {
    if (!directory) {
      throw new TypeError("runner profile directory is required");
    }
    this.directory = directory;
    this.profileLoader = profileLoader;
  }

  async load() {
    let entries;
    try {
      entries = await readdir(this.directory, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") {
        return [];
      }
      throw error;
    }
    const files = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => path.join(this.directory, entry.name))
      .sort();
    return Promise.all(files.map((file) => this.profileLoader(file)));
  }

  async loadAvailability(options = {}) {
    let entries;
    try {
      entries = await readdir(this.directory, { withFileTypes: true });
    } catch (error) {
      return {
        complete: false,
        runners: [],
        diagnostics: [
          {
            code:
              error.code === "ENOENT"
                ? "missing-runner-directory"
                : "runner-directory-error",
            message:
              error.code === "ENOENT"
                ? "Runner profile directory is unavailable"
                : `Runner profile directory could not be read (${error.code ?? "unknown error"})`,
          },
        ],
      };
    }
    const files = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .sort((left, right) => left.name.localeCompare(right.name));
    const profiles = [];
    const diagnostics = [];
    for (const entry of files) {
      const file = path.join(this.directory, entry.name);
      try {
        profiles.push(await this.profileLoader(file));
      } catch (error) {
        diagnostics.push({
          source: entry.name,
          code: "invalid-runner-profile",
          message: redactProfileError(error.message, file, this.directory),
        });
      }
    }
    const availability = buildRunnerAvailability(profiles, options);
    return {
      complete: diagnostics.length === 0 && availability.complete,
      runners: availability.runners,
      diagnostics: [...diagnostics, ...availability.diagnostics],
    };
  }
}

function redactProfileError(message, file, directory) {
  return String(message)
    .replaceAll(file, "<profile>")
    .replaceAll(directory, "<runner-directory>");
}
