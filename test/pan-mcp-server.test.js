import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  handlePanMcpRequest,
  PAN_INTERACTIVE_TOOLS,
} from "../src/index.js";

test("lists interactive tools and proxies authenticated calls", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pan-mcp-"));
  const stateFile = path.join(directory, "host.json");
  await writeFile(
    stateFile,
    JSON.stringify({
      endpoint: "http://127.0.0.1:43127",
      token: "secret",
    }),
  );
  let request;
  const fetchImpl = async (url, options) => {
    request = { url, options };
    return {
      ok: true,
      json: async () => ({ status: "confirmed", data: { id: "snapshot-1" } }),
    };
  };

  const listed = await handlePanMcpRequest(
    { jsonrpc: "2.0", id: 1, method: "tools/list" },
    { stateFile, fetchImpl },
  );
  assert.deepEqual(listed.result.tools, PAN_INTERACTIVE_TOOLS);

  const called = await handlePanMcpRequest(
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "read_portfolio", arguments: {} },
    },
    { stateFile, fetchImpl },
  );
  assert.equal(request.url, "http://127.0.0.1:43127/tools/call");
  assert.equal(request.options.headers.authorization, "Bearer secret");
  assert.match(called.result.content[0].text, /snapshot-1/);
});
