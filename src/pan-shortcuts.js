import { access, chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ProcessClient } from "./process-client.js";

const MODULE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SELECTIONS = ["chat", "runner", "both"];
const ICON_SIZES = [16, 32, 128, 256, 512];

/** Creates self-contained launch shortcuts for a configured Pan domain. */
export async function createPanDesktopShortcuts({
  configPath,
  runnerProfilePath,
  domainPath,
  approvalMode = "prompt",
  selection = "both",
  desktopPath,
  iconPath = path.join(MODULE_ROOT, "assets", "pan.ico"),
  env = process.env,
  platform = process.platform,
  homedir = os.homedir,
  commands = new ProcessClient(),
  moduleRoot = MODULE_ROOT,
  nodePath = process.execPath,
  iconConverter,
} = {}) {
  if (platform !== "win32" && platform !== "darwin") {
    throw new Error(
      "Pan desktop shortcuts are currently supported on Windows and macOS only",
    );
  }
  if (!SELECTIONS.includes(selection)) {
    throw new TypeError(`shortcut selection must be one of ${SELECTIONS.join(", ")}`);
  }
  requireAbsolutePath(configPath, "configPath");
  requireAbsolutePath(runnerProfilePath, "runnerProfilePath");
  requireAbsolutePath(domainPath, "domainPath");
  requireAbsolutePath(iconPath, "iconPath");
  requireAbsolutePath(moduleRoot, "moduleRoot");
  requireAbsolutePath(nodePath, "nodePath");
  const launchers = buildPanLaunchers({
    configPath: path.resolve(configPath),
    runnerProfilePath: path.resolve(runnerProfilePath),
    approvalMode,
    nodePath,
    moduleRoot,
  });
  await access(iconPath);
  await validatePanLaunchers({
    ...launchers,
    selection,
    env,
    commands,
  });

  const desktop = desktopPath
    ? path.resolve(desktopPath)
    : await discoverDesktopPath({
        env,
        platform,
        homedir,
        commands,
      });
  await mkdir(desktop, { recursive: true });
  const shortcuts =
    platform === "darwin"
      ? await createMacShortcuts({
          configPath: path.resolve(configPath),
          runnerProfilePath: path.resolve(runnerProfilePath),
          domainPath: path.resolve(domainPath),
          approvalMode,
          selection,
          desktop,
          iconPath: path.resolve(iconPath),
          env,
          commands,
          iconConverter,
          ...launchers,
        })
      : await createWindowsShortcuts({
          configPath: path.resolve(configPath),
          runnerProfilePath: path.resolve(runnerProfilePath),
          domainPath: path.resolve(domainPath),
          approvalMode,
          selection,
          desktop,
          iconPath: path.resolve(iconPath),
          env,
          commands,
          ...launchers,
        });
  return { status: "created", desktopPath: desktop, shortcuts };
}

async function createWindowsShortcuts({
  configPath,
  runnerProfilePath,
  domainPath,
  approvalMode,
  selection,
  desktop,
  iconPath,
  env,
  commands,
  ...launchers
}) {
  const terminal = await windowsTerminalPath(env);
  const definitions = shortcutDefinitions({
    configPath,
    runnerProfilePath,
    domainPath,
    approvalMode,
    selection,
    ...launchers,
  });
  const shortcuts = [];
  for (const definition of definitions) {
    const shortcutPath = path.join(desktop, definition.name);
    await Promise.all(
      (definition.legacyNames ?? []).map((name) =>
        rm(path.join(desktop, name), { force: true }),
      ),
    );
    await writeShortcut({
      shortcutPath,
      targetPath: terminal,
      argumentsValue: definition.arguments,
      workingDirectory: domainPath,
      iconPath,
      description: definition.description,
      env,
      commands,
    });
    shortcuts.push({
      kind: definition.kind,
      path: shortcutPath,
      iconPath,
      command: definition.command,
    });
  }
  return shortcuts;
}

async function createMacShortcuts({
  configPath,
  runnerProfilePath,
  domainPath,
  approvalMode,
  selection,
  desktop,
  iconPath,
  env,
  commands,
  iconConverter = convertIcoToIcns,
  nodePath,
  panEntryPath,
  runnerEntryPath,
}) {
  const definitions = macShortcutDefinitions({
    configPath,
    runnerProfilePath,
    domainPath,
    approvalMode,
    selection,
    nodePath,
    panEntryPath,
    runnerEntryPath,
  });
  const workDir = await mkdtemp(path.join(os.tmpdir(), "pan-icns-"));
  try {
    const icnsSource = await iconConverter({
      iconPath,
      workDir,
      env,
      commands,
    });
    const shortcuts = [];
    // Only the selected shortcuts are managed here; unselected bundles are left
    // in place. This matches the Windows semantics, where shortcutDefinitions
    // returns only the selected definitions and each removes only its own name.
    for (const definition of definitions) {
      const bundlePath = path.join(desktop, definition.name);
      await rm(bundlePath, { recursive: true, force: true });
      const contents = path.join(bundlePath, "Contents");
      const macOsDir = path.join(contents, "MacOS");
      const resources = path.join(contents, "Resources");
      await mkdir(macOsDir, { recursive: true });
      await mkdir(resources, { recursive: true });
      const launchPath = path.join(macOsDir, "launch");
      const commandPath = path.join(resources, "run.command");
      const iconTarget = path.join(resources, "pan.icns");
      await writeFile(path.join(contents, "Info.plist"), definition.plist);
      await writeFile(launchPath, MAC_LAUNCH_SCRIPT);
      await writeFile(commandPath, definition.runCommand);
      await copyFile(icnsSource, iconTarget);
      await chmod(launchPath, 0o755);
      await chmod(commandPath, 0o755);
      shortcuts.push({
        kind: definition.kind,
        path: bundlePath,
        iconPath: iconTarget,
        command: definition.command,
      });
    }
    return shortcuts;
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

const MAC_LAUNCH_SCRIPT = [
  "#!/bin/bash",
  'DIR="$(cd "$(dirname "$0")" && pwd)"',
  'open -a Terminal "$DIR/../Resources/run.command"',
  "",
].join("\n");

function macShortcutDefinitions({
  configPath,
  runnerProfilePath,
  domainPath,
  approvalMode,
  selection,
  nodePath,
  panEntryPath,
  runnerEntryPath,
}) {
  const definitions = [];
  if (selection === "chat" || selection === "both") {
    const command = [
      "exec",
      shellQuote(nodePath),
      shellQuote(panEntryPath),
      "session",
      "--config",
      shellQuote(configPath),
      ...(approvalMode === "allow-all" ? ["--allow-all-tools"] : []),
    ].join(" ");
    definitions.push({
      kind: "chat",
      name: "Start Pan Chat.app",
      command,
      runCommand: macRunCommand(domainPath, command),
      plist: infoPlist({
        name: "Start Pan Chat",
        identifier: "com.amoebachant.pan.chat",
      }),
    });
  }
  if (selection === "runner" || selection === "both") {
    const command = [
      "exec",
      shellQuote(nodePath),
      shellQuote(runnerEntryPath),
      "--profile",
      shellQuote(runnerProfilePath),
    ].join(" ");
    definitions.push({
      kind: "runner",
      name: "Start Pan Runner.app",
      command,
      runCommand: macRunCommand(domainPath, command),
      plist: infoPlist({
        name: "Start Pan Runner",
        identifier: "com.amoebachant.pan.runner",
      }),
    });
  }
  return definitions;
}

function macRunCommand(domainPath, command) {
  return [
    "#!/bin/bash",
    `cd ${shellQuote(domainPath)} || exit 1`,
    command,
    "",
  ].join("\n");
}

function infoPlist({ name, identifier }) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>CFBundleName</key>",
    `  <string>${name}</string>`,
    "  <key>CFBundleDisplayName</key>",
    `  <string>${name}</string>`,
    "  <key>CFBundleIdentifier</key>",
    `  <string>${identifier}</string>`,
    "  <key>CFBundleExecutable</key>",
    "  <string>launch</string>",
    "  <key>CFBundleIconFile</key>",
    "  <string>pan</string>",
    "  <key>CFBundlePackageType</key>",
    "  <string>APPL</string>",
    "  <key>CFBundleVersion</key>",
    "  <string>1.0</string>",
    "  <key>CFBundleShortVersionString</key>",
    "  <string>1.0</string>",
    "  <key>NSHighResolutionCapable</key>",
    "  <true/>",
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

/** Converts a packaged .ico into an .icns using the standard macOS tools. */
export async function convertIcoToIcns({ iconPath, workDir, env, commands }) {
  const options = { env, timeout: 30_000, maxBuffer: 8 * 1024 * 1024 };
  const pngPath = path.join(workDir, "pan.png");
  await commands.run("sips", ["-s", "format", "png", iconPath, "--out", pngPath], options);
  const iconsetDir = path.join(workDir, "pan.iconset");
  await mkdir(iconsetDir, { recursive: true });
  for (const size of ICON_SIZES) {
    await commands.run(
      "sips",
      ["-z", String(size), String(size), pngPath, "--out", path.join(iconsetDir, `icon_${size}x${size}.png`)],
      options,
    );
    const retina = size * 2;
    await commands.run(
      "sips",
      ["-z", String(retina), String(retina), pngPath, "--out", path.join(iconsetDir, `icon_${size}x${size}@2x.png`)],
      options,
    );
  }
  const icnsPath = path.join(workDir, "pan.icns");
  await commands.run("iconutil", ["-c", "icns", iconsetDir, "-o", icnsPath], options);
  return icnsPath;
}

export async function discoverDesktopPath({
  env = process.env,
  platform = process.platform,
  homedir = os.homedir,
  commands = new ProcessClient(),
} = {}) {
  if (platform === "darwin") {
    return path.join(homedir(), "Desktop");
  }
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
  approvalMode,
  selection,
  nodePath,
  panEntryPath,
  runnerEntryPath,
  launchCommands,
}) {
  const definitions = [];
  if (selection === "chat" || selection === "both") {
    definitions.push({
      kind: "chat",
      name: "Start Pan Chat.lnk",
      legacyNames: ["Start PAN Chat.lnk"],
      description: "Start an interactive Pan session",
      arguments: [
        "new-tab",
        "-d",
        quote(domainPath),
        "--title",
        quote("Pan Chat"),
        "--suppressApplicationTitle",
        quote(nodePath),
        quote(panEntryPath),
        "session",
        "--config",
        quote(configPath),
        ...(approvalMode === "allow-all" ? ["--allow-all-tools"] : []),
      ].join(" "),
      command: launchCommands.chat,
    });
  }
  if (selection === "runner" || selection === "both") {
    definitions.push({
      kind: "runner",
      name: "Start Pan Runner.lnk",
      legacyNames: ["Start PAN Runner.lnk"],
      description: "Start the Pan runner",
      arguments: [
        "new-tab",
        "-d",
        quote(domainPath),
        "--title",
        quote("Pan Runner"),
        "--suppressApplicationTitle",
        quote(nodePath),
        quote(runnerEntryPath),
        "--profile",
        quote(runnerProfilePath),
      ].join(" "),
      command: launchCommands.runner,
    });
  }
  return definitions;
}

export function buildPanLaunchers({
  configPath,
  runnerProfilePath,
  approvalMode = "prompt",
  moduleRoot = MODULE_ROOT,
  nodePath = process.execPath,
}) {
  requireAbsolutePath(configPath, "configPath");
  requireAbsolutePath(runnerProfilePath, "runnerProfilePath");
  requireAbsolutePath(moduleRoot, "moduleRoot");
  requireAbsolutePath(nodePath, "nodePath");
  if (!["prompt", "allow-all"].includes(approvalMode)) {
    throw new TypeError('approvalMode must be "prompt" or "allow-all"');
  }
  const panEntryPath = path.join(moduleRoot, "bin", "pan.js");
  const runnerEntryPath = path.join(moduleRoot, "bin", "pan-runner.js");
  const chatArgs = [
    panEntryPath,
    "session",
    "--config",
    configPath,
    ...(approvalMode === "allow-all" ? ["--allow-all-tools"] : []),
  ];
  return {
    configPath,
    runnerProfilePath,
    nodePath,
    panEntryPath,
    runnerEntryPath,
    launchCommands: {
      chat: powershellCommand(nodePath, chatArgs),
      runner: powershellCommand(nodePath, [
        runnerEntryPath,
        "--profile",
        runnerProfilePath,
      ]),
    },
  };
}

export async function validatePanLaunchers({
  configPath,
  runnerProfilePath,
  selection,
  nodePath,
  panEntryPath,
  runnerEntryPath,
  env,
  commands,
}) {
  await Promise.all([
    access(nodePath),
    access(panEntryPath),
    ...(selection === "runner" || selection === "both"
      ? [access(runnerEntryPath)]
      : []),
  ]);
  await commands.run(
    nodePath,
    [
      panEntryPath,
      "config",
      "validate",
      "--schema-version",
      "1",
      "--config",
      configPath,
      "--json",
    ],
    { env, timeout: 30_000, maxBuffer: 1024 * 1024 },
  );
  if (selection === "runner" || selection === "both") {
    await commands.run(
      nodePath,
      [runnerEntryPath, "--profile", runnerProfilePath, "--validate-profile"],
      { env, timeout: 30_000, maxBuffer: 1024 * 1024 },
    );
  }
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
      throw new Error("Windows Terminal is required to create Pan desktop shortcuts");
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

function shellQuote(value) {
  // Wrap in single quotes; close/escape/reopen for embedded single quotes.
  // This prevents shell expansion or command substitution from interpolated
  // paths that contain $, backticks, spaces, quotes, or other metacharacters.
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

function powershellCommand(executable, args) {
  return `& ${[executable, ...args].map(powershellQuote).join(" ")}`;
}

function powershellQuote(value) {
  return `'${value.replaceAll("'", "''")}'`;
}
