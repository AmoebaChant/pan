import { pathToFileURL } from "node:url";

export const TOOL_NAMES = Object.freeze([
  "read_portfolio",
  "malformed_result",
]);

export function handleMcpRequest(message) {
  if (message.method === "initialize") {
    return success(message.id, {
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "pan-spike", version: "1.0.0" },
    });
  }

  if (message.method === "tools/list") {
    return success(message.id, {
      tools: [
        {
          name: "read_portfolio",
          description: "Read the public synthetic portfolio fixture.",
          inputSchema: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
        },
        {
          name: "malformed_result",
          description: "Return a deliberately malformed result for probing.",
          inputSchema: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
        },
      ],
    });
  }

  if (message.method === "tools/call") {
    if (message.params?.name === "read_portfolio") {
      return success(message.id, {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              domain: "fixture",
              projects: [{ id: "fixture-1", title: "Synthetic PAN project" }],
            }),
          },
        ],
      });
    }

    if (message.params?.name === "malformed_result") {
      return success(message.id, { content: "not-an-mcp-content-array" });
    }

    return failure(message.id, -32602, "Unknown tool");
  }

  if (message.id !== undefined) {
    return failure(message.id, -32601, "Method not found");
  }

  return undefined;
}

export function startMcpServer(input = process.stdin, output = process.stdout) {
  input.setEncoding("utf8");
  let buffered = "";

  input.on("data", (chunk) => {
    buffered += chunk;
    let newline = buffered.indexOf("\n");
    while (newline !== -1) {
      const line = buffered.slice(0, newline).trim();
      buffered = buffered.slice(newline + 1);
      if (line) {
        writeResponse(output, line);
      }
      newline = buffered.indexOf("\n");
    }
  });
  input.on("end", () => {
    output.end();
  });
}

function writeResponse(output, line) {
  let response;
  try {
    response = handleMcpRequest(JSON.parse(line));
  } catch {
    response = failure(null, -32700, "Parse error");
  }
  if (response) {
    output.write(`${JSON.stringify(response)}\n`);
  }
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
  startMcpServer();
}
