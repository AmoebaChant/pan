import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  openSync,
} from "node:fs";
import {
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";

const TOOL_NAMES = [
  "read_portfolio",
  "read_workstream",
  "read_issue",
  "read_runner_availability",
  "propose_actions",
];

export async function startPan({
  configPath,
  toolRoot,
  autonomousApply = false,
  openTerminal = true,
  agentName = "pan",
  model,
  terminalProfile,
  env = process.env,
  spawnProcess = spawn,
  fetchImpl = fetch,
  sleep = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
}) {
  const resolvedConfig = path.resolve(configPath);
  const paths = runtimePaths(resolvedConfig, env);
  await mkdir(paths.directory, { recursive: true });
  let state = await readReadyState(paths.stateFile, fetchImpl);
  let started = false;
  if (
    state &&
    Boolean(state.autonomousApply) !== Boolean(autonomousApply)
  ) {
    throw new Error(
      `PAN is already running with autonomous apply ${state.autonomousApply ? "enabled" : "disabled"}; stop it before changing modes`,
    );
  }
  if (!state) {
    await rm(paths.stateFile, { force: true });
    await launchHost({
      configPath: resolvedConfig,
      stateFile: paths.stateFile,
      logFile: paths.logFile,
      toolRoot,
      autonomousApply,
      spawnProcess,
    });
    state = await waitForReady(paths.stateFile, fetchImpl, sleep);
    started = true;
  }

  try {
    await writeMcpConfig(paths.mcpConfig, {
      stateFile: paths.stateFile,
      mcpExecutable: path.join(toolRoot, "bin", "pan-mcp.js"),
    });
    if (openTerminal) {
      await launchInteractiveTerminal({
        mcpConfig: paths.mcpConfig,
        toolRoot,
        agentName,
        model,
        terminalProfile,
        spawnProcess,
        env,
      });
    }
  } catch (error) {
    if (started) {
      await requestShutdown(state, fetchImpl).catch(() => {});
    }
    throw error;
  }
  return {
    started,
    terminalOpened: openTerminal,
    stateFile: paths.stateFile,
    endpoint: state.endpoint,
    autonomousApply: state.autonomousApply,
  };
}

export async function stopPan({
  configPath,
  env = process.env,
  fetchImpl = fetch,
  sleep = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
}) {
  const paths = runtimePaths(path.resolve(configPath), env);
  let state;
  try {
    state = JSON.parse(await readFile(paths.stateFile, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return { stopped: false, reason: "not-running" };
    }
    throw error;
  }
  await requestShutdown(state, fetchImpl);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await readFile(paths.stateFile, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") {
        return { stopped: true };
      }
      throw error;
    }
    await sleep(100);
  }
  throw new Error("PAN host did not stop within 10 seconds");
}

export async function preparePanRuntime({
  configPath,
  toolRoot,
  stateFile,
  env = process.env,
}) {
  const paths = runtimePaths(path.resolve(configPath), env);
  const resolvedStateFile = stateFile
    ? path.resolve(stateFile)
    : paths.stateFile;
  await mkdir(paths.directory, { recursive: true });
  await writeMcpConfig(paths.mcpConfig, {
    stateFile: resolvedStateFile,
    mcpExecutable: path.join(toolRoot, "bin", "pan-mcp.js"),
  });
  return { ...paths, stateFile: resolvedStateFile };
}

export async function connectPan({
  configPath,
  toolRoot,
  executable = "copilot",
  agentName = "pan",
  model,
  env = process.env,
  spawnProcess = spawn,
  fetchImpl = fetch,
}) {
  const paths = await preparePanRuntime({ configPath, toolRoot, env });
  const state = await readReadyState(paths.stateFile, fetchImpl);
  if (!state) {
    throw new Error(
      "PAN host is not running. Start it in another terminal with `pan start --config <path>`.",
    );
  }
  const args = buildInteractiveCopilotArgs({
    toolRoot,
    mcpConfig: paths.mcpConfig,
    agentName,
    model,
  });
  const child = spawnProcess(executable, args, {
    cwd: toolRoot,
    env,
    stdio: "inherit",
    windowsHide: false,
  });
  const [code, signal] = await waitForExit(child);
  if (code !== 0) {
    throw new Error(
      `Copilot interactive session exited with code ${code}, signal ${signal ?? "none"}`,
    );
  }
  return {
    model: model ?? "auto",
    endpoint: state.endpoint,
    mcpConfig: paths.mcpConfig,
  };
}

export function runtimePaths(configPath, env = process.env) {
  const base =
    env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
  const identity = createHash("sha256")
    .update(path.resolve(configPath).toLowerCase())
    .digest("hex")
    .slice(0, 16);
  const directory = path.join(base, "PAN", "runtime", identity);
  return {
    directory,
    stateFile: path.join(directory, "host.json"),
    logFile: path.join(directory, "host.log"),
    mcpConfig: path.join(directory, "mcp.json"),
  };
}

async function launchHost({
  configPath,
  stateFile,
  logFile,
  toolRoot,
  autonomousApply,
  spawnProcess,
}) {
  const output = openSync(logFile, "a");
  const child = spawnProcess(
    process.execPath,
    [
      path.join(toolRoot, "bin", "pan.js"),
      "host",
      "--config",
      configPath,
      "--state-file",
      stateFile,
      ...(autonomousApply ? ["--apply"] : []),
    ],
    {
      detached: true,
      stdio: ["ignore", output, output],
      windowsHide: true,
    },
  );
  try {
    await spawned(child);
    child.unref();
  } finally {
    closeSync(output);
  }
}

async function launchInteractiveTerminal({
  mcpConfig,
  toolRoot,
  agentName,
  model,
  terminalProfile,
  spawnProcess,
  env,
}) {
  const copilotArgs = buildInteractiveCopilotArgs({
    toolRoot,
    mcpConfig,
    agentName,
    model,
  });
  const child = spawnProcess(
    env.PAN_WINDOWS_TERMINAL ?? "wt.exe",
    [
      "-w",
      "0",
      "nt",
      ...(terminalProfile ? ["-p", terminalProfile] : []),
      "-d",
      toolRoot,
      "--title",
      "Pan",
      "--suppressApplicationTitle",
      "copilot",
      ...copilotArgs,
    ],
    {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    },
  );
  await spawned(child);
  child.unref();
}

export function buildInteractiveCopilotArgs({
  toolRoot,
  mcpConfig,
  agentName = "pan",
  model,
  sessionId = randomUUID(),
}) {
  return [
    "-C",
    toolRoot,
    "--agent",
    agentName,
    "--additional-mcp-config",
    `@${mcpConfig}`,
    "--disable-builtin-mcps",
    ...TOOL_NAMES.map((name) => `--available-tools=pan-tools-${name}`),
    "--allow-tool=pan-tools",
    "--no-auto-update",
    "--disallow-temp-dir",
    "--session-id",
    sessionId,
    ...(model ? ["--model", model] : []),
    "-i",
    "Read the complete PAN portfolio, then greet me with the single most important thing I should work on next and why.",
  ];
}

async function writeMcpConfig(filePath, { stateFile, mcpExecutable }) {
  await writeFile(
    filePath,
    `${JSON.stringify(
      {
        mcpServers: {
          "pan-tools": {
            type: "stdio",
            command: process.execPath,
            args: [mcpExecutable],
            env: {
              PAN_MCP_SERVER: "1",
              PAN_RUNTIME_STATE: stateFile,
            },
            tools: TOOL_NAMES,
          },
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

async function waitForReady(stateFile, fetchImpl, sleep) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const state = await readReadyState(stateFile, fetchImpl);
    if (state) {
      return state;
    }
    await sleep(100);
  }
  throw new Error("PAN host did not become ready within 30 seconds");
}

async function readReadyState(stateFile, fetchImpl) {
  try {
    const state = JSON.parse(await readFile(stateFile, "utf8"));
    const response = await fetchImpl(`${state.endpoint}/health`, {
      headers: { authorization: `Bearer ${state.token}` },
    });
    return response.ok ? state : undefined;
  } catch {
    return undefined;
  }
}

async function waitForExit(child) {
  return once(child, "close");
}

function spawned(child) {
  return new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
}

async function requestShutdown(state, fetchImpl) {
  const response = await fetchImpl(`${state.endpoint}/shutdown`, {
    method: "POST",
    headers: { authorization: `Bearer ${state.token}` },
  });
  if (!response.ok) {
    throw new Error(`PAN host refused shutdown with HTTP ${response.status}`);
  }
}
