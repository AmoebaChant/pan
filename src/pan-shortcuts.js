import { access, chmod, copyFile, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
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
  renameFile = rename,
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
          renameFile,
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
    // Write the replacement first; only remove legacy names once it succeeds so
    // a failure never leaves the desktop without a working shortcut.
    await writeShortcut({
      shortcutPath,
      targetPath: terminal,
      argumentsValue: definition.arguments,
      workingDirectory: definition.workingDirectory ?? domainPath,
      iconPath,
      description: definition.description,
      env,
      commands,
    });
    await Promise.all(
      (definition.legacyNames ?? []).map((name) =>
        rm(path.join(desktop, name), { force: true }),
      ),
    );
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
  panRepoPath,
  renameFile = rename,
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
    panRepoPath,
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
    for (const [index, definition] of definitions.entries()) {
      const bundlePath = path.join(desktop, definition.name);
      // Build the new bundle in a staging directory, then swap it in with
      // rollback (see swapBundleIntoPlace) and only then remove legacy names.
      // Any failure leaves the existing same-named bundle and all legacy
      // bundles intact, so the user is never left without a working shortcut.
      const stagingPath = path.join(
        desktop,
        `.${definition.name}.pan-staging-${process.pid}-${index}`,
      );
      const backupPath = path.join(
        desktop,
        `.${definition.name}.pan-backup-${process.pid}-${index}`,
      );
      await rm(stagingPath, { recursive: true, force: true });
      // Recover from a swap that a previous run left interrupted before doing
      // anything destructive. If a backup survives, it may be the only working
      // copy (Update Pan has no legacy fallback), so restore it to the
      // destination instead of deleting it.
      await recoverInterruptedSwap({ bundlePath, backupPath, renameFile });
      try {
        const contents = path.join(stagingPath, "Contents");
        const macOsDir = path.join(contents, "MacOS");
        const resources = path.join(contents, "Resources");
        await mkdir(macOsDir, { recursive: true });
        await mkdir(resources, { recursive: true });
        const launchPath = path.join(macOsDir, "launch");
        const commandPath = path.join(resources, "run.command");
        const stagedIcon = path.join(resources, "pan.icns");
        await writeFile(path.join(contents, "Info.plist"), definition.plist);
        await writeFile(launchPath, MAC_LAUNCH_SCRIPT);
        await writeFile(commandPath, definition.runCommand);
        await copyFile(icnsSource, stagedIcon);
        await chmod(launchPath, 0o755);
        await chmod(commandPath, 0o755);
        await swapBundleIntoPlace({
          stagingPath,
          bundlePath,
          backupPath,
          renameFile,
        });
      } catch (error) {
        await rm(stagingPath, { recursive: true, force: true });
        throw error;
      }
      await Promise.all(
        (definition.legacyNames ?? []).map((name) =>
          rm(path.join(desktop, name), { recursive: true, force: true }),
        ),
      );
      shortcuts.push({
        kind: definition.kind,
        path: bundlePath,
        iconPath: path.join(bundlePath, "Contents", "Resources", "pan.icns"),
        command: definition.command,
      });
    }
    return shortcuts;
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

/**
 * Recovers from a swap that a previous run (or a crash) left interrupted, before
 * any destructive cleanup runs. States handled:
 *
 * - backup absent: nothing to do.
 * - backup present, destination absent: the swap was interrupted after the
 *   original bundle was moved to its backup but before the replacement landed,
 *   so the backup is the only working copy. Restore it to the destination.
 * - backup present, destination present: the backup is a stale leftover beside a
 *   valid destination, so it is safe to remove.
 *
 * A backup is never removed unless a valid destination is already present.
 */
async function recoverInterruptedSwap({
  bundlePath,
  backupPath,
  renameFile = rename,
}) {
  if (!(await pathExists(backupPath))) {
    return;
  }
  if (await pathExists(bundlePath)) {
    await rm(backupPath, { recursive: true, force: true });
    return;
  }
  await renameFile(backupPath, bundlePath);
}

async function pathExists(target) {
  try {
    await access(target);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

/**
 * Atomically replaces an existing bundle with a fully-built staging bundle.
 * The existing bundle is first moved to a same-filesystem backup so it can be
 * restored if the swap fails partway; the backup is deleted only after the new
 * bundle is successfully in place. On any failure the original bundle is
 * restored (or, if even the restore fails, the backup is left as the only copy
 * for recoverInterruptedSwap to reinstate on the next run).
 */
async function swapBundleIntoPlace({
  stagingPath,
  bundlePath,
  backupPath,
  renameFile = rename,
}) {
  let backedUp = false;
  try {
    await renameFile(bundlePath, backupPath);
    backedUp = true;
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
  try {
    await renameFile(stagingPath, bundlePath);
  } catch (error) {
    if (backedUp) {
      // Best-effort restore of the original bundle; surface the original error.
      try {
        await renameFile(backupPath, bundlePath);
      } catch {
        // Leave the backup in place rather than deleting the only copy.
      }
    }
    throw error;
  }
  if (backedUp) {
    await rm(backupPath, { recursive: true, force: true });
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
  panRepoPath,
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
      name: "Pan Chat.app",
      legacyNames: ["Start Pan Chat.app", "Start PAN Chat.app"],
      command,
      runCommand: macRunCommand(domainPath, command),
      plist: infoPlist({
        name: "Pan Chat",
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
      name: "Pan Runner.app",
      legacyNames: ["Start Pan Runner.app", "Start PAN Runner.app"],
      command,
      runCommand: macRunCommand(domainPath, command),
      plist: infoPlist({
        name: "Pan Runner",
        identifier: "com.amoebachant.pan.runner",
      }),
    });
  }
  // Update Pan is always offered whenever shortcuts are created, independent of
  // the chat/runner selection. It updates this Pan checkout, then repairs the
  // installed Copilot assets. `command` is the exact run.command body so the
  // reported metadata cannot drift from what actually executes.
  const updateRunCommand = macUpdateRunCommand({
    panRepoPath,
    nodePath,
    panEntryPath,
    runnerEntryPath,
  });
  definitions.push({
    kind: "update",
    name: "Update Pan.app",
    legacyNames: [],
    command: updateRunCommand,
    runCommand: updateRunCommand,
    plist: infoPlist({
      name: "Update Pan",
      identifier: "com.amoebachant.pan.update",
    }),
  });
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

function macUpdateRunCommand({ panRepoPath, nodePath, panEntryPath, runnerEntryPath }) {
  // core.fileMode=false lets the fast-forward proceed past a local mode-only
  // change, but when the pull updates a tracked launcher it rewrites that file
  // with upstream's (non-executable) mode, dropping any pre-existing executable
  // bit. core.fileMode=false alone does NOT preserve modes: snapshot each
  // launcher's mode before the pull and restore it afterward.
  const preserved = [panEntryPath, runnerEntryPath];
  const snapshots = preserved.map(
    (file, index) =>
      `mode_${index}="$(stat -f %Lp ${shellQuote(file)})" || exit 1`,
  );
  const restores = preserved.map(
    (file, index) => `chmod "$mode_${index}" ${shellQuote(file)} || exit 1`,
  );
  return [
    "#!/bin/bash",
    `cd ${shellQuote(panRepoPath)} || exit 1`,
    'branch="$(git rev-parse --abbrev-ref HEAD)" || exit 1',
    'if [ "$branch" != "main" ]; then',
    `  echo "Update Pan requires the main branch, but this Pan checkout is on '$branch'." >&2`,
    "  exit 1",
    "fi",
    ...snapshots,
    "git -c core.fileMode=false pull --ff-only origin main || exit 1",
    ...restores,
    `exec ${shellQuote(nodePath)} ${shellQuote(panEntryPath)} assets repair`,
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
  panRepoPath,
  launchCommands,
}) {
  const definitions = [];
  if (selection === "chat" || selection === "both") {
    definitions.push({
      kind: "chat",
      name: "Pan Chat.lnk",
      legacyNames: ["Start Pan Chat.lnk", "Start PAN Chat.lnk"],
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
      name: "Pan Runner.lnk",
      legacyNames: ["Start Pan Runner.lnk", "Start PAN Runner.lnk"],
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
  // Update Pan is always offered whenever shortcuts are created, independent of
  // the chat/runner selection. It updates this Pan checkout, then repairs the
  // installed Copilot assets. The returned `command` is the exact PowerShell
  // that runs; the launch arguments encode that same script, so metadata cannot
  // drift from execution.
  const updateScript = panUpdatePowershellScript({
    panRepoPath,
    nodePath,
    panEntryPath,
  });
  definitions.push({
    kind: "update",
    name: "Update Pan.lnk",
    legacyNames: [],
    description: "Update this Pan checkout and repair its Copilot assets",
    workingDirectory: panRepoPath,
    arguments: [
      "new-tab",
      "-d",
      quote(panRepoPath),
      "--title",
      quote("Update Pan"),
      "--suppressApplicationTitle",
      "powershell.exe",
      "-NoLogo",
      "-NoProfile",
      "-NoExit",
      "-EncodedCommand",
      encodePowershellCommand(updateScript),
    ].join(" "),
    command: updateScript,
  });
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
    panRepoPath: moduleRoot,
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

/**
 * The PowerShell steps the Update Pan shortcut runs: move to this Pan checkout
 * (a terminating failure so a missing/renamed checkout never lets git run in the
 * wrong directory), confirm it is on main, fast-forward main, and only then
 * repair the installed Copilot assets. Each native step is guarded by
 * $LASTEXITCODE so a failure short-circuits before `pan assets repair` runs.
 * Windows does not track POSIX executable bits on these launchers, so no mode
 * snapshot/restore is needed here (unlike the macOS run.command).
 */
function panUpdatePowershellScript({ panRepoPath, nodePath, panEntryPath }) {
  return [
    `Set-Location -LiteralPath ${powershellQuote(panRepoPath)} -ErrorAction Stop`,
    "$branch = & git rev-parse --abbrev-ref HEAD",
    "if ($LASTEXITCODE -ne 0) { exit 1 }",
    `if ($branch -ne 'main') { Write-Error "Update Pan requires the main branch, but this Pan checkout is on '$branch'."; exit 1 }`,
    "& git -c core.fileMode=false pull --ff-only origin main",
    "if ($LASTEXITCODE -ne 0) { exit 1 }",
    `& ${powershellQuote(nodePath)} ${powershellQuote(panEntryPath)} assets repair`,
  ].join("\n");
}

// PowerShell -EncodedCommand takes a base64 of a UTF-16LE string. Encoding the
// whole update script avoids fragile quoting and Windows Terminal's use of `;`
// and `"` as argument delimiters.
function encodePowershellCommand(script) {
  return Buffer.from(script, "utf16le").toString("base64");
}
