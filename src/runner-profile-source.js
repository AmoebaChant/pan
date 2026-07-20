import { readdir } from "node:fs/promises";
import path from "node:path";

import { loadRunnerProfile } from "./runner-profile.js";

export class RunnerProfileSource {
  constructor({ directory }) {
    if (!directory) {
      throw new TypeError("runner profile directory is required");
    }
    this.directory = directory;
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
    return Promise.all(files.map((file) => loadRunnerProfile(file)));
  }
}

