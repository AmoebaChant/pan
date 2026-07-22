import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildInteractiveCopilotArgs,
  connectPan,
  runtimePaths,
  startPan,
} from "../src/index.js";

test("interactive args grant read-only recovery of a truncated portfolio", () => {
  const args = buildInteractiveCopilotArgs({
    toolRoot: path.resolve("."),
    mcpConfig: "/tmp/mcp.json",
    agentName: "pan",
    model: "gpt-5.6-sol",
  });

  assert.ok(args.includes("--available-tools=view"));
  assert.ok(args.includes("--allow-tool=read"));
  assert.ok(args.includes("--allow-tool=pan-tools"));
  assert.ok(args.includes("--available-tools=pan-tools-read_portfolio"));
  assert.ok(!args.includes("--disallow-temp-dir"));
});

test("opens a headed PAN session connected to an existing host", async () => {
  const localAppData = await mkdtemp(path.join(os.tmpdir(), "pan-launcher-"));
  const configPath = path.join(localAppData, "domain.json");
  const toolRoot = path.resolve(".");
  const paths = runtimePaths(configPath, { LOCALAPPDATA: localAppData });
  await mkdir(paths.directory, { recursive: true });
  await writeFile(
    paths.stateFile,
    JSON.stringify({
      endpoint: "http://127.0.0.1:43127",
      token: "secret",
      autonomousApply: false,
    }),
  );
  const launches = [];
  const spawnProcess = (executable, args, options) => {
    launches.push({ executable, args, options });
    const child = new EventEmitter();
    child.unref = () => {};
    process.nextTick(() => child.emit("spawn"));
    return child;
  };

  const result = await startPan({
    configPath,
    toolRoot,
    env: {
      LOCALAPPDATA: localAppData,
      PAN_WINDOWS_TERMINAL: "wt-test.exe",
    },
    terminalProfile: "PowerShell",
    spawnProcess,
    fetchImpl: async () => ({ ok: true }),
  });

  assert.equal(result.started, false);
  assert.equal(result.terminalOpened, true);
  assert.equal(launches[0].executable, "wt-test.exe");
  assert.equal(
    launches[0].args[launches[0].args.indexOf("-p") + 1],
    "PowerShell",
  );
  assert.equal(
    launches[0].args[launches[0].args.indexOf("--title") + 1],
    "Pan",
  );
  assert.ok(launches[0].args.includes("--suppressApplicationTitle"));
  assert.ok(launches[0].args.includes("--agent"));
  assert.ok(launches[0].args.includes("pan"));
  assert.ok(launches[0].args.includes("--session-id"));
  assert.ok(!launches[0].args.includes("--name"));
  const mcp = JSON.parse(await readFile(paths.mcpConfig, "utf8"));
  assert.equal(
    mcp.mcpServers["pan-tools"].env.PAN_RUNTIME_STATE,
    paths.stateFile,
  );
});

test("uses the Windows Terminal default profile when none is configured", async () => {
  const localAppData = await mkdtemp(path.join(os.tmpdir(), "pan-launcher-"));
  const configPath = path.join(localAppData, "domain.json");
  const toolRoot = path.resolve(".");
  const paths = runtimePaths(configPath, { LOCALAPPDATA: localAppData });
  await mkdir(paths.directory, { recursive: true });
  await writeFile(
    paths.stateFile,
    JSON.stringify({
      endpoint: "http://127.0.0.1:43127",
      token: "secret",
      autonomousApply: false,
    }),
  );
  let launch;
  const spawnProcess = (executable, args, options) => {
    launch = { executable, args, options };
    const child = new EventEmitter();
    child.unref = () => {};
    process.nextTick(() => child.emit("spawn"));
    return child;
  };

  await startPan({
    configPath,
    toolRoot,
    env: { LOCALAPPDATA: localAppData },
    spawnProcess,
    fetchImpl: async () => ({ ok: true }),
  });

  assert.ok(!launch.args.includes("-p"));
  assert.equal(launch.args[launch.args.indexOf("--title") + 1], "Pan");
  assert.ok(launch.args.includes("--suppressApplicationTitle"));
});

test("requires a restart to change autonomous apply mode", async () => {
  const localAppData = await mkdtemp(path.join(os.tmpdir(), "pan-launcher-"));
  const configPath = path.join(localAppData, "domain.json");
  const paths = runtimePaths(configPath, { LOCALAPPDATA: localAppData });
  await mkdir(paths.directory, { recursive: true });
  await writeFile(
    paths.stateFile,
    JSON.stringify({
      endpoint: "http://127.0.0.1:43127",
      token: "secret",
      autonomousApply: false,
    }),
  );

  await assert.rejects(
    startPan({
      configPath,
      toolRoot: path.resolve("."),
      autonomousApply: true,
      openTerminal: false,
      env: { LOCALAPPDATA: localAppData },
      fetchImpl: async () => ({ ok: true }),
    }),
    /stop it before changing modes/i,
  );
});

test("stops a newly launched host when terminal startup fails", async () => {
  const localAppData = await mkdtemp(path.join(os.tmpdir(), "pan-launcher-"));
  const configPath = path.join(localAppData, "domain.json");
  const paths = runtimePaths(configPath, { LOCALAPPDATA: localAppData });
  let launchCount = 0;
  let shutdownRequested = false;
  const spawnProcess = () => {
    launchCount += 1;
    const child = new EventEmitter();
    child.unref = () => {};
    if (launchCount === 1) {
      void mkdir(paths.directory, { recursive: true })
        .then(() =>
          writeFile(
            paths.stateFile,
            JSON.stringify({
              endpoint: "http://127.0.0.1:43127",
              token: "secret",
              autonomousApply: false,
            }),
          ),
        )
        .then(() => child.emit("spawn"));
    } else {
      process.nextTick(() => child.emit("error", new Error("wt failed")));
    }
    return child;
  };
  const fetchImpl = async (url) => {
    if (url.endsWith("/shutdown")) {
      shutdownRequested = true;
    }
    return { ok: true };
  };

  await assert.rejects(
    startPan({
      configPath,
      toolRoot: path.resolve("."),
      env: { LOCALAPPDATA: localAppData },
      spawnProcess,
      fetchImpl,
    }),
    /wt failed/,
  );
  assert.equal(shutdownRequested, true);
});

test("connects Copilot in the current terminal with PAN tools and model", async () => {
  const localAppData = await mkdtemp(path.join(os.tmpdir(), "pan-launcher-"));
  const configPath = path.join(localAppData, "domain.json");
  const paths = runtimePaths(configPath, { LOCALAPPDATA: localAppData });
  await mkdir(paths.directory, { recursive: true });
  await writeFile(
    paths.stateFile,
    JSON.stringify({
      endpoint: "http://127.0.0.1:43127",
      token: "secret",
      autonomousApply: false,
    }),
  );
  let launch;
  const spawnProcess = (executable, args, options) => {
    launch = { executable, args, options };
    const child = new EventEmitter();
    process.nextTick(() => child.emit("close", 0, null));
    return child;
  };

  const result = await connectPan({
    configPath,
    toolRoot: path.resolve("."),
    executable: "copilot-test",
    agentName: "focused-pan",
    model: "gpt-5.6-sol",
    env: { LOCALAPPDATA: localAppData },
    spawnProcess,
    fetchImpl: async () => ({ ok: true }),
  });

  assert.equal(result.model, "gpt-5.6-sol");
  assert.equal(launch.executable, "copilot-test");
  assert.equal(launch.options.stdio, "inherit");
  assert.equal(launch.options.windowsHide, false);
  assert.ok(launch.args.includes("--agent"));
  assert.ok(launch.args.includes("focused-pan"));
  assert.ok(launch.args.includes("--model"));
  assert.ok(launch.args.includes("gpt-5.6-sol"));
});
