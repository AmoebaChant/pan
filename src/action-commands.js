import { readFile } from "node:fs/promises";
import path from "node:path";

import { ActionPolicy } from "./action-policy.js";
import { ActionService } from "./action-service.js";
import { AttentionService } from "./attention-service.js";
import { createPanCommandResult } from "./pan-command-result.js";
import { GitHubStateFile, LeaderLease } from "./leader-lease.js";
import { PortfolioSnapshotBuilder } from "./portfolio-snapshot.js";
import { RunnerProfileSource } from "./runner-profile-source.js";
import { WorkstreamStore } from "./workstream-store.js";
import { PAN_LEADERSHIP_ENV } from "./leadership-commands.js";

const MAX_ACTION_FILE_BYTES = 1_048_576;

export function createActionCommandHandlers({
  env = process.env,
  actionServiceFactory = (options) => new ActionService(options),
  portfolioBuilderFactory = (context) =>
    new PortfolioSnapshotBuilder({
      projectSource: context.store,
      issueCatalogSource: context.store,
      workstreamSource: new WorkstreamStore({
        repositoryPath: context.domain.path,
      }),
      runnerSource: new RunnerProfileSource({
        directory: path.join(context.domain.path, "runners"),
      }),
    }),
  stateFileFactory = (options) => new GitHubStateFile(options),
  leaseFactory = (options) => new LeaderLease(options),
  readAction = readActionFile,
} = {}) {
  return {
    validate: command(async ({ context, options }) => {
      const input = await readAction(options["action-file"]);
      const service = createService({
        context,
        env,
        actionServiceFactory,
        portfolioBuilderFactory,
        stateFileFactory,
        leaseFactory,
      });
      const result = await service.validate(input);
      return commandResult(context, "action.validate", result);
    }),
    apply: command(async ({ context, options }) => {
      const identity = requireIdentity(env);
      const input = await readAction(options["action-file"]);
      const service = createService({
        context,
        env,
        actionServiceFactory,
        portfolioBuilderFactory,
        stateFileFactory,
        leaseFactory,
      });
      const result = await service.apply(input, { identity });
      return commandResult(context, "action.apply", result);
    }),
  };
}

function createService({
  context,
  env,
  actionServiceFactory,
  portfolioBuilderFactory,
  stateFileFactory,
  leaseFactory,
}) {
  const identity = optionalIdentity(env);
  const assertLeadership = async (currentIdentity) => {
    if (!currentIdentity) {
      return { asserted: false, reason: "Leadership identity is required" };
    }
    const lease = leaseFactory({
      stateFile: stateFileFactory({
        gh: context.gh,
        repository: context.domain.repository,
        branch: context.config.state.branch,
        filePath: context.config.state.leaderPath,
      }),
      holder: currentIdentity.holder,
      sessionId: currentIdentity.sessionId,
      holderKind: currentIdentity.holderKind,
      tokenFactory: () => currentIdentity.generation,
      leaseSeconds: context.config.leadership.leaseSeconds,
    });
    const asserted = await lease.assert({
      token: currentIdentity.generation,
      sessionId: currentIdentity.sessionId,
    });
    return {
      asserted: asserted.asserted,
      reason: asserted.reason,
      lease: asserted.lease,
    };
  };
  const attention = new AttentionService({
    store: context.store,
    humanAssignee: context.config.attention?.assignee,
    assertLeadership: () => assertLeadership(identity),
  });
  return actionServiceFactory({
    snapshotSource: portfolioBuilderFactory(context),
    store: context.store,
    actionPolicy: new ActionPolicy(context.config.policy),
    assertLeadership,
    attention,
  });
}

function commandResult(context, operation, result) {
  const rejected = result.rejected.length > 0
    ? result.rejected
    : result.receipts.filter((entry) => entry.status === "rejected");
  if (result.incompleteEffects?.length > 0) {
    return createPanCommandResult({
      version: 2,
      status: "incomplete",
      operation,
      domain: commandDomain(context),
      confirmedEffects: result.effects,
      incompleteEffects: result.incompleteEffects,
      remainingSteps: [
        "Refresh complete evidence and retry only the unconfirmed action.",
      ],
      diagnostics: result.incompleteEffects.flatMap((entry) => entry.recovery),
      receipts: commandReceipts(result.receipts),
      snapshot: { snapshotId: result.snapshot.id },
    });
  }
  if (rejected.length > 0) {
    return createPanCommandResult({
      version: 2,
      status: "rejected",
      operation,
      domain: commandDomain(context),
      confirmedEffects: [],
      remainingSteps: ["Refresh evidence, obtain approval, or revise the rejected action."],
      diagnostics: rejected.flatMap((entry) => entry.reasons ?? []),
      receipts: commandReceipts(result.receipts),
      snapshot: { snapshotId: result.snapshot.id },
    });
  }
  return createPanCommandResult({
    version: 2,
    status: "confirmed",
    operation,
    domain: commandDomain(context),
    confirmedEffects: result.effects ?? [],
    diagnostics: [],
    receipts: commandReceipts(result.receipts),
    snapshot: { snapshotId: result.snapshot.id },
  });
}

function commandReceipts(receipts) {
  return receipts.map((entry) => ({
    actionId: entry.actionId,
    status: entry.status,
    ...(entry.reasons?.length ? { reason: entry.reasons.join("; ") } : {}),
  }));
}

async function readActionFile(filePath) {
  if (typeof filePath !== "string" || !filePath.trim()) {
    throw new TypeError("--action-file is required");
  }
  const content = await readFile(path.resolve(filePath), "utf8");
  if (Buffer.byteLength(content) > MAX_ACTION_FILE_BYTES) {
    throw new Error(`Action file exceeds the ${MAX_ACTION_FILE_BYTES}-byte limit`);
  }
  try {
    return JSON.parse(content);
  } catch (error) {
    throw new TypeError(`Action file must contain JSON: ${error.message}`);
  }
}

function command(handler) {
  return Object.assign(handler, {
    specification: {
      options: ["action-file"],
      requiredOptions: ["action-file"],
    },
  });
}

function requireIdentity(env) {
  const identity = optionalIdentity(env);
  if (!identity) {
    throw new TypeError(
      `${PAN_LEADERSHIP_ENV.sessionId}, ${PAN_LEADERSHIP_ENV.holder}, and ${PAN_LEADERSHIP_ENV.generation} are required for action apply`,
    );
  }
  return identity;
}

function optionalIdentity(env) {
  const sessionId = env[PAN_LEADERSHIP_ENV.sessionId];
  const holder = env[PAN_LEADERSHIP_ENV.holder];
  const generation = env[PAN_LEADERSHIP_ENV.generation];
  if (![sessionId, holder, generation].every((value) => typeof value === "string" && value.trim())) {
    return undefined;
  }
  return {
    sessionId,
    holder,
    generation,
    holderKind: env[PAN_LEADERSHIP_ENV.holderKind] || "copilot-session",
  };
}

function commandDomain(context) {
  const { repository, projectOwner, projectNumber } = context.domain;
  return { repository, projectOwner, projectNumber };
}
