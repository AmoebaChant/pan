# Playbooks

A **playbook** is a named kind of work plus the instructions for doing it. In
this design playbooks are identified by **name only** — they are not tied to a
repository. Triage picks a playbook by name for each agent task; a runner runs a
task only if the machine it is on has a playbook file with that name.

## Where playbooks live

Playbook definitions live in the **Domain** repository at
`playbooks/<machine>/<name>.md`. Definitions are **per machine**: `<machine>`
is the machine name and `<name>` (the file's basename without `.md`) is the
playbook name written into the Project `playbook` field. A machine runs
**exactly** the playbooks present in its `playbooks/<machine>/` folder — the
folder is the list. The same playbook name may be defined differently on
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
capacity: 1                   # concurrent tasks on this machine; 0 disables
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
- `capacity` (required) — a non-negative integer: the number of concurrent
  tasks this machine will run for this playbook. `0` disables the playbook on
  this machine without removing its file.
- `workingDirectory` (optional) — an absolute path the worker is launched in
  when this playbook owns its own workspace. When omitted, the runner is
  responsible for preparing an isolated workspace as its instructions require.
  Because playbook files are per machine, this path is naturally
  machine-specific.
- `workspaceSlots` (optional) — a mapping of named slot ids to absolute paths,
  **mutually exclusive** with `workingDirectory`. It lets one playbook pool work
  across a fixed set of reusable directories instead of a single one:

  ```yaml
  workspaceSlots:
    primary: 'C:\Product'
    secondary: 'C:\Product.2'
  ```

  Each running task occupies exactly one slot, so `capacity` **cannot exceed**
  the slot count (`capacity: 0` still disables the playbook). Slot ids must be
  non-empty and simple (letters, digits, `_`, `-`) and never contain the
  reserved `::`; every path must be absolute; duplicate ids or paths in one
  playbook, and a declared-but-empty mapping, are hard errors. New work takes
  the first free slot; a task that has already run in a slot resumes in that
  exact slot (see [runner](runner.md)).

The instructions body carries everything else — how to isolate work, build,
test, and deliver. There are no capability tokens and no `repo:` selector; the
target repository, if any, is described in the instructions and the Issue.

## Which machines run which playbooks

A machine runs the playbooks in its `playbooks/<machine>/` folder. There is no
separate machine list: the presence of a `playbooks/<machine>/<name>.md` file
means that machine runs playbook `<name>`, with the concurrency and working
directory declared in that file's front matter. A playbook name that exists in
no machine's folder is unrunnable, and triage should not assign it unless a
machine will be given a file for it. Set `capacity: 0` to keep a playbook
defined but temporarily disabled on a machine.

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
playbook present in this machine's `playbooks/<machine>/` folder with spare
capacity. It then launches a worker with the playbook's instructions, the full
Pan system context, and the Issue contents.
