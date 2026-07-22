import { createPanCommandResult } from "./pan-command-result.js";
import { PAN_LEADERSHIP_ENV } from "./leadership-commands.js";
import { createLeadershipCommandHandlers } from "./leadership-commands.js";
import { WorkstreamDeliveryService } from "./workstream-delivery.js";

export function createWorkstreamCommandHandlers({
  env = process.env,
  serviceFactory = (options) => new WorkstreamDeliveryService(options),
  leadershipHandlers = createLeadershipCommandHandlers({ env }),
} = {}) {
  return {
    prepare: command(async ({ context, options }) => {
      const sessionId = requireSessionId(env);
      const service = serviceFactory({
        repositoryPath: context.domain.path,
        repository: context.domain.repository,
        assertLeadership: async () => {
          const result = await leadershipHandlers.assert({ context });
          return {
            asserted: result.status === "confirmed",
            reason: result.diagnostics.at(-1),
          };
        },
      });
      const prepared = await service.prepare({
        workstream: options.workstream,
        sessionId,
        rationale: options.rationale,
        sourceTurn: options["source-turn"],
      });
      if (prepared.status !== "confirmed") {
        return createPanCommandResult({
          status: "rejected",
          operation: "workstream.prepare",
          domain: commandDomain(context),
          diagnostics: prepared.diagnostics,
          recovery: prepared.recovery,
        });
      }
      const { receipt } = prepared;
      return createPanCommandResult({
        status: "confirmed",
        operation: "workstream.prepare",
        domain: commandDomain(context),
        confirmedEffects: [
          `Prepared isolated workstream workspace for ${receipt.workstream.path}.`,
        ],
        expectedState: {
          baseCommit: receipt.target.baseCommit,
          targetBlob: receipt.workstream.expectedBlob ?? "absent",
        },
        receipts: [
          {
            operationId: receipt.operationId,
            receiptPath: receipt.cleanup.receiptPath,
            expiresAt: receipt.expiresAt,
          },
        ],
        data: {
          operationId: receipt.operationId,
          workspace: receipt.workspace,
          filePath: receipt.filePath,
          defaultBranch: receipt.target.defaultBranch,
          baseCommit: receipt.target.baseCommit,
          expectedBlob: receipt.workstream.expectedBlob,
          expectedAbsent: receipt.workstream.expectedAbsent,
          receiptPath: receipt.cleanup.receiptPath,
          expiresAt: receipt.expiresAt,
        },
      });
    }),
  };
}

function command(handler) {
  return Object.assign(handler, {
    specification: {
      positionals: ["workstream"],
      options: ["rationale", "source-turn"],
    },
  });
}

function requireSessionId(env) {
  const value = env[PAN_LEADERSHIP_ENV.sessionId];
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(
      `${PAN_LEADERSHIP_ENV.sessionId} is required for workstream preparation`,
    );
  }
  return value;
}

function commandDomain(context) {
  const { repository, projectOwner, projectNumber } = context.domain;
  return { repository, projectOwner, projectNumber };
}
