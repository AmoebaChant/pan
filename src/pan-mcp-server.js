import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export const PAN_INTERACTIVE_TOOLS = Object.freeze([
  tool(
    "read_portfolio",
    "Read the complete current PAN portfolio. The first result block always exposes snapshotReference.value for mutation proposals, even when the portfolio is large.",
    {},
  ),
  tool(
    "read_workstream",
    "Read one workstream and its recent history.",
    {
      path: { type: "string" },
    },
    ["path"],
  ),
  tool(
    "read_issue",
    "Read one canonical Project item by its Project item ID.",
    {
      itemId: { type: "string" },
    },
    ["itemId"],
  ),
  tool(
    "read_runner_availability",
    "Read current runner availability for the configured domain.",
    {},
  ),
  tool(
    "read_config",
    "Read the current PAN domain configuration file, including the default agent model, cadences, and review policy. Contains no secrets. Read this before proposing a configuration change.",
    {},
  ),
  tool(
    "update_config",
    "Replace the PAN domain configuration file with a validated, complete config object. Call read_config first, modify the returned config, then submit the whole object. The change is rejected if it fails schema validation and requires restarting the PAN host and runner to take effect.",
    {
      config: { type: "object" },
    },
    ["config"],
  ),
  tool(
    "read_runner_profile",
    "Read this machine's PAN runner profile, including the Copilot tool approval mode (`prompt` or `allow-all`), capabilities, and repositories. Read this before proposing a runner profile change.",
    {},
  ),
  tool(
    "update_runner_profile",
    "Replace this machine's PAN runner profile with a validated, complete profile object. Call read_runner_profile first, modify the returned profile, then submit the whole object. The change is rejected if it fails schema validation and requires restarting the runner on this machine to take effect.",
    {
      profile: { type: "object" },
    },
    ["profile"],
  ),
  tool(
    "propose_actions",
    "Submit PAN protocol v1 actions for deterministic validation and application. Every mutation, including issue-create, must set expectedState.snapshotId to the exact snapshotReference.value from the latest read_portfolio result.",
    {
      actions: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "version",
            "actionId",
            "kind",
            "rationale",
            "confidence",
            "evidence",
          ],
          properties: {
            version: { const: 1 },
            actionId: { type: "string", minLength: 1 },
            kind: {
              enum: [
                "field-update",
                "canonical-reorder",
                "relative-precedence",
                "issue-create",
                "issue-comment",
                "needs-human",
                "no-op",
              ],
            },
            rationale: { type: "string", minLength: 1 },
            confidence: { type: "number", minimum: 0, maximum: 1 },
            evidence: {
              type: "array",
              minItems: 1,
              items: {
                type: "object",
                additionalProperties: false,
                required: ["kind", "locator"],
                properties: {
                  kind: {
                    enum: [
                      "issue",
                      "issue-comment",
                      "project-field",
                      "workstream",
                      "runner",
                      "domain-record",
                    ],
                  },
                  locator: { type: "string", minLength: 1 },
                  revision: { type: "string", minLength: 1 },
                  label: { type: "string", minLength: 1 },
                },
              },
            },
            idempotencyKey: { type: "string", minLength: 1 },
            expectedState: {
              type: "object",
              required: ["snapshotId"],
              properties: {
                snapshotId: {
                  type: "string",
                  minLength: 1,
                  description:
                    "Exact snapshotReference.value returned by read_portfolio.",
                },
              },
              additionalProperties: true,
            },
            target: { type: "object" },
            recommendation: { type: "string", minLength: 1 },
          },
          allOf: [
            {
              if: {
                required: ["kind"],
                properties: { kind: { const: "no-op" } },
              },
              then: { required: ["recommendation"] },
              else: {
                required: ["idempotencyKey", "expectedState", "target"],
              },
            },
          ],
        },
      },
    },
    ["actions"],
  ),
]);

export function startPanMcpServer({
  input = process.stdin,
  output = process.stdout,
  stateFile = process.env.PAN_RUNTIME_STATE,
  fetchImpl = fetch,
} = {}) {
  if (!stateFile) {
    throw new TypeError("PAN_RUNTIME_STATE is required");
  }
  input.setEncoding("utf8");
  let buffered = "";
  let queue = Promise.resolve();
  input.on("data", (chunk) => {
    buffered += chunk;
    let newline = buffered.indexOf("\n");
    while (newline !== -1) {
      const line = buffered.slice(0, newline).trim();
      buffered = buffered.slice(newline + 1);
      if (line) {
        queue = queue.then(() =>
          writeResponse(output, line, stateFile, fetchImpl),
        );
      }
      newline = buffered.indexOf("\n");
    }
  });
  input.on("end", () => {
    void queue.finally(() => output.end());
  });
}

export async function handlePanMcpRequest(
  message,
  { stateFile, fetchImpl = fetch },
) {
  if (message.method === "initialize") {
    return success(message.id, {
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "pan-tools", version: "1.0.0" },
    });
  }
  if (message.method === "tools/list") {
    return success(message.id, { tools: PAN_INTERACTIVE_TOOLS });
  }
  if (message.method === "tools/call") {
    const name = message.params?.name;
    if (!PAN_INTERACTIVE_TOOLS.some((candidate) => candidate.name === name)) {
      return failure(message.id, -32602, `Unknown PAN tool ${name}`);
    }
    try {
      const state = JSON.parse(await readFile(stateFile, "utf8"));
      const response = await fetchImpl(`${state.endpoint}/tools/call`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${state.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          name,
          arguments: message.params?.arguments ?? {},
        }),
      });
      const result = await response.json();
      if (!response.ok) {
        return success(message.id, {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: result.error ?? "PAN tool failed",
                ...(result.result ? { result: result.result } : {}),
              }),
            },
          ],
          isError: true,
        });
      }
      return success(message.id, {
        content: toolResultContent(name, result),
      });
    } catch (error) {
      return success(message.id, {
        content: [{ type: "text", text: error.message }],
        isError: true,
      });
    }
  }
  if (message.id !== undefined) {
    return failure(message.id, -32601, "Method not found");
  }
  return undefined;
}

async function writeResponse(output, line, stateFile, fetchImpl) {
  let response;
  try {
    response = await handlePanMcpRequest(JSON.parse(line), {
      stateFile,
      fetchImpl,
    });
  } catch {
    response = failure(null, -32700, "Parse error");
  }
  if (response) {
    output.write(`${JSON.stringify(response)}\n`);
  }
}

function tool(name, description, properties, required = []) {
  return Object.freeze({
    name,
    description,
    inputSchema: {
      type: "object",
      properties,
      required,
      additionalProperties: false,
    },
  });
}

function toolResultContent(name, result) {
  const content = [];
  if (name === "read_portfolio") {
    const snapshotReference = result.snapshotReference ?? {
      field: "actions[].expectedState.snapshotId",
      value: result.data?.id,
      usableForMutation: result.data?.usableForMutation === true,
    };
    content.push({
      type: "text",
      text: JSON.stringify({
        snapshotReference,
        instruction:
          "Copy snapshotReference.value into expectedState.snapshotId on every mutation action, including issue-create.",
      }),
    });
  }
  content.push({ type: "text", text: JSON.stringify(result) });
  return content;
}

function success(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function failure(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

if (
  process.env.PAN_MCP_SERVER === "1" &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  startPanMcpServer();
}
