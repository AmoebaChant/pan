import { migrateDomainConfigFile } from "./domain-config-file.js";
import { createPanCommandResult } from "./pan-command-result.js";

export function createConfigCommandHandlers({
  migrateFile = migrateDomainConfigFile,
} = {}) {
  return {
    read: command(async ({ context }) =>
      result(context, "config.read", {
        confirmedEffects: ["Read and normalized the domain configuration."],
        data: { config: context.config },
      }),
    ),
    validate: command(async ({ context }) =>
      result(context, "config.validate", {
        confirmedEffects: ["Validated the domain configuration."],
        data: { version: context.config.version },
      }),
    ),
    migrate: command(async ({ context }) => {
      const migration = await migrateFile(context.config.configPath);
      return result(context, "config.migrate", {
        confirmedEffects: ["Migrated the domain configuration to version 2."],
        diagnostics: migration.diagnostics,
        data: { version: migration.document.version },
      });
    }),
  };
}

function command(handler) {
  return Object.assign(handler, { specification: {} });
}

function result(context, operation, {
  confirmedEffects,
  diagnostics = [],
  data,
}) {
  return createPanCommandResult({
    status: "confirmed",
    operation,
    domain: {
      repository: context.domain.repository,
      projectOwner: context.domain.projectOwner,
      projectNumber: context.domain.projectNumber,
    },
    confirmedEffects,
    diagnostics,
    data,
  });
}
