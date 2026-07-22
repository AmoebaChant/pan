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
    prepare: withSpecification(async ({ context, options }) => {
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
    }, {
      positionals: ["workstream"],
      options: ["rationale", "source-turn"],
    }),
    publish: withSpecification(async ({ context, options }) => {
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
      const published = await service.publish({
        operationId: options["operation-id"],
        sessionId,
      });
      const effects = [];
      if (published.commitCreated) {
        effects.push(
          `Created workstream commit ${published.commitCreated.sha} on ${published.commitCreated.branch}.`,
        );
      }
      if (published.pushConfirmed) {
        effects.push(
          `Confirmed workstream commit ${published.pushConfirmed.sha} on remote ${published.pushConfirmed.branch}.`,
        );
      }
      if (published.noChange) {
        effects.push("No workstream changes required publication.");
      }
      return createPanCommandResult({
        status: published.status,
        operation: "workstream.publish",
        domain: commandDomain(context),
        confirmedEffects: effects,
        remainingSteps:
          published.status === "confirmed"
            ? []
            : published.recovery?.steps ?? [
                "Review the reported workstream delivery state before retrying.",
              ],
        diagnostics: published.diagnostics ?? [],
        recovery: published.recovery ?? { safe: true, steps: [] },
        receipts: [
          {
            operationId: options["operation-id"],
            ...(published.commitCreated
              ? { commit: published.commitCreated.sha }
              : {}),
            ...(published.pushConfirmed
              ? { pushed: published.pushConfirmed.sha }
              : {}),
            ...(published.cleanup?.receiptPath
              ? { receiptPath: published.cleanup.receiptPath }
              : {}),
          },
        ],
        data: {
          ...(published.commitCreated ?? {}),
          ...(published.pushConfirmed
            ? { pushedCommit: published.pushConfirmed.sha }
            : {}),
          cleanupCompleted: published.cleanup?.completed ?? false,
        },
      });
    }, {
      positionals: ["operation-id"],
    }),
  };
}

function withSpecification(handler, specification) {
  return Object.assign(handler, {
    specification,
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
