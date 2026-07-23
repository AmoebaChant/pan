import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
  const calls = [];
  await mkdir(desktop, { recursive: true });
  await mkdir(path.dirname(terminal), { recursive: true });
  await Promise.all([writeFile(terminal, ""), writeFile(icon, "icon")]);

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
      commands: {
        async run(executable, args, options) {
          calls.push({ executable, args, options });
          return "";
        },
      },
    });

    assert.equal(result.status, "created");
    assert.deepEqual(
      result.shortcuts.map(({ kind }) => kind),
      ["chat", "runner"],
    );
    assert.equal(calls.length, 2);
    assert.ok(calls.every(({ executable }) => executable === "powershell.exe"));
    assert.ok(
      calls.every(
        ({ options }) => options.env.PAN_SHORTCUT_ICON === `${icon},0`,
      ),
    );
    assert.match(
      calls[0].options.env.PAN_SHORTCUT_ARGUMENTS,
      /^new-tab .* cmd\.exe \/d \/c npx\.cmd /,
    );
    assert.match(
      calls[1].options.env.PAN_SHORTCUT_ARGUMENTS,
      /^new-tab .* cmd\.exe \/d \/c npx\.cmd /,
    );
    assert.match(calls[0].options.env.PAN_SHORTCUT_ARGUMENTS, /session --config/);
    assert.match(calls[1].options.env.PAN_SHORTCUT_ARGUMENTS, /pan-runner --profile/);
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
