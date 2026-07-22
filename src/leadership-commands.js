import { GitHubStateFile, LeaderLease } from "./leader-lease.js";
import { createPanCommandResult } from "./pan-command-result.js";

export const PAN_LEADERSHIP_ENV = Object.freeze({
  sessionId: "PAN_SESSION_ID",
  holder: "PAN_LEADERSHIP_HOLDER",
  generation: "PAN_LEADERSHIP_GENERATION",
  holderKind: "PAN_LEADERSHIP_HOLDER_KIND",
});

export function createLeadershipCommandHandlers({
  env = process.env,
  stateFileFactory = (options) => new GitHubStateFile(options),
  leaseFactory = (options) => new LeaderLease(options),
} = {}) {
  return {
    status: command(async ({ context }) => {
      const lease = createLease({ context, stateFileFactory, leaseFactory });
      const current = await lease.status();
      return result({
        context,
        operation: "leadership.status",
        confirmedEffects: [`Read leadership status: ${current.status}.`],
        diagnostics: diagnostics(current),
        leadership: leadership(current),
      });
    }),
    acquire: command(async ({ context }) => {
      const identity = requireIdentity(env);
      const lease = createLease({
        context,
        identity,
        stateFileFactory,
        leaseFactory,
      });
      const acquired = await lease.acquire();
      if (!acquired.acquired) {
        const current = await lease.status();
        return result({
          context,
          operation: "leadership.acquire",
          status: "rejected",
          diagnostics: [
            ...diagnostics(current),
            `Leadership acquisition was not confirmed: ${acquired.reason ?? "held by another session"}.`,
          ],
          recovery: {
            safe: true,
            steps: ["Continue in read-only mode and retry after the leader expires."],
          },
          leadership: leadership(current),
        });
      }
      return result({
        context,
        operation: "leadership.acquire",
        confirmedEffects: [
          `Acquired leadership for session ${identity.sessionId}.`,
        ],
        diagnostics: acquired.reclaimed
          ? ["Reclaimed a dead local leader lease."]
          : [],
        leadership: leadership({
          status: "active",
          lease: acquired.lease,
        }),
        expectedState: {
          holder: identity.holder,
          sessionId: identity.sessionId,
          generation: "current",
        },
      });
    }),
    assert: command(async ({ context }) => {
      const identity = requireIdentity(env);
      const lease = createLease({
        context,
        identity,
        stateFileFactory,
        leaseFactory,
      });
      const asserted = await lease.assert({
        token: identity.generation,
        sessionId: identity.sessionId,
      });
      return authorityResult({
        context,
        operation: "leadership.assert",
        identity,
        outcome: asserted,
      });
    }),
    renew: command(async ({ context }) => {
      const identity = requireIdentity(env);
      const lease = createLease({
        context,
        identity,
        stateFileFactory,
        leaseFactory,
      });
      const renewed = await lease.renew({
        token: identity.generation,
        sessionId: identity.sessionId,
      });
      return authorityResult({
        context,
        operation: "leadership.renew",
        identity,
        outcome: renewed,
        successKey: "renewed",
      });
    }),
    release: command(async ({ context }) => {
      const identity = requireIdentity(env);
      const lease = createLease({
        context,
        identity,
        stateFileFactory,
        leaseFactory,
      });
      const released = await lease.release({
        token: identity.generation,
        sessionId: identity.sessionId,
      });
      return authorityResult({
        context,
        operation: "leadership.release",
        identity,
        outcome: released,
        successKey: "released",
      });
    }),
  };
}

function command(handler) {
  return Object.assign(handler, { specification: {} });
}

function createLease({
  context,
  identity,
  stateFileFactory,
  leaseFactory,
}) {
  return leaseFactory({
    stateFile: stateFileFactory({
      gh: context.gh,
      repository: context.domain.repository,
      branch: context.config.state.branch,
      filePath: context.config.state.leaderPath,
    }),
    holder: identity?.holder ?? "leadership-status",
    sessionId: identity?.sessionId,
    holderKind: identity?.holderKind,
    tokenFactory: () => identity?.generation ?? "status",
    leaseSeconds: context.config.leadership.leaseSeconds,
  });
}

function requireIdentity(env) {
  const sessionId = env[PAN_LEADERSHIP_ENV.sessionId];
  const holder = env[PAN_LEADERSHIP_ENV.holder];
  const generation = env[PAN_LEADERSHIP_ENV.generation];
  for (const [name, value] of Object.entries({
    [PAN_LEADERSHIP_ENV.sessionId]: sessionId,
    [PAN_LEADERSHIP_ENV.holder]: holder,
    [PAN_LEADERSHIP_ENV.generation]: generation,
  })) {
    if (typeof value !== "string" || !value.trim()) {
      throw new TypeError(`${name} is required for mutating leadership commands`);
    }
  }
  return {
    sessionId,
    holder,
    generation,
    holderKind: env[PAN_LEADERSHIP_ENV.holderKind] || "copilot-session",
  };
}

function authorityResult({
  context,
  operation,
  identity,
  outcome,
  successKey = "asserted",
}) {
  if (outcome[successKey]) {
    const effect =
      successKey === "released"
        ? `Released leadership for session ${identity.sessionId}.`
        : successKey === "renewed"
          ? `Renewed leadership for session ${identity.sessionId}.`
          : `Confirmed leadership for session ${identity.sessionId}.`;
    return result({
      context,
      operation,
      confirmedEffects: [effect],
      leadership: leadership({
        status: successKey === "released" ? "released" : "active",
        lease: outcome.lease,
      }),
      expectedState:
        successKey === "released"
          ? undefined
          : {
              holder: identity.holder,
              sessionId: identity.sessionId,
              generation: "current",
            },
    });
  }
  return result({
    context,
    operation,
    status: "rejected",
    diagnostics: [
      `Leadership ${operation.slice("leadership.".length)} was rejected: ${outcome.reason}.`,
    ],
    recovery: {
      safe: true,
      steps: ["Continue in read-only mode and acquire a new leadership generation before retrying."],
    },
    leadership: leadership({ status: outcome.reason, lease: outcome.lease }),
  });
}

function result({
  context,
  operation,
  status = "confirmed",
  confirmedEffects = [],
  diagnostics = [],
  recovery,
  leadership,
  expectedState,
}) {
  return createPanCommandResult({
    status,
    operation,
    domain: {
      repository: context.domain.repository,
      projectOwner: context.domain.projectOwner,
      projectNumber: context.domain.projectNumber,
    },
    confirmedEffects,
    diagnostics,
    recovery,
    leadership,
    expectedState,
  });
}

function leadership({ status, lease }) {
  return {
    status,
    ...(lease?.holder ? { holder: lease.holder } : {}),
    ...(lease?.sessionId ? { sessionId: lease.sessionId } : {}),
    ...(lease?.holderKind ? { holderKind: lease.holderKind } : {}),
    ...(lease?.expiresAt ? { expiresAt: lease.expiresAt } : {}),
  };
}

function diagnostics({ status, lease }) {
  if (!lease) {
    return ["No durable leadership lease exists."];
  }
  return [
    `Leadership is ${status}; holder ${lease.holder} expires at ${lease.expiresAt}.`,
  ];
}
