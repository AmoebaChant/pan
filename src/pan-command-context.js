import { loadDomainConfig } from "./domain-config.js";
import { GhClient } from "./gh-client.js";
import { PanStore } from "./pan-store.js";

export async function createPanCommandContext({
  configPath,
  env = process.env,
  domainConfigLoader = loadDomainConfig,
  ghFactory = (options) => new GhClient(options),
  storeFactory = (options) => new PanStore(options),
} = {}) {
  if (typeof configPath !== "string" || !configPath.trim()) {
    throw new TypeError("configPath is required");
  }
  const config = await domainConfigLoader(configPath);
  const gh = ghFactory({ env });
  const store = storeFactory({
    repository: config.domain.repository,
    projectOwner: config.domain.projectOwner,
    projectNumber: config.domain.projectNumber,
    gh,
  });
  return Object.freeze({
    config,
    gh,
    store,
    domain: Object.freeze({
      repository: config.domain.repository,
      projectOwner: config.domain.projectOwner,
      projectNumber: config.domain.projectNumber,
      path: config.domain.path,
    }),
  });
}
