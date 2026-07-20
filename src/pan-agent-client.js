import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

import {
  validatePanFinalResponse,
  validatePanToolMessage,
  validatePanTurnRequest,
} from "./pan-protocol.js";
import { terminateProcessTree } from "./process-tree.js";

const DELIVERY_CREDENTIALS = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "SSH_AUTH_SOCK",
  "GIT_ASKPASS",
];

export class PanAgentClient {
  constructor(options = {}) {
    this.executable = options.executable ?? "copilot";
    this.executableArgs = [...(options.executableArgs ?? [])];
    this.agent = options.agent ?? "pan";
    this.model = options.model;
    this.extraArgs = [...(options.extraArgs ?? [])];
    this.timeout = options.timeout ?? 120_000;
    this.maxBuffer = options.maxBuffer ?? 10 * 1024 * 1024;
    this.cwd = options.cwd ?? process.cwd();
    this.env = options.env ?? process.env;
    this.onToolMessage = options.onToolMessage;
    this.inlinePortfolio = options.inlinePortfolio ?? false;
    this.allowedCredentialEnvironment = new Set(
      options.allowedCredentialEnvironment ?? [],
    );
  }

  async review(request, options = {}) {
    return this.#runTurn(request, "autonomous-review", options);
  }

  async chat(request, options = {}) {
    return this.#runTurn(request, "interactive-chat", options);
  }

  async #runTurn(request, expectedMode, options) {
    const turn = validatePanTurnRequest(request);
    if (turn.mode !== expectedMode) {
      throw new TypeError(
        `${expectedMode === "autonomous-review" ? "review" : "chat"}() requires a ${expectedMode} turn`,
      );
    }

    if (options.resume && !options.sessionId) {
      throw new TypeError("Resumed PAN turns require a sessionId");
    }
    const sessionId = options.sessionId ?? randomUUID();
    const args = this.#buildArguments(
      turn,
      sessionId,
      options.resume,
      options.inlinePortfolio ?? this.inlinePortfolio,
    );
    const env = this.#buildEnvironment();
    let execution;
    try {
      execution = await runProcess(this.executable, args, {
        cwd: this.cwd,
        env,
        maxBuffer: this.maxBuffer,
        signal: options.signal,
        timeout: this.timeout,
      });
    } catch (error) {
      throw turnError(
        turn.turnId,
        error.state ?? "transport",
        hasConfirmedToolSideEffects(turn, error.stdout),
        error,
        {
          exitCode: error.exitCode,
          signal: error.signal,
        },
      );
    }

    let parsed;
    try {
      parsed = await this.#parseEvents(turn, execution.stdout);
    } catch (error) {
      throw turnError(
        turn.turnId,
        error.state ?? "protocol",
        error.confirmedSideEffects ?? false,
        error,
        {
          exitCode: execution.exitCode,
          signal: execution.signal,
        },
      );
    }

    const resultExitCode = readResultExitCode(parsed.result);
    if (
      execution.exitCode !== 0 ||
      (resultExitCode !== undefined && resultExitCode !== 0)
    ) {
      throw turnError(
        turn.turnId,
        "nonzero-exit",
        parsed.confirmedSideEffects,
        new Error(
          execution.stderr.trim() ||
            `Copilot exited with process code ${execution.exitCode} and result code ${resultExitCode}`,
        ),
        {
          exitCode: execution.exitCode,
          signal: execution.signal,
          resultExitCode,
        },
      );
    }
    if (!parsed.result) {
      throw turnError(
        turn.turnId,
        "missing-result",
        parsed.confirmedSideEffects,
        new Error("Copilot emitted no result event"),
        { exitCode: execution.exitCode, signal: execution.signal },
      );
    }
    if (!parsed.response) {
      throw turnError(
        turn.turnId,
        "missing-final-response",
        parsed.confirmedSideEffects,
        new Error("Copilot emitted no valid PAN final response"),
        { exitCode: execution.exitCode, signal: execution.signal },
      );
    }

    return {
      response: parsed.response,
      sessionId: readSessionId(parsed.result) ?? sessionId,
      toolMessages: parsed.toolMessages,
      result: parsed.result,
    };
  }

  #buildArguments(turn, sessionId, resume, inlinePortfolio) {
    const args = [
      ...this.executableArgs,
      "-C",
      this.cwd,
      "-p",
      buildPrompt(turn),
      "--agent",
      this.agent,
      "--no-ask-user",
      "--disable-builtin-mcps",
      "--no-remote",
      "--no-auto-update",
      "--disallow-temp-dir",
    ];

    if (!inlinePortfolio) {
      for (const operation of turn.toolChannel.allowedOperations) {
        args.push(
          `--available-tools=${turn.toolChannel.server}-${operation}`,
          `--allow-tool=${turn.toolChannel.server}(${operation})`,
        );
      }
    }
    args.push("--output-format", "json", "--stream", "off");
    if (this.model) {
      args.push("--model", this.model);
    }
    args.push(...this.extraArgs);
    if (resume) {
      args.push(`--resume=${sessionId}`);
    } else {
      args.push("--session-id", sessionId);
    }
    return args;
  }

  #buildEnvironment() {
    const env = { ...this.env, GIT_TERMINAL_PROMPT: "0" };
    for (const name of DELIVERY_CREDENTIALS) {
      if (!this.allowedCredentialEnvironment.has(name)) {
        delete env[name];
      }
    }
    return env;
  }

  async #parseEvents(turn, stdout) {
    const events = parseJsonLines(stdout);
    const toolMessages = [];
    const pendingRequests = new Map();
    let confirmedSideEffects = false;
    let response;
    let result;

    try {
      for (const event of events) {
        if (event.type === "session.error") {
          throw stateError("session-error", describeEventError(event));
        }
        if (
          event.type === "tool.execution_start" ||
          event.type === "tool.execution_complete"
        ) {
          const message = validatePanToolMessage(readToolMessage(event));
          validateToolExchange(turn, message, pendingRequests);
          if (message.type === "tool-request") {
            pendingRequests.set(message.requestId, message);
          } else {
            pendingRequests.delete(message.requestId);
            confirmedSideEffects ||= message.confirmedEffects.length > 0;
          }
          if (this.onToolMessage) {
            await this.onToolMessage(message);
          }
          toolMessages.push(message);
        } else if (event.type === "assistant.message") {
          const candidate = readAssistantContent(event);
          if (typeof candidate === "string") {
            try {
              const value = parseAssistantJson(candidate);
              if (value?.type === "final-response") {
                response = validatePanFinalResponse(value);
              }
            } catch (error) {
              if (candidate.trim().startsWith("{")) {
                throw stateError("malformed-response", error.message);
              }
            }
          }
        } else if (event.type === "result") {
          result = event;
        }
      }
      if (pendingRequests.size > 0) {
        throw stateError(
          "incomplete-tool-exchange",
          `Missing results for tool requests: ${[...pendingRequests.keys()].join(", ")}`,
        );
      }
      if (response) {
        validateResponseIdentity(turn, response);
      }
      return { confirmedSideEffects, response, result, toolMessages };
    } catch (error) {
      error.confirmedSideEffects = confirmedSideEffects;
      throw error;
    }
  }
}

function buildPrompt(turn) {
  const inline = turn.portfolio
    ? [
        "The complete portfolio snapshot is embedded in this request.",
        "Do not call tools. Reason only from this snapshot.",
      ]
    : ["Process this PAN turn request using only the allowed PAN tools."];
  const evidenceCitation = {
    kind: "issue",
    locator: "durable locator from the snapshot",
  };
  const responseShape = {
    version: 1,
    type: "final-response",
    turnId: turn.turnId,
    mode: turn.mode,
    timestamp: turn.timestamp,
    snapshotId: turn.snapshot.id,
    recommendation: "Concise recommendation.",
    facts: [
      {
        statement: "Fact supported by durable evidence.",
        citations: [evidenceCitation],
      },
    ],
    interpretations: [],
    assumptions: [],
    uncertainties: [],
    citations: [],
    ...(turn.responseRequirements
      ? {
          classifications: (turn.portfolio?.canonicalOrder ?? []).map(
            (itemId) => ({
              itemId,
              classification: "Explicit portfolio classification.",
              rationale: "Evidence-based classification rationale.",
              citations: [evidenceCitation],
            }),
          ),
          humanNextAction: {
            itemId: "eligible Project item ID",
            recommendation: "Clear human next action.",
            citations: [evidenceCitation],
          },
          agentQueueRecommendation: {
            orderedItemIds: [],
            recommendation: "Canonical-order agent queue view.",
            citations: [evidenceCitation],
          },
        }
      : {}),
    proposedActions: [],
    appliedActions: [],
    rejectedActions: [],
    effects: { confirmed: [], incomplete: [] },
  };
  return [
    ...inline,
    JSON.stringify(turn),
    "",
    "Return one JSON object with no Markdown fencing using this shape:",
    JSON.stringify(responseShape),
    ...(turn.responseRequirements
      ? [
          "Follow responseRequirements exactly. Omit a conditional recommendation field only when the portfolio has no eligible item for it.",
        ]
      : []),
    "For a canonical-reorder action, include every current Project item ID exactly once.",
    "Use expectedState.snapshotId equal to the supplied snapshot ID.",
    "Citation kind must be exactly one of: issue, issue-comment, project-field, workstream, runner, domain-record.",
    "Only propose an action when it is useful. A no-op recommendation is valid.",
  ].join("\n");
}

function parseAssistantJson(content) {
  const trimmed = content.trim();
  const unfenced = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  try {
    return JSON.parse(unfenced);
  } catch (firstError) {
    const start = unfenced.indexOf("{");
    const end = unfenced.lastIndexOf("}");
    if (start === -1 || end <= start) {
      throw firstError;
    }
    return JSON.parse(unfenced.slice(start, end + 1));
  }
}

function validateToolExchange(turn, message, pendingRequests) {
  if (message.turnId !== turn.turnId) {
    throw stateError(
      "tool-turn-mismatch",
      `Tool message belongs to turn ${message.turnId}`,
    );
  }
  if (!turn.toolChannel.allowedOperations.includes(message.operation)) {
    throw stateError(
      "unknown-tool",
      `Tool operation ${message.operation} is not allowed for this turn`,
    );
  }
  if (message.type === "tool-request") {
    if (pendingRequests.has(message.requestId)) {
      throw stateError(
        "duplicate-tool-request",
        `Tool request ${message.requestId} was already received`,
      );
    }
    return;
  }
  const request = pendingRequests.get(message.requestId);
  if (!request || request.operation !== message.operation) {
    throw stateError(
      "unexpected-tool-result",
      `Tool result ${message.requestId} has no matching request`,
    );
  }
}

function validateResponseIdentity(turn, response) {
  if (
    response.turnId !== turn.turnId ||
    response.mode !== turn.mode ||
    response.snapshotId !== turn.snapshot.id
  ) {
    throw stateError(
      "response-mismatch",
      `Final response does not match turn ${turn.turnId} and snapshot ${turn.snapshot.id}`,
    );
  }
}

function parseJsonLines(stdout) {
  const events = [];
  for (const [index, line] of stdout.split(/\r?\n/).entries()) {
    if (!line.trim()) {
      continue;
    }
    try {
      events.push(JSON.parse(line));
    } catch (error) {
      throw stateError(
        "malformed-jsonl",
        `Invalid JSON on stdout line ${index + 1}: ${error.message}`,
      );
    }
  }
  return events;
}

function hasConfirmedToolSideEffects(turn, stdout = "") {
  const pendingRequests = new Map();
  try {
    for (const event of parseJsonLines(stdout)) {
      if (
        event.type !== "tool.execution_start" &&
        event.type !== "tool.execution_complete"
      ) {
        continue;
      }
      const message = validatePanToolMessage(readToolMessage(event));
      validateToolExchange(turn, message, pendingRequests);
      if (message.type === "tool-request") {
        pendingRequests.set(message.requestId, message);
      } else {
        pendingRequests.delete(message.requestId);
        if (message.confirmedEffects.length > 0) {
          return true;
        }
      }
    }
  } catch {
    return false;
  }
  return false;
}

function readToolMessage(event) {
  const message =
    event.data?.message ??
    event.data?.toolMessage ??
    event.message ??
    event.toolMessage;
  if (typeof message === "string") {
    return JSON.parse(message);
  }
  return message;
}

function readAssistantContent(event) {
  return event.data?.content ?? event.content;
}

function readResultExitCode(event) {
  return event?.data?.exitCode ?? event?.exitCode;
}

function readSessionId(event) {
  return event?.data?.sessionId ?? event?.sessionId;
}

function describeEventError(event) {
  return (
    event.data?.message ??
    event.data?.error ??
    event.message ??
    "Copilot emitted a terminal session error"
  );
}

function stateError(state, message) {
  return Object.assign(new Error(message), { state });
}

function turnError(turnId, state, confirmedSideEffects, cause, details = {}) {
  return Object.assign(
    new Error(
      `PAN turn ${turnId} failed (${state}; confirmed tool side effects: ${confirmedSideEffects ? "yes" : "no"}): ${cause.message}`,
      { cause },
    ),
    {
      turnId,
      state,
      confirmedSideEffects,
      ...details,
    },
  );
}

async function runProcess(executable, args, options) {
  if (options.signal?.aborted) {
    throw stateError("cancelled", "Turn was cancelled before process launch");
  }

  const child = spawn(executable, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let failure;
    let settled = false;
    let termination;

    const failAndTerminate = (error) => {
      if (failure) {
        return;
      }
      failure = error;
      termination = terminateProcessTree(child);
    };
    const append = (target, chunk) => {
      const next = target + chunk.toString("utf8");
      if (Buffer.byteLength(next) > options.maxBuffer) {
        failAndTerminate(
          stateError(
            "output-limit",
            `Process output exceeded ${options.maxBuffer} bytes`,
          ),
        );
      }
      return next;
    };
    const timeout = options.timeout
      ? setTimeout(
          () =>
            failAndTerminate(
              stateError(
                "timeout",
                `Process exceeded ${options.timeout}ms deadline`,
              ),
            ),
          options.timeout,
        )
      : undefined;
    const abort = () =>
      failAndTerminate(stateError("cancelled", "Turn was cancelled"));
    options.signal?.addEventListener("abort", abort, { once: true });

    child.stdout.on("data", (chunk) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = append(stderr, chunk);
    });
    child.once("error", (error) => {
      failAndTerminate(Object.assign(error, { state: "spawn-error" }));
      finish();
    });
    child.once("close", (exitCode, signal) => {
      void finish(exitCode, signal);
    });

    async function finish(exitCode, signal) {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abort);
      await termination;
      if (failure) {
        Object.assign(failure, { exitCode, signal, stdout, stderr });
        reject(failure);
      } else {
        resolve({ exitCode, signal, stdout, stderr });
      }
    }
  });
}
