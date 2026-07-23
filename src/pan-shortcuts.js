import { access, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ProcessClient } from "./process-client.js";

const MODULE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE_NAME = "@amoebachant/pan";
const SELECTIONS = ["chat", "runner", "both"];

/** Creates self-contained Windows launch shortcuts for a configured PAN domain. */
export async function createPanDesktopShortcuts({
  configPath,
  runnerProfilePath,
  domainPath,
  selection = "both",
  desktopPath,
  iconPath = path.join(MODULE_ROOT, "assets", "pan.ico"),
  env = process.env,
  platform = process.platform,
  homedir = os.homedir,
  commands = new ProcessClient(),
} = {}) {
  if (platform !== "win32") {
    throw new Error("PAN desktop shortcuts are currently supported on Windows only");
  }
  if (!SELECTIONS.includes(selection)) {
    throw new TypeError(`shortcut selection must be one of ${SELECTIONS.join(", ")}`);
  }
  requireAbsolutePath(configPath, "configPath");
  requireAbsolutePath(runnerProfilePath, "runnerProfilePath");
  requireAbsolutePath(domainPath, "domainPath");
  requireAbsolutePath(iconPath, "iconPath");
  await access(iconPath);

  const desktop = desktopPath
    ? path.resolve(desktopPath)
    : await discoverDesktopPath({
        env,
        platform,
        homedir,
        commands,
      });
  await mkdir(desktop, { recursive: true });
  const terminal = await windowsTerminalPath(env);
  const definitions = shortcutDefinitions({
    configPath: path.resolve(configPath),
    runnerProfilePath: path.resolve(runnerProfilePath),
    domainPath: path.resolve(domainPath),
    selection,
  });
  const shortcuts = [];
  for (const definition of definitions) {
    const shortcutPath = path.join(desktop, definition.name);
    await writeShortcut({
      shortcutPath,
      targetPath: terminal,
      argumentsValue: definition.arguments,
      workingDirectory: path.resolve(domainPath),
      iconPath: path.resolve(iconPath),
      description: definition.description,
      env,
      commands,
    });
    shortcuts.push({
      kind: definition.kind,
      path: shortcutPath,
      iconPath: path.resolve(iconPath),
    });
  }
  return { status: "created", desktopPath: desktop, shortcuts };
}

export async function discoverDesktopPath({
  env = process.env,
  platform = process.platform,
  homedir = os.homedir,
  commands = new ProcessClient(),
} = {}) {
  if (platform === "win32") {
    const desktop = await commands.run(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "[Environment]::GetFolderPath('DesktopDirectory')",
      ],
      {
        env,
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      },
    );
    if (!desktop) {
      throw new Error("Windows did not return a Desktop known-folder path");
    }
    return path.resolve(desktop);
  }
  const candidates = [
    env.OneDriveCommercial,
    env.OneDriveConsumer,
    env.OneDrive,
  ]
    .filter(Boolean)
    .map((root) => path.join(root, "Desktop"));
  candidates.push(path.join(env.USERPROFILE ?? homedir(), "Desktop"));
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return path.resolve(candidate);
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
  }
  return path.resolve(candidates.at(-1));
}

function shortcutDefinitions({
  configPath,
  runnerProfilePath,
  domainPath,
  selection,
}) {
  const definitions = [];
  if (selection === "chat" || selection === "both") {
    definitions.push({
      kind: "chat",
      name: "Start PAN Chat.lnk",
      description: "Start an interactive PAN session",
      arguments: [
        "new-tab",
        "-d",
        quote(domainPath),
        "--title",
        quote("PAN Chat"),
        "--suppressApplicationTitle",
        "cmd.exe",
        "/d",
        "/c",
        "npx.cmd",
        "--yes",
        PACKAGE_NAME,
        "session",
        "--config",
        quote(configPath),
      ].join(" "),
    });
  }
  if (selection === "runner" || selection === "both") {
    definitions.push({
      kind: "runner",
      name: "Start PAN Runner.lnk",
      description: "Start the PAN runner",
      arguments: [
        "new-tab",
        "-d",
        quote(domainPath),
        "--title",
        quote("PAN Runner"),
        "--suppressApplicationTitle",
        "cmd.exe",
        "/d",
        "/c",
        "npx.cmd",
        "--yes",
        "--package",
        PACKAGE_NAME,
        "pan-runner",
        "--profile",
        quote(runnerProfilePath),
      ].join(" "),
    });
  }
  return definitions;
}

async function windowsTerminalPath(env) {
  const candidate = path.join(
    env.LOCALAPPDATA ?? path.join(env.USERPROFILE ?? os.homedir(), "AppData", "Local"),
    "Microsoft",
    "WindowsApps",
    "wt.exe",
  );
  try {
    await access(candidate);
    return candidate;
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error("Windows Terminal is required to create PAN desktop shortcuts");
    }
    throw error;
  }
}

async function writeShortcut({
  shortcutPath,
  targetPath,
  argumentsValue,
  workingDirectory,
  iconPath,
  description,
  env,
  commands,
}) {
  const script = [
    "$shell = New-Object -ComObject WScript.Shell",
    "$shortcut = $shell.CreateShortcut($env:PAN_SHORTCUT_PATH)",
    "$shortcut.TargetPath = $env:PAN_SHORTCUT_TARGET",
    "$shortcut.Arguments = $env:PAN_SHORTCUT_ARGUMENTS",
    "$shortcut.WorkingDirectory = $env:PAN_SHORTCUT_WORKING_DIRECTORY",
    "$shortcut.IconLocation = $env:PAN_SHORTCUT_ICON",
    "$shortcut.Description = $env:PAN_SHORTCUT_DESCRIPTION",
    "$shortcut.Save()",
  ].join("; ");
  await commands.run(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    {
      env: {
        ...env,
        PAN_SHORTCUT_PATH: shortcutPath,
        PAN_SHORTCUT_TARGET: targetPath,
        PAN_SHORTCUT_ARGUMENTS: argumentsValue,
        PAN_SHORTCUT_WORKING_DIRECTORY: workingDirectory,
        PAN_SHORTCUT_ICON: `${iconPath},0`,
        PAN_SHORTCUT_DESCRIPTION: description,
      },
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    },
  );
}

function requireAbsolutePath(value, name) {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw new TypeError(`${name} must be an absolute path`);
  }
}

function quote(value) {
  return `"${value.replaceAll('"', '\\"')}"`;
}
