import { createLeadershipCommandHandlers } from "./leadership-commands.js";
import { ReconciliationService } from "./reconciliation-service.js";

export function createReconciliationCommandHandlers({
  env = process.env,
  serviceFactory = (options) => new ReconciliationService(options),
  leadershipHandlers = createLeadershipCommandHandlers({ env }),
} = {}) {
  return {
    "missing-issues": command(async ({ context, options }) => {
      const service = serviceFactory({
        store: context.store,
        assertLeadership: async () => {
          const result = await leadershipHandlers.assert({ context });
          return {
            asserted: result.status === "confirmed",
            reason: result.diagnostics.at(-1),
          };
        },
      });
      const result = await service.reconcileMissingIssues({
        apply: options.apply === true,
      });
      return {
        ...result,
        domain: context.domain,
      };
    }, { flags: ["apply"] }),
  };
}

function command(handler, specification) {
  return Object.assign(handler, { specification });
}
