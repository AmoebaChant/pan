# Playbooks

A **playbook** is a named kind of work plus the instructions for doing it. In
this design playbooks are identified by **name only** — they are not tied to a
repository. Triage picks a playbook by name for each agent task; a runner runs a
task only if the machine it is on lists that playbook name.

## Where playbooks live

Playbook definitions live in the **Domain** repository at
`playbooks/<machine>/<name>.md`. Definitions are **per machine**: `<machine>`
is the machine name (matching a `machines/<machine>.md`) and `<name>` (the
file's basename without `.md`) is the playbook name written into the Project
`playbook` field. The same playbook name may be defined differently on
different machines, so each machine that runs a playbook has its own file for it
— there is no shared default and no fallback. Whichever machine claims a task
runs its own definition of that playbook name. The Pan tool repository defines
only the *format* below and the base instructions every worker gets; it ships no
concrete playbooks.

## Playbook definition format

`playbooks/<machine>/<name>.md` is Markdown with a small YAML front matter and a
free-form instructions body:

```markdown
---
name: tool-development
description: Open a pull request against a repo that fixes the Issue.
workingDirectory: null        # optional; see below
---

# tool-development

<Everything below the front matter is the agent instructions for this kind of
work. Say plainly how to set up the workspace, how to build and test, and how
to deliver the result (open a PR, commit to a branch, write an investigation,
etc.). These instructions plus the Issue text are the only things guiding the
worker, so be explicit and complete.>
```

Front matter fields:

- `name` (required) — must equal the filename basename.
- `description` (required) — one line, shown during triage to help pick.
- `workingDirectory` (optional) — an absolute path the worker is launched in
  when this playbook owns its own workspace. When omitted, the runner is
  responsible for preparing an isolated workspace as its instructions require.
  Because playbook files are now per machine, this path is naturally
  machine-specific; the `machines/<machine>.md` table's `workingDirectory`
  column still overrides it if set.

The instructions body carries everything else — how to isolate work, build,
test, and deliver. There are no capability tokens and no `repo:` selector; the
target repository, if any, is described in the instructions and the Issue.

## Which machines run which playbooks

Each machine declares the playbooks its runner may run in
`machines/<machine>.md` in the Domain repository:

```markdown
---
machine: kevins-macbook
---

# kevins-macbook

| playbook | capacity | workingDirectory |
| --- | --- | --- |
| tool-development | 1 | /Users/kevin/repos/pan |
| adulting-errand | 2 | |
```

- `capacity` is the number of concurrent tasks this machine will run for that
  playbook. `0` disables the playbook here without removing it.
- `workingDirectory` (optional) overrides the playbook's default on this
  machine.
- A machine only runs playbooks listed here. A playbook name that appears on no
  machine is defined but unrunnable, and triage should not assign it unless a
  machine will be given it.

## How triage uses playbooks

During [triage](triage.md), for each agent task, Pan reads the available
`playbooks/*/*.md` across every machine, picks the one whose `description` and
instructions fit the task, and writes its **name** into the Project `playbook`
field. The name is the routing key; the same name may be defined differently per
machine, and whichever machine claims the task runs its own definition. If no
playbook fits, the task is not agent-ready: either keep it `human`-owned, keep
it `needs-detail`, or propose creating a new playbook.

## How the runner uses playbooks

A [runner](runner.md) claims a task only when its `playbook` field names a
playbook in this machine's `machines/<machine>.md` with spare capacity. It then
launches a worker with the playbook's instructions, the full Pan system context,
and the Issue contents.
