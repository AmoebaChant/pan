import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export const PAN_INTERACTIVE_TOOLS = Object.freeze([
  tool("read_portfolio", "Read the complete current PAN portfolio.", {}),
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
    "propose_actions",
    "Submit PAN protocol actions for deterministic validation and application by the running PAN host.",
    {
      actions: {
        type: "array",
        minItems: 1,
        items: { type: "object" },
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
        content: [{ type: "text", text: JSON.stringify(result) }],
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
