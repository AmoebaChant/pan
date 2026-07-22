import { readFile } from "node:fs/promises";
import path from "node:path";

import { AttentionService } from "./attention-service.js";
import { createLeadershipCommandHandlers } from "./leadership-commands.js";
import { createPanCommandResult } from "./pan-command-result.js";

export function createAttentionCommandHandlers({
  env = process.env,
  attentionFactory = (options) => new AttentionService(options),
  leadershipHandlers = createLeadershipCommandHandlers({ env }),
  readFileText = readFile,
} = {}) {
  return {
    list: command(async ({ context }) => {
      const entries = await attentionFactory({
        store: context.store,
        humanAssignee: context.config.attention?.assignee,
      }).inbox();
      return result({
        context,
        operation: "attention.list",
        confirmedEffects: [`Read ${entries.length} attention item(s).`],
        data: { entries },
      });
    }),
    answer: command(async ({ context, options }) => {
      const authority = await leadershipHandlers.assert({ context });
      if (authority.status !== "confirmed") {
        return leadershipRejected(context, "attention.answer", authority);
      }
      try {
        const item = await attentionFactory({
          store: context.store,
          humanAssignee: context.config.attention?.assignee,
          assertLeadership: () => leadershipAssertion(leadershipHandlers, context),
        }).answer(options.identifier, options.text);
        return result({
          context,
          operation: "attention.answer",
          confirmedEffects: [
            `Recorded a durable answer for Issue #${item.number ?? item.id}.`,
          ],
          data: legacyItem(item),
        });
      } catch (error) {
        if (error?.code === "PAN_ATTENTION_NOT_ACTIONABLE") {
          return result({
            context,
            operation: "attention.answer",
            status: "rejected",
            diagnostics: [error.message],
            recovery: {
              safe: true,
              steps: ["Select an item with unresolved human attention and retry."],
            },
          });
        }
        throw error;
      }
    }, { positionals: ["identifier", "text"] }),
    add: command(async ({ context, options }) => {
      const authority = await leadershipHandlers.assert({ context });
      if (authority.status !== "confirmed") {
        return leadershipRejected(context, "attention.add", authority);
      }
      if (options.body !== undefined && options["body-file"] !== undefined) {
        throw new TypeError("--body and --body-file cannot be used together");
      }
      const body =
        options["body-file"] === undefined
          ? (options.body ?? "")
          : await readFileText(path.resolve(options["body-file"]), "utf8");
      const owner = options.owner ?? "unassigned";
      const priority = options.priority ?? "normal";
      const autonomy = options.autonomy ?? "manual";
      validateChoice(owner, ["unassigned", "human", "agent"], "--owner");
      validateChoice(priority, ["urgent", "high", "normal", "low"], "--priority");
      validateChoice(
        autonomy,
        ["manual", "full-auto", "agent-reviewer"],
        "--autonomy",
      );
      const item = await attentionFactory({
        store: context.store,
        humanAssignee: context.config.attention?.assignee,
        assertLeadership: () => leadershipAssertion(leadershipHandlers, context),
      }).add({
        title: options.title,
        body,
        workstream: options.workstream,
        owner,
        priority,
        autonomy,
        requirements: [
          ...new Set([
            ...(options.requirement ?? []),
            ...(options.repo ?? []).map((repository) => `repo:${repository}`),
          ]),
        ],
      });
      return result({
        context,
        operation: "attention.add",
        confirmedEffects: [`Created Issue #${item.number ?? item.id}.`],
        data: legacyItem(item),
      });
    }, {
      positionals: ["title"],
      options: [
        "body",
        "body-file",
        "workstream",
        "owner",
        "priority",
        "autonomy",
      ],
      repeatableOptions: ["requirement", "repo"],
    }),
  };
}

function command(handler, specification = {}) {
  return Object.assign(handler, { specification });
}

async function leadershipAssertion(handlers, context) {
  const result = await handlers.assert({ context });
  return {
    asserted: result.status === "confirmed",
    reason: result.diagnostics.at(-1),
  };
}

function leadershipRejected(context, operation, authority) {
  return result({
    context,
    operation,
    status: "rejected",
    diagnostics: [
      authority.diagnostics?.at(-1) ??
        "Leadership was not confirmed for this mutation.",
    ],
    recovery: {
      safe: true,
      steps: ["Acquire leadership and retry the mutation."],
    },
  });
}

function result({
  context,
  operation,
  status = "confirmed",
  confirmedEffects = [],
  diagnostics = [],
  recovery,
  data,
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
    data,
  });
}

function legacyItem(item) {
  return {
    id: item.number ?? item.id,
    issueUrl: item.url,
  };
}

function validateChoice(value, choices, option) {
  if (!choices.includes(value)) {
    throw new TypeError(`${option} must be one of ${choices.join(", ")}`);
  }
}
