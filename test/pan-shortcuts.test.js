import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createPanDesktopShortcuts,
  discoverDesktopPath,
} from "../src/index.js";

async function setupMacDomain() {
  const root = await mkdtemp(path.join(os.tmpdir(), "pan-mac-shortcuts-"));
  const desktop = path.join(root, "Desktop");
  const moduleRoot = path.join(root, "package");
  const nodePath = path.join(root, "node", "bin", "node");
  const panEntry = path.join(moduleRoot, "bin", "pan.js");
  const runnerEntry = path.join(moduleRoot, "bin", "pan-runner.js");
  const icon = path.join(root, "pan.ico");
  const configPath = path.join(root, "domain", "pan.json");
  const runnerProfilePath = path.join(root, "domain", "runners", "machine.json");
  await mkdir(desktop, { recursive: true });
  await mkdir(path.dirname(panEntry), { recursive: true });
  await mkdir(path.dirname(nodePath), { recursive: true });
  await Promise.all([
    writeFile(nodePath, ""),
    writeFile(panEntry, ""),
    writeFile(runnerEntry, ""),
    writeFile(icon, "icon"),
  ]);
  const calls = [];
  const commands = {
    async run(executable, args, options) {
      calls.push({ executable, args, options });
      if (executable === "sips") {
        const out = args[args.indexOf("--out") + 1];
        await writeFile(out, "png");
      } else if (executable === "iconutil") {
        const out = args[args.indexOf("-o") + 1];
        await writeFile(out, "icns");
      }
      return "";
    },
  };
  return {
    root,
    desktop,
    moduleRoot,
    nodePath,
    panEntry,
    runnerEntry,
    icon,
    configPath,
    runnerProfilePath,
    domainPath: path.join(root, "domain"),
    calls,
    commands,
  };
}

async function isOwnerExecutable(filePath) {
  const info = await stat(filePath);
  return (info.mode & 0o100) !== 0;
}

function sh(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

function escapeRegExp(value) {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("creates macOS chat and runner app bundles", async () => {
  const ctx = await setupMacDomain();
  try {
    const result = await createPanDesktopShortcuts({
      configPath: ctx.configPath,
      runnerProfilePath: ctx.runnerProfilePath,
      domainPath: ctx.domainPath,
      approvalMode: "allow-all",
      selection: "both",
      desktopPath: ctx.desktop,
      iconPath: ctx.icon,
      env: {},
      platform: "darwin",
      moduleRoot: ctx.moduleRoot,
      nodePath: ctx.nodePath,
      commands: ctx.commands,
    });

    assert.equal(result.status, "created");
    assert.equal(result.desktopPath, ctx.desktop);
    assert.deepEqual(
      result.shortcuts.map(({ kind }) => kind),
      ["chat", "runner", "update"],
    );
    assert.deepEqual(
      result.shortcuts.map(({ path: bundlePath }) => path.basename(bundlePath)),
      ["Pan Chat.app", "Pan Runner.app", "Update Pan.app"],
    );

    const chatBundle = path.join(ctx.desktop, "Pan Chat.app");
    const runnerBundle = path.join(ctx.desktop, "Pan Runner.app");
    const updateBundle = path.join(ctx.desktop, "Update Pan.app");
    for (const bundle of [chatBundle, runnerBundle, updateBundle]) {
      await access(path.join(bundle, "Contents", "Info.plist"));
      await access(path.join(bundle, "Contents", "MacOS", "launch"));
      await access(path.join(bundle, "Contents", "Resources", "run.command"));
      await access(path.join(bundle, "Contents", "Resources", "pan.icns"));
      assert.ok(
        await isOwnerExecutable(path.join(bundle, "Contents", "MacOS", "launch")),
      );
      assert.ok(
        await isOwnerExecutable(
          path.join(bundle, "Contents", "Resources", "run.command"),
        ),
      );
    }

    const chatPlist = await readFile(
      path.join(chatBundle, "Contents", "Info.plist"),
      "utf8",
    );
    assert.match(chatPlist, /<key>CFBundleExecutable<\/key>\s*<string>launch<\/string>/);
    assert.match(chatPlist, /<key>CFBundleIconFile<\/key>\s*<string>pan<\/string>/);
    assert.match(chatPlist, /^<\?xml/);

    const chatCommand = await readFile(
      path.join(chatBundle, "Contents", "Resources", "run.command"),
      "utf8",
    );
    assert.match(chatCommand, /^#!\/bin\/bash/);
    assert.ok(chatCommand.includes(`cd ${sh(ctx.domainPath)}`));
    assert.ok(
      chatCommand.includes(
        `exec ${sh(ctx.nodePath)} ${sh(ctx.panEntry)} session --config ${sh(ctx.configPath)} --allow-all-tools`,
      ),
    );

    const runnerCommand = await readFile(
      path.join(runnerBundle, "Contents", "Resources", "run.command"),
      "utf8",
    );
    assert.ok(runnerCommand.includes(`cd ${sh(ctx.domainPath)}`));
    assert.ok(
      runnerCommand.includes(
        `exec ${sh(ctx.nodePath)} ${sh(ctx.runnerEntry)} --profile ${sh(ctx.runnerProfilePath)}`,
      ),
    );
    assert.ok(!runnerCommand.includes("--allow-all-tools"));

    const updateCommand = await readFile(
      path.join(updateBundle, "Contents", "Resources", "run.command"),
      "utf8",
    );
    // Update Pan moves to this Pan checkout, requires main, fast-forwards, then
    // repairs assets. The pull must appear before `assets repair`, and the pull
    // must short-circuit so a failed update never reaches repair.
    assert.match(updateCommand, /^#!\/bin\/bash/);
    assert.ok(updateCommand.includes(`cd ${sh(ctx.moduleRoot)} || exit 1`));
    assert.ok(updateCommand.includes('branch="$(git rev-parse --abbrev-ref HEAD)"'));
    assert.ok(updateCommand.includes('if [ "$branch" != "main" ]; then'));
    const pullIndex = updateCommand.indexOf(
      "git -c core.fileMode=false pull --ff-only origin main || exit 1",
    );
    const repairIndex = updateCommand.indexOf(
      `exec ${sh(ctx.nodePath)} ${sh(ctx.panEntry)} assets repair`,
    );
    assert.ok(pullIndex > -1, "update pulls main");
    assert.ok(repairIndex > -1, "update repairs assets");
    assert.ok(pullIndex < repairIndex, "pull runs before repair");
    // core.fileMode=false is not enough: the launcher modes are snapshotted
    // before the pull and restored afterward so pre-existing executable bits
    // survive an upstream content update.
    const panSnapIndex = updateCommand.indexOf(`stat -f %Lp ${sh(ctx.panEntry)}`);
    const runnerSnapIndex = updateCommand.indexOf(
      `stat -f %Lp ${sh(ctx.runnerEntry)}`,
    );
    assert.ok(panSnapIndex > -1 && runnerSnapIndex > -1, "snapshots launcher modes");
    assert.ok(
      panSnapIndex < pullIndex && runnerSnapIndex < pullIndex,
      "snapshots modes before the pull",
    );
    const panRestore = updateCommand.match(
      new RegExp(`chmod "\\$mode_\\d+" ${escapeRegExp(sh(ctx.panEntry))}`),
    );
    const runnerRestore = updateCommand.match(
      new RegExp(`chmod "\\$mode_\\d+" ${escapeRegExp(sh(ctx.runnerEntry))}`),
    );
    assert.ok(panRestore, "restores the pan.js mode");
    assert.ok(runnerRestore, "restores the pan-runner.js mode");
    assert.ok(
      panRestore.index > pullIndex && panRestore.index < repairIndex,
      "restores pan.js mode after pull and before repair",
    );
    assert.ok(
      runnerRestore.index > pullIndex && runnerRestore.index < repairIndex,
      "restores pan-runner.js mode after pull and before repair",
    );
    // The returned command metadata is exactly the run.command that executes,
    // so it faithfully includes the checkout, branch, and mode-preservation
    // steps and cannot drift from execution.
    const updateShortcut = result.shortcuts.find(({ kind }) => kind === "update");
    assert.equal(updateShortcut.command, updateCommand);
    const updatePlist = await readFile(
      path.join(updateBundle, "Contents", "Info.plist"),
      "utf8",
    );
    assert.match(
      updatePlist,
      /<key>CFBundleName<\/key>\s*<string>Update Pan<\/string>/,
    );
    // Update Pan uses the same packaged Pan icon and shared conversion as the
    // chat and runner bundles: the plist references pan.icns and the single
    // ico->icns conversion output is copied into every bundle.
    assert.match(
      updatePlist,
      /<key>CFBundleIconFile<\/key>\s*<string>pan<\/string>/,
    );
    for (const kind of ["chat", "runner", "update"]) {
      const shortcut = result.shortcuts.find((entry) => entry.kind === kind);
      assert.equal(path.basename(shortcut.iconPath), "pan.icns");
    }
    // A single shared conversion feeds all three bundles.
    assert.equal(
      ctx.calls.filter(({ executable }) => executable === "iconutil").length,
      1,
    );

    const launch = await readFile(
      path.join(chatBundle, "Contents", "MacOS", "launch"),
      "utf8",
    );
    assert.ok(launch.includes('open -a Terminal "$DIR/../Resources/run.command"'));

    assert.ok(ctx.calls.some(({ executable }) => executable === "sips"));
    assert.ok(ctx.calls.some(({ executable }) => executable === "iconutil"));
  } finally {
    await rm(ctx.root, { recursive: true, force: true });
  }
});

test("omits --allow-all-tools for the macOS chat bundle under prompt mode", async () => {
  const ctx = await setupMacDomain();
  try {
    await createPanDesktopShortcuts({
      configPath: ctx.configPath,
      runnerProfilePath: ctx.runnerProfilePath,
      domainPath: ctx.domainPath,
      approvalMode: "prompt",
      selection: "chat",
      desktopPath: ctx.desktop,
      iconPath: ctx.icon,
      env: {},
      platform: "darwin",
      moduleRoot: ctx.moduleRoot,
      nodePath: ctx.nodePath,
      commands: ctx.commands,
    });
    const chatCommand = await readFile(
      path.join(ctx.desktop, "Pan Chat.app", "Contents", "Resources", "run.command"),
      "utf8",
    );
    assert.ok(!chatCommand.includes("--allow-all-tools"));
  } finally {
    await rm(ctx.root, { recursive: true, force: true });
  }
});

test("creates only the selected macOS bundle", async () => {
  const chatCtx = await setupMacDomain();
  try {
    const chatResult = await createPanDesktopShortcuts({
      configPath: chatCtx.configPath,
      runnerProfilePath: chatCtx.runnerProfilePath,
      domainPath: chatCtx.domainPath,
      selection: "chat",
      desktopPath: chatCtx.desktop,
      iconPath: chatCtx.icon,
      env: {},
      platform: "darwin",
      moduleRoot: chatCtx.moduleRoot,
      nodePath: chatCtx.nodePath,
      commands: chatCtx.commands,
    });
    assert.deepEqual(
      chatResult.shortcuts.map(({ kind }) => kind),
      ["chat", "update"],
    );
    await access(path.join(chatCtx.desktop, "Pan Chat.app"));
    await access(path.join(chatCtx.desktop, "Update Pan.app"));
    await assert.rejects(
      access(path.join(chatCtx.desktop, "Pan Runner.app")),
      { code: "ENOENT" },
    );
  } finally {
    await rm(chatCtx.root, { recursive: true, force: true });
  }

  const runnerCtx = await setupMacDomain();
  try {
    const runnerResult = await createPanDesktopShortcuts({
      configPath: runnerCtx.configPath,
      runnerProfilePath: runnerCtx.runnerProfilePath,
      domainPath: runnerCtx.domainPath,
      selection: "runner",
      desktopPath: runnerCtx.desktop,
      iconPath: runnerCtx.icon,
      env: {},
      platform: "darwin",
      moduleRoot: runnerCtx.moduleRoot,
      nodePath: runnerCtx.nodePath,
      commands: runnerCtx.commands,
    });
    assert.deepEqual(
      runnerResult.shortcuts.map(({ kind }) => kind),
      ["runner", "update"],
    );
    await access(path.join(runnerCtx.desktop, "Pan Runner.app"));
    await access(path.join(runnerCtx.desktop, "Update Pan.app"));
    await assert.rejects(
      access(path.join(runnerCtx.desktop, "Pan Chat.app")),
      { code: "ENOENT" },
    );
  } finally {
    await rm(runnerCtx.root, { recursive: true, force: true });
  }
});

test("single-quotes shell-unsafe characters in the macOS run.command", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pan-mac-spicy-"));
  const spicy = "spa ce $HOME `whoami`";
  const desktop = path.join(root, "Desktop");
  const moduleRoot = path.join(root, spicy, "package");
  const nodePath = path.join(root, spicy, "node", "bin", "node");
  const panEntry = path.join(moduleRoot, "bin", "pan.js");
  const runnerEntry = path.join(moduleRoot, "bin", "pan-runner.js");
  const icon = path.join(root, "pan.ico");
  const domainPath = path.join(root, spicy, "domain");
  const configPath = path.join(domainPath, "pan.json");
  const runnerProfilePath = path.join(domainPath, "runners", "machine.json");
  await mkdir(desktop, { recursive: true });
  await mkdir(path.dirname(panEntry), { recursive: true });
  await mkdir(path.dirname(nodePath), { recursive: true });
  await Promise.all([
    writeFile(nodePath, ""),
    writeFile(panEntry, ""),
    writeFile(runnerEntry, ""),
    writeFile(icon, "icon"),
  ]);
  const commands = {
    async run(executable, args) {
      if (executable === "sips") {
        await writeFile(args[args.indexOf("--out") + 1], "png");
      } else if (executable === "iconutil") {
        await writeFile(args[args.indexOf("-o") + 1], "icns");
      }
      return "";
    },
  };

  try {
    await createPanDesktopShortcuts({
      configPath,
      runnerProfilePath,
      domainPath,
      approvalMode: "allow-all",
      selection: "both",
      desktopPath: desktop,
      iconPath: icon,
      env: {},
      platform: "darwin",
      moduleRoot,
      nodePath,
      commands,
    });

    const chatCommand = await readFile(
      path.join(desktop, "Pan Chat.app", "Contents", "Resources", "run.command"),
      "utf8",
    );
    const runnerCommand = await readFile(
      path.join(desktop, "Pan Runner.app", "Contents", "Resources", "run.command"),
      "utf8",
    );
    const updateCommand = await readFile(
      path.join(desktop, "Update Pan.app", "Contents", "Resources", "run.command"),
      "utf8",
    );

    assert.ok(chatCommand.includes(`cd ${sh(domainPath)} || exit 1`));
    assert.ok(
      chatCommand.includes(
        `exec ${sh(nodePath)} ${sh(panEntry)} session --config ${sh(configPath)} --allow-all-tools`,
      ),
    );
    assert.ok(
      runnerCommand.includes(
        `exec ${sh(nodePath)} ${sh(runnerEntry)} --profile ${sh(runnerProfilePath)}`,
      ),
    );
    assert.ok(updateCommand.includes(`cd ${sh(moduleRoot)} || exit 1`));
    assert.ok(
      updateCommand.includes(`exec ${sh(nodePath)} ${sh(panEntry)} assets repair`),
    );

    for (const command of [chatCommand, runnerCommand, updateCommand]) {
      // The spicy string survives verbatim (inside single quotes).
      assert.ok(command.includes(spicy));
      // No unescaped $ or backtick can leak outside single quotes.
      for (const line of command.split("\n")) {
        if (!line.startsWith("cd ") && !line.startsWith("exec ")) continue;
        let inSingle = false;
        for (const ch of line) {
          if (ch === "'") inSingle = !inSingle;
          else if (!inSingle && (ch === "$" || ch === "`")) {
            assert.fail(`unquoted expansion character in: ${line}`);
          }
        }
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("returns the macOS Desktop path from the home directory", async () => {
  assert.equal(
    await discoverDesktopPath({
      platform: "darwin",
      homedir: () => "/Users/example",
    }),
    path.join("/Users/example", "Desktop"),
  );
});

test("creates chat and runner shortcuts with the packaged Pan icon", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pan-shortcuts-"));
  const desktop = path.join(root, "OneDrive", "Desktop");
  const localAppData = path.join(root, "Local");
  const terminal = path.join(localAppData, "Microsoft", "WindowsApps", "wt.exe");
  const icon = path.join(root, "pan.ico");
  const moduleRoot = path.join(root, "package");
  const panEntry = path.join(moduleRoot, "bin", "pan.js");
  const runnerEntry = path.join(moduleRoot, "bin", "pan-runner.js");
  const legacyChatShortcut = path.join(desktop, "Start PAN Chat.lnk");
  const legacyChatShortcutMixed = path.join(desktop, "Start Pan Chat.lnk");
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
    writeFile(legacyChatShortcutMixed, "legacy"),
  ]);

  try {
    const result = await createPanDesktopShortcuts({
      configPath: path.join(root, "domain", "pan.json"),
      runnerProfilePath: path.join(root, "domain", "runners", "machine.json"),
      domainPath: path.join(root, "domain"),
      approvalMode: "allow-all",
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
            path.basename(options.env.PAN_SHORTCUT_PATH) === "Pan Chat.lnk"
          ) {
            legacyExistsWhenChatWritten =
              (await access(legacyChatShortcut)
                .then(() => true)
                .catch(() => false)) ||
              (await access(legacyChatShortcutMixed)
                .then(() => true)
                .catch(() => false));
          }
          return "";
        },
      },
    });

    assert.equal(result.status, "created");
    assert.deepEqual(
      result.shortcuts.map(({ kind }) => kind),
      ["chat", "runner", "update"],
    );
    assert.deepEqual(
      result.shortcuts.map(({ path: shortcutPath }) => path.basename(shortcutPath)),
      ["Pan Chat.lnk", "Pan Runner.lnk", "Update Pan.lnk"],
    );
    assert.equal(calls.length, 5);
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
    // The node executable name and path separators are host-specific
    // (node.exe and backslashes on Windows, node and forward slashes
    // elsewhere). Assert the portable command structure using the actual
    // executable and entry paths so this coverage runs on every host.
    assert.match(shortcutCalls[0].options.env.PAN_SHORTCUT_ARGUMENTS, /^new-tab /);
    assert.ok(
      shortcutCalls[0].options.env.PAN_SHORTCUT_ARGUMENTS.includes(
        `"${process.execPath}" "${panEntry}" session --config `,
      ),
    );
    assert.match(shortcutCalls[1].options.env.PAN_SHORTCUT_ARGUMENTS, /^new-tab /);
    assert.ok(
      shortcutCalls[1].options.env.PAN_SHORTCUT_ARGUMENTS.includes(
        `"${process.execPath}" "${runnerEntry}" --profile `,
      ),
    );
    assert.doesNotMatch(shortcutCalls[0].options.env.PAN_SHORTCUT_ARGUMENTS, /npx/);
    assert.doesNotMatch(shortcutCalls[1].options.env.PAN_SHORTCUT_ARGUMENTS, /npx/);
    assert.match(
      shortcutCalls[0].options.env.PAN_SHORTCUT_ARGUMENTS,
      /--title "Pan Chat"/,
    );
    assert.match(
      shortcutCalls[0].options.env.PAN_SHORTCUT_ARGUMENTS,
      /--allow-all-tools$/,
    );
    assert.doesNotMatch(
      shortcutCalls[1].options.env.PAN_SHORTCUT_ARGUMENTS,
      /--allow-all-tools/,
    );
    assert.match(result.shortcuts[0].command, /pan\.js' 'session' '--config'/);
    assert.match(result.shortcuts[0].command, /'--allow-all-tools'$/);
    assert.match(result.shortcuts[1].command, /pan-runner\.js' '--profile'/);

    // Update Pan launches PowerShell with a base64-encoded script under Windows
    // Terminal, opened in this Pan checkout, so quoting and `;`/`"` cannot break
    // Windows Terminal argument parsing.
    const updateArgs = shortcutCalls[2].options.env.PAN_SHORTCUT_ARGUMENTS;
    assert.match(updateArgs, /^new-tab /);
    assert.match(updateArgs, new RegExp(`-d "${escapeRegExp(moduleRoot)}"`));
    assert.match(updateArgs, /--title "Update Pan"/);
    assert.match(
      updateArgs,
      /powershell\.exe -NoLogo -NoProfile -NoExit -EncodedCommand ([A-Za-z0-9+/=]+)$/,
    );
    assert.equal(
      shortcutCalls[2].options.env.PAN_SHORTCUT_WORKING_DIRECTORY,
      moduleRoot,
    );
    const encoded = updateArgs.match(/-EncodedCommand ([A-Za-z0-9+/=]+)$/)[1];
    const script = Buffer.from(encoded, "base64").toString("utf16le");
    assert.ok(script.includes("rev-parse --abbrev-ref HEAD"));
    assert.ok(script.includes("$branch -ne 'main'"));
    // A missing/renamed checkout must terminate before git runs, so it can
    // never fast-forward or repair the wrong directory.
    assert.match(
      script,
      new RegExp(
        `^Set-Location -LiteralPath '${escapeRegExp(moduleRoot)}' -ErrorAction Stop$`,
        "m",
      ),
    );
    const setLocationIndex = script.indexOf("Set-Location");
    const revParseIndex = script.indexOf("rev-parse");
    assert.ok(
      setLocationIndex > -1 && setLocationIndex < revParseIndex,
      "checkout is entered before any git command",
    );
    const pullIndex = script.indexOf(
      "git -c core.fileMode=false pull --ff-only origin main",
    );
    const repairIndex = script.indexOf("assets repair");
    assert.ok(pullIndex > -1 && repairIndex > -1);
    assert.ok(pullIndex < repairIndex, "pull runs before repair");
    // The last guard before repair short-circuits a failed pull.
    assert.ok(
      script.indexOf("if ($LASTEXITCODE -ne 0) { exit 1 }", pullIndex) <
        repairIndex,
    );
    // The returned command is exactly the encoded script, so reported metadata
    // cannot drift from what executes, and it never uses `;` to run repair after
    // a failed pull.
    assert.equal(result.shortcuts[2].command, script);
    assert.doesNotMatch(result.shortcuts[2].command, /origin main; /);
    assert.match(result.shortcuts[2].command, /pull --ff-only origin main/);
    assert.match(result.shortcuts[2].command, /pan\.js' assets repair$/);

    // Update Pan uses the same packaged Pan icon as chat and runner.
    assert.equal(
      shortcutCalls[2].options.env.PAN_SHORTCUT_ICON,
      `${icon},0`,
    );
    assert.ok(result.shortcuts.every(({ iconPath }) => iconPath === icon));

    // Legacy names are removed only after the replacement is written, so a
    // failed write can never leave the desktop without a working shortcut.
    assert.equal(legacyExistsWhenChatWritten, true);
    await assert.rejects(access(legacyChatShortcut), {
      code: "ENOENT",
    });
    await assert.rejects(access(legacyChatShortcutMixed), {
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

test("preserves legacy Windows shortcuts when the replacement write fails", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pan-win-fail-"));
  const desktop = path.join(root, "Desktop");
  const localAppData = path.join(root, "Local");
  const terminal = path.join(localAppData, "Microsoft", "WindowsApps", "wt.exe");
  const icon = path.join(root, "pan.ico");
  const moduleRoot = path.join(root, "package");
  const panEntry = path.join(moduleRoot, "bin", "pan.js");
  const runnerEntry = path.join(moduleRoot, "bin", "pan-runner.js");
  const legacy = path.join(desktop, "Start Pan Chat.lnk");
  await mkdir(desktop, { recursive: true });
  await mkdir(path.dirname(terminal), { recursive: true });
  await mkdir(path.dirname(panEntry), { recursive: true });
  await Promise.all([
    writeFile(terminal, ""),
    writeFile(icon, "icon"),
    writeFile(panEntry, ""),
    writeFile(runnerEntry, ""),
    writeFile(legacy, "legacy"),
  ]);

  try {
    await assert.rejects(
      createPanDesktopShortcuts({
        configPath: path.join(root, "domain", "pan.json"),
        runnerProfilePath: path.join(root, "domain", "runners", "machine.json"),
        domainPath: path.join(root, "domain"),
        selection: "chat",
        desktopPath: desktop,
        iconPath: icon,
        env: { LOCALAPPDATA: localAppData },
        platform: "win32",
        moduleRoot,
        commands: {
          async run(executable, args, options) {
            // Launcher validation (node) passes; writing the replacement fails.
            if (executable !== "powershell.exe") return "";
            if (options.env?.PAN_SHORTCUT_PATH?.endsWith("Pan Chat.lnk")) {
              throw new Error("write failed");
            }
            return "";
          },
        },
      }),
      /write failed/,
    );

    // The replacement never succeeded, so the legacy shortcut is still present
    // and no partial replacement was left behind.
    await access(legacy);
    await assert.rejects(access(path.join(desktop, "Pan Chat.lnk")), {
      code: "ENOENT",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("preserves legacy and current macOS bundles when the rebuild fails", async () => {
  const ctx = await setupMacDomain();
  try {
    const legacy = path.join(ctx.desktop, "Start Pan Chat.app");
    const current = path.join(ctx.desktop, "Pan Chat.app");
    await mkdir(path.join(legacy, "Contents"), { recursive: true });
    await writeFile(path.join(legacy, "Contents", "marker"), "legacy");
    await mkdir(path.join(current, "Contents"), { recursive: true });
    await writeFile(path.join(current, "Contents", "marker"), "current");

    await assert.rejects(
      createPanDesktopShortcuts({
        configPath: ctx.configPath,
        runnerProfilePath: ctx.runnerProfilePath,
        domainPath: ctx.domainPath,
        selection: "chat",
        desktopPath: ctx.desktop,
        iconPath: ctx.icon,
        env: {},
        platform: "darwin",
        moduleRoot: ctx.moduleRoot,
        nodePath: ctx.nodePath,
        commands: ctx.commands,
        // The converted icon points nowhere, so copying it into the staged
        // bundle fails mid-build, before any swap or legacy removal.
        iconConverter: async () => path.join(ctx.root, "missing.icns"),
      }),
      { code: "ENOENT" },
    );

    // Both the pre-existing replacement bundle and the legacy bundle survive,
    // and no staging directory is left behind.
    assert.equal(
      await readFile(path.join(current, "Contents", "marker"), "utf8"),
      "current",
    );
    assert.equal(
      await readFile(path.join(legacy, "Contents", "marker"), "utf8"),
      "legacy",
    );
    const entries = await readdir(ctx.desktop);
    assert.ok(
      !entries.some((name) => name.includes("pan-staging")),
      "no staging directory remains",
    );
  } finally {
    await rm(ctx.root, { recursive: true, force: true });
  }
});

test("restores the current macOS bundle when the swap rename fails after backup", async () => {
  const ctx = await setupMacDomain();
  try {
    const legacy = path.join(ctx.desktop, "Start Pan Chat.app");
    const current = path.join(ctx.desktop, "Pan Chat.app");
    await mkdir(path.join(legacy, "Contents"), { recursive: true });
    await writeFile(path.join(legacy, "Contents", "marker"), "legacy");
    await mkdir(path.join(current, "Contents"), { recursive: true });
    await writeFile(path.join(current, "Contents", "marker"), "current");

    // Fail only the staging -> destination rename, which happens after the
    // existing bundle has already been moved aside to its backup. All other
    // renames (existing -> backup, backup -> restore) delegate to the real
    // implementation so the rollback path is exercised end to end.
    let failedOnce = false;
    const renameFile = async (from, to) => {
      if (!failedOnce && from.includes("pan-staging")) {
        failedOnce = true;
        throw Object.assign(new Error("simulated swap failure"), {
          code: "EIO",
        });
      }
      return rename(from, to);
    };

    await assert.rejects(
      createPanDesktopShortcuts({
        configPath: ctx.configPath,
        runnerProfilePath: ctx.runnerProfilePath,
        domainPath: ctx.domainPath,
        selection: "chat",
        desktopPath: ctx.desktop,
        iconPath: ctx.icon,
        env: {},
        platform: "darwin",
        moduleRoot: ctx.moduleRoot,
        nodePath: ctx.nodePath,
        commands: ctx.commands,
        renameFile,
      }),
      { code: "EIO" },
    );

    assert.ok(failedOnce, "the staging swap rename was attempted");

    // The original bundle is restored from its backup, the legacy bundle is
    // untouched, and neither the staging directory nor the backup remains.
    assert.equal(
      await readFile(path.join(current, "Contents", "marker"), "utf8"),
      "current",
    );
    assert.equal(
      await readFile(path.join(legacy, "Contents", "marker"), "utf8"),
      "legacy",
    );
    const swapEntries = await readdir(ctx.desktop);
    assert.ok(
      !swapEntries.some((name) => name.includes("pan-staging")),
      "no staging directory remains",
    );
    assert.ok(
      !swapEntries.some((name) => name.includes("pan-backup")),
      "no backup directory remains",
    );
  } finally {
    await rm(ctx.root, { recursive: true, force: true });
  }
});

test("recovers a leftover backup on retry after a failed restore, then replaces it", async () => {
  const ctx = await setupMacDomain();
  try {
    const current = path.join(ctx.desktop, "Pan Chat.app");
    await mkdir(path.join(current, "Contents"), { recursive: true });
    await writeFile(path.join(current, "Contents", "marker"), "current");
    const backupPath = path.join(ctx.desktop, ".Pan Chat.app.pan-backup");

    // First run: the staging swap fails AND restoring the backup fails, so the
    // original bundle is left only as its backup (the destination is gone).
    const failingRename = async (from, to) => {
      if (from.includes("pan-staging") || from.includes("pan-backup")) {
        throw Object.assign(new Error("simulated failure"), { code: "EIO" });
      }
      return rename(from, to);
    };
    await assert.rejects(
      createPanDesktopShortcuts({
        configPath: ctx.configPath,
        runnerProfilePath: ctx.runnerProfilePath,
        domainPath: ctx.domainPath,
        selection: "chat",
        desktopPath: ctx.desktop,
        iconPath: ctx.icon,
        env: {},
        platform: "darwin",
        moduleRoot: ctx.moduleRoot,
        nodePath: ctx.nodePath,
        commands: ctx.commands,
        renameFile: failingRename,
      }),
      { code: "EIO" },
    );

    // The only working copy now lives in the backup; the destination is absent.
    assert.equal(
      await readFile(path.join(backupPath, "Contents", "marker"), "utf8"),
      "current",
    );
    await assert.rejects(access(current), { code: "ENOENT" });

    // Retry with a working rename: recovery restores the backup, then the new
    // bundle replaces it successfully and leaves nothing behind.
    const result = await createPanDesktopShortcuts({
      configPath: ctx.configPath,
      runnerProfilePath: ctx.runnerProfilePath,
      domainPath: ctx.domainPath,
      selection: "chat",
      desktopPath: ctx.desktop,
      iconPath: ctx.icon,
      env: {},
      platform: "darwin",
      moduleRoot: ctx.moduleRoot,
      nodePath: ctx.nodePath,
      commands: ctx.commands,
    });
    assert.equal(result.status, "created");

    await access(path.join(current, "Contents", "Info.plist"));
    await access(path.join(current, "Contents", "Resources", "pan.icns"));
    await access(path.join(ctx.desktop, "Update Pan.app", "Contents", "Info.plist"));
    const entries = await readdir(ctx.desktop);
    assert.ok(
      !entries.some((name) => name.includes("pan-backup")),
      "no backup directory remains",
    );
    assert.ok(
      !entries.some((name) => name.includes("pan-staging")),
      "no staging directory remains",
    );
  } finally {
    await rm(ctx.root, { recursive: true, force: true });
  }
});

test("restores a crash-left backup from a different launch across process ids and selection order", async () => {
  const ctx = await setupMacDomain();
  try {
    const current = path.join(ctx.desktop, "Pan Chat.app");
    // Simulate a crash in an EARLIER launch: a legacy PID- and selection-order
    // keyed backup that the current process (different PID, different order)
    // must still discover. Only the backup survives; the destination is gone.
    const legacyBackupPath = path.join(
      ctx.desktop,
      ".Pan Chat.app.pan-backup-999999-3",
    );
    await mkdir(path.join(legacyBackupPath, "Contents"), { recursive: true });
    await writeFile(
      path.join(legacyBackupPath, "Contents", "marker"),
      "crashed",
    );

    // Force the rebuild to fail after recovery has already run, proving the
    // backup was restored to the destination rather than deleted.
    await assert.rejects(
      createPanDesktopShortcuts({
        configPath: ctx.configPath,
        runnerProfilePath: ctx.runnerProfilePath,
        domainPath: ctx.domainPath,
        selection: "chat",
        desktopPath: ctx.desktop,
        iconPath: ctx.icon,
        env: {},
        platform: "darwin",
        moduleRoot: ctx.moduleRoot,
        nodePath: ctx.nodePath,
        commands: ctx.commands,
        iconConverter: async () => path.join(ctx.root, "missing.icns"),
      }),
      { code: "ENOENT" },
    );

    // The crash-left backup was restored to the destination and never deleted.
    assert.equal(
      await readFile(path.join(current, "Contents", "marker"), "utf8"),
      "crashed",
    );
    const entries = await readdir(ctx.desktop);
    assert.ok(
      !entries.some((name) => name.includes("pan-backup")),
      "no backup directory remains",
    );
    assert.ok(
      !entries.some((name) => name.includes("pan-staging")),
      "no staging directory remains",
    );
  } finally {
    await rm(ctx.root, { recursive: true, force: true });
  }
});

test("reconciles duplicate backups without accumulation and prefers the canonical copy", async () => {
  const ctx = await setupMacDomain();
  try {
    const current = path.join(ctx.desktop, "Pan Chat.app");
    // Destination is missing but two candidate backups survive from different
    // launches: the canonical deterministic name and a legacy PID-keyed one.
    const canonicalBackup = path.join(ctx.desktop, ".Pan Chat.app.pan-backup");
    const legacyBackup = path.join(
      ctx.desktop,
      ".Pan Chat.app.pan-backup-123456-9",
    );
    for (const [backup, marker] of [
      [canonicalBackup, "canonical"],
      [legacyBackup, "legacy"],
    ]) {
      await mkdir(path.join(backup, "Contents"), { recursive: true });
      await writeFile(path.join(backup, "Contents", "marker"), marker);
    }

    // Fail the new swap so recovery's restored copy remains the visible state.
    const failingRename = async (from, to) => {
      if (from.includes("pan-staging")) {
        throw Object.assign(new Error("simulated failure"), { code: "EIO" });
      }
      return rename(from, to);
    };
    await assert.rejects(
      createPanDesktopShortcuts({
        configPath: ctx.configPath,
        runnerProfilePath: ctx.runnerProfilePath,
        domainPath: ctx.domainPath,
        selection: "chat",
        desktopPath: ctx.desktop,
        iconPath: ctx.icon,
        env: {},
        platform: "darwin",
        moduleRoot: ctx.moduleRoot,
        nodePath: ctx.nodePath,
        commands: ctx.commands,
        renameFile: failingRename,
      }),
      { code: "EIO" },
    );

    // The canonical backup was restored to the destination; the duplicate was
    // reconciled away and no backups accumulate.
    assert.equal(
      await readFile(path.join(current, "Contents", "marker"), "utf8"),
      "canonical",
    );
    const entries = await readdir(ctx.desktop);
    assert.ok(
      !entries.some((name) => name.includes("pan-backup")),
      "no backup directories remain",
    );
    assert.ok(
      !entries.some((name) => name.includes("pan-staging")),
      "no staging directory remains",
    );
  } finally {
    await rm(ctx.root, { recursive: true, force: true });
  }
});

test("removes stale backups from earlier launches when the destination is valid", async () => {
  const ctx = await setupMacDomain();
  try {
    const current = path.join(ctx.desktop, "Pan Chat.app");
    await mkdir(path.join(current, "Contents"), { recursive: true });
    await writeFile(path.join(current, "Contents", "marker"), "valid");
    // A valid destination plus stale backups left by earlier launches.
    for (const name of [
      ".Pan Chat.app.pan-backup",
      ".Pan Chat.app.pan-backup-42-0",
    ]) {
      const backup = path.join(ctx.desktop, name);
      await mkdir(path.join(backup, "Contents"), { recursive: true });
      await writeFile(path.join(backup, "Contents", "marker"), "stale");
    }

    const result = await createPanDesktopShortcuts({
      configPath: ctx.configPath,
      runnerProfilePath: ctx.runnerProfilePath,
      domainPath: ctx.domainPath,
      selection: "chat",
      desktopPath: ctx.desktop,
      iconPath: ctx.icon,
      env: {},
      platform: "darwin",
      moduleRoot: ctx.moduleRoot,
      nodePath: ctx.nodePath,
      commands: ctx.commands,
    });
    assert.equal(result.status, "created");

    await access(path.join(current, "Contents", "Info.plist"));
    const entries = await readdir(ctx.desktop);
    assert.ok(
      !entries.some((name) => name.includes("pan-backup")),
      "stale backups are removed beside a valid destination",
    );
    assert.ok(
      !entries.some((name) => name.includes("pan-staging")),
      "no staging directory remains",
    );
  } finally {
    await rm(ctx.root, { recursive: true, force: true });
  }
});
