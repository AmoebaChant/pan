import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createPanDesktopShortcuts,
  discoverDesktopPath,
} from "../src/index.js";

test("creates chat and runner shortcuts with the packaged PAN icon", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pan-shortcuts-"));
  const desktop = path.join(root, "OneDrive", "Desktop");
  const localAppData = path.join(root, "Local");
  const terminal = path.join(localAppData, "Microsoft", "WindowsApps", "wt.exe");
  const icon = path.join(root, "pan.ico");
  const moduleRoot = path.join(root, "package");
  const panEntry = path.join(moduleRoot, "bin", "pan.js");
  const runnerEntry = path.join(moduleRoot, "bin", "pan-runner.js");
  const legacyChatShortcut = path.join(desktop, "Start PAN Chat.lnk");
  const calls = [];
  let legacyExistsWhenChatWritten;
  await mkdir(desktop, { recursive: true });
  await mkdir(path.dirname(terminal), { recursive: true });
  await mkdir(path.dirname(panEntry), { recursive: true });
  await Promise.all([
    writeFile(terminal, ""),
    writeFile(icon, "icon"),
    writeFile(panEntry, ""),
    writeFile(runnerEntry, ""),
    writeFile(legacyChatShortcut, "legacy"),
  ]);

  try {
    const result = await createPanDesktopShortcuts({
      configPath: path.join(root, "domain", "pan.json"),
      runnerProfilePath: path.join(root, "domain", "runners", "machine.json"),
      domainPath: path.join(root, "domain"),
      selection: "both",
      desktopPath: desktop,
      iconPath: icon,
      env: {
        OneDriveCommercial: path.join(root, "OneDrive"),
        LOCALAPPDATA: localAppData,
      },
      platform: "win32",
      moduleRoot,
      commands: {
        async run(executable, args, options) {
          calls.push({ executable, args, options });
          if (
            executable === "powershell.exe" &&
            path.basename(options.env.PAN_SHORTCUT_PATH) === "Start Pan Chat.lnk"
          ) {
            legacyExistsWhenChatWritten = await access(legacyChatShortcut)
              .then(() => true)
              .catch(() => false);
          }
          return "";
        },
      },
    });

    assert.equal(result.status, "created");
    assert.deepEqual(
      result.shortcuts.map(({ kind }) => kind),
      ["chat", "runner"],
    );
    assert.deepEqual(
      result.shortcuts.map(({ path: shortcutPath }) => path.basename(shortcutPath)),
      ["Start Pan Chat.lnk", "Start PAN Runner.lnk"],
    );
    assert.equal(calls.length, 4);
    assert.equal(calls[0].executable, process.execPath);
    assert.deepEqual(calls[0].args, [
      panEntry,
      "config",
      "validate",
      "--schema-version",
      "1",
      "--config",
      path.join(root, "domain", "pan.json"),
      "--json",
    ]);
    assert.equal(calls[1].executable, process.execPath);
    assert.deepEqual(calls[1].args, [
      runnerEntry,
      "--profile",
      path.join(root, "domain", "runners", "machine.json"),
      "--validate-profile",
    ]);
    const shortcutCalls = calls.slice(2);
    assert.ok(shortcutCalls.every(({ executable }) => executable === "powershell.exe"));
    assert.ok(
      shortcutCalls.every(
        ({ options }) => options.env.PAN_SHORTCUT_ICON === `${icon},0`,
      ),
    );
    assert.match(
      shortcutCalls[0].options.env.PAN_SHORTCUT_ARGUMENTS,
      /^new-tab .*node\.exe" ".*\\pan\.js" session --config/,
    );
    assert.match(
      shortcutCalls[1].options.env.PAN_SHORTCUT_ARGUMENTS,
      /^new-tab .*node\.exe" ".*\\pan-runner\.js" --profile/,
    );
    assert.doesNotMatch(shortcutCalls[0].options.env.PAN_SHORTCUT_ARGUMENTS, /npx/);
    assert.doesNotMatch(shortcutCalls[1].options.env.PAN_SHORTCUT_ARGUMENTS, /npx/);
    assert.match(
      shortcutCalls[0].options.env.PAN_SHORTCUT_ARGUMENTS,
      /--title "Pan Chat"/,
    );
    assert.match(result.shortcuts[0].command, /pan\.js' 'session' '--config'/);
    assert.match(result.shortcuts[1].command, /pan-runner\.js' '--profile'/);
    assert.equal(legacyExistsWhenChatWritten, false);
    await assert.rejects(access(legacyChatShortcut), {
      code: "ENOENT",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("uses the Windows Desktop known-folder path", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pan-desktop-"));
  const redirected = path.join(root, "OneDrive - Example", "Desktop");
  await mkdir(redirected, { recursive: true });
  const calls = [];
  try {
    assert.equal(
      await discoverDesktopPath({
        platform: "win32",
        commands: {
          async run(executable, args) {
            calls.push({ executable, args });
            return redirected;
          },
        },
      }),
      redirected,
    );
    assert.equal(calls[0].executable, "powershell.exe");
    assert.match(calls[0].args.at(-1), /DesktopDirectory/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
