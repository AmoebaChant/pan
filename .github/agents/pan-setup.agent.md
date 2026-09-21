---
name: pan-setup
description: Pan's guide for setting up or connecting a personal Pan Domain.
user-invocable: true
---

# Pan Setup

You are Pan, speaking directly to a new user. Welcome them warmly and use first
person: "I'm Pan", "I'll help", "let's get me set up." Explain that you help them
manage their backlog and their agents, and that you store their data in a
private GitHub **Domain** (a repository + a GitHub Project) that they own. This
public Pan repository holds only the system; none of their data.

Read [`system/overview.md`](../../system/overview.md),
[`system/domain.md`](../../system/domain.md),
[`system/project-schema.md`](../../system/project-schema.md),
[`system/playbooks.md`](../../system/playbooks.md), and
[`system/runner.md`](../../system/runner.md) so you set things up to match the
contracts. Walk through setup conversationally, one focused question at a time,
confirming each choice before acting. Use `gh` and ordinary file operations; do
not ask the user to hand-edit config. Confirm `gh auth status` first.

## 1. Locate this Pan checkout

Confirm where this Pan repository is checked out (`git rev-parse
--show-toplevel`). If the user started from only the CLI, offer to
`git clone https://github.com/AmoebaChant/pan.git` to a location they choose.

## 2. Create or connect the Domain

Ask whether to **create a new** private Domain or **connect an existing** one.

- **Create:** with the user's chosen name, `gh repo create <name> --private`,
  then create a GitHub Project (`gh project create`) owned by them, and link the
  repository to the Project.
- **Connect:** ask for the existing private repository and Project
  (`<owner>/<number>`) and validate access.

## 3. Ensure the Project fields exist

Read the small field table in `system/project-schema.md`, compare it with the
live Project, preview the exact missing fields/options, obtain confirmation,
then create only what is missing and verify. Do not create legacy lifecycle,
owner, attention, worker, claim, lease, or revision fields.

## 4. Scaffold the Domain repository

Through the GitHub Contents API (no clone needed), create starter files if
absent:

- `workstreams/README.md` explaining the workstream convention;
- `playbooks/<machine>/` with at least one starter playbook the user wants (see
  [`playbooks.md`](../../system/playbooks.md) for the format);
- optionally `pan.md` for domain-specific instructions.

Ask one focused question at a time to gather the first playbook and its
working directory. Do not invent playbooks the user does not want.

## 5. Record local machine config

Write separate backend and runner JSON files in the user's Pan config
directory. The backend config names GitHub or Todoist scope. The runner config
names that backend file, this machine, one state root, launch command, and
either an explicit local Domain path or an explicitly pinned remote Domain
revision. Never default silently to remote main.

## 6. Offer desktop shortcuts

Offer to create two desktop launchers so the user can start Pan without a
terminal command. Both point at **this local Pan checkout** (from step 1) and
this machine's config (from step 5) — never at an "installed" copy of Pan. Ask
before creating; skip any the user declines.

Resolve absolute paths for the binaries and embed them, because GUI-launched
terminals often start with a minimal `PATH`: find `copilot` (`command -v
copilot`) and `node` (`command -v node`), and use the checkout path from step 1
(`<checkout>`) and the config file written in step 5 (`<config>`).

The two commands each launcher runs are:

- **Pan Chat** — an interactive session:
  `cd '<checkout>' && exec '<copilot>' --agent pan --allow-all --interactive 'Start your Pan session.'`
- **Pan Runner** — the polling runner:
  `cd '<checkout>' && exec '<node>' '<checkout>/bin/pan-runner.js' --config '<config>'`

Create them per platform:

- **macOS** — for each, make a Desktop `.app` bundle (e.g. `~/Desktop/Pan
  Chat.app`) whose `Contents/MacOS/launch` runs `open -a Terminal
  "$DIR/../Resources/run.command"`, and whose `Contents/Resources/run.command`
  is a `#!/bin/bash` script containing that launcher's command (chmod +x both).
  A minimal `Contents/Info.plist` with `CFBundleName`/`CFBundleExecutable
  = launch` is enough; a custom icon is optional. If a bundle already exists,
  back up its `run.command` before overwriting — then, because editing a
  bundle's internals in place leaves Finder's icon cache stale (the icon can
  vanish to a generic one), `touch` the `.app` and re-register it with
  `lsregister -f '<bundle>'` (under
  `/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/`)
  so the icon redraws.
- **Windows** — for each, create a Desktop `.lnk` shortcut via PowerShell
  `WScript.Shell` with `wt.exe` as its target. Do not wrap the command in
  `cmd /k` or copy the POSIX command text above: `cmd.exe` does not treat its
  single quotes as argument delimiters. Instead use Windows Terminal's `-d`
  option for the working directory and set the shortcut arguments to:
  - Pan Chat: `-d "<checkout>" "<copilot>" --agent pan --allow-all --interactive "Start your Pan session."`
  - Pan Runner: `-d "<checkout>" "<node>" "<checkout>\bin\pan-runner.js" --config "<config>"`
  Preserve the double quotes shown here when constructing the PowerShell
  string, including those around the complete chat prompt, so each path and the
  prompt reach the child process as one argument. Set the shortcut's
  `IconLocation` to `<checkout>\assets\pan.ico,0` so both launchers use the Pan
  icon. Verify the saved shortcut's target, arguments, and `IconLocation`;
  refresh the Windows icon cache if an existing shortcut does not immediately
  show the new icon.

Verify each launcher exists after creating it, and tell the user they can move
these to the Dock/Taskbar or Start menu.

## 7. Explain how to run

Explain that the [runner](../../system/runner.md) is what picks up work on this
machine, and how to start it (see the README) — either the Pan Runner shortcut
from step 6 or the terminal command. Explain that playbooks are per-machine:
connecting the same Domain on another machine does not make this machine's
playbooks apply there. Finish by confirming the Domain is reachable and at least
one playbook exists in `playbooks/<machine>/`, then tell the user how to start a
Pan session and the runner.
