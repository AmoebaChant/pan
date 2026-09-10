# The Pan Domain

A **Domain** is the user's private data for Pan: one private GitHub repository
plus one GitHub Project connected to it. Pan operates on exactly one Domain at a
time. The Pan tool repository holds no user data; everything user-specific lives
in the Domain.

## What the Domain repository contains

```text
<domain-repo>/
  workstreams/<path>/README.md   durable narrative per area of work
  playbooks/<machine>/<name>.md  playbook definitions (per machine)
  pan.md                         domain-specific Pan instructions (optional)
```

- **Issues** in this repository are the tasks. Every eligible personal task
  belongs to the connected Project. The stable outcome remains one task while
  its exact next action moves between a person, AI, or an external wait.
  Recurring occurrences are separate linked Issues.
- **The Project** holds each task's lifecycle and fields. See
  [project schema](project-schema.md).
- **Workstreams** are the durable narrative for each area of work. See
  [workstreams](workstreams.md).
- **Playbooks** define kinds of work and the instructions for doing them. A
  machine runs exactly the playbooks in its `playbooks/<machine>/` folder, and
  each playbook file declares its own concurrency and working directory. See
  [playbooks](playbooks.md).
- **`pan.md`** (optional) holds domain-specific instructions that extend the
  generic system — for example, "during triage, also add any new open Issues
  from `owner/other-repo` to the backlog." Pan reads it at the start of a
  session and applies it alongside the generic system. It may include a
  `## Daily Briefing` section naming extra read-only planning considerations or
  sources and how to inspect them; see [Daily Briefing](daily-briefing.md).

## How Pan reaches the Domain

Pan uses the GitHub API through `gh`, always against the configured Domain
repository and Project. The Domain is **never** required as a local checkout:
read and write workstreams and playbooks through the GitHub
Contents API, and read and write tasks through Issues and the Project.

The runner is the exception that may keep a local checkout, because a worker
edits code on disk — but that is the *target* repository named by a playbook,
not the Domain. See [playbooks](playbooks.md) and [runner](runner.md).

## Configuration

Onboarding records, per machine, which Domain this machine is bound to (the
repository and the Project). Keep that binding in a small local config the
runner and sessions read; it names the Domain repository and the Project
(`<owner>/<number>`), the default worker permissions for agents this machine's
runner launches (`workerPermissions`: `standard` or `yolo`), and nothing
sensitive beyond what `gh` already holds. The canonical Domain data always lives
in GitHub, not in local config.

By convention this config is a single JSON file under `~/.config/pan/`, named for
the machine (e.g. `~/.config/pan/<machine>.json`), with at least `domainRepo`
(`<owner>/<repo>`) and `project` (`<owner>/<number>`). Both the runner and
interactive Pan sessions read it to learn their Domain, so an interactive session
never needs the Domain injected into its opening prompt — it discovers the
binding from this file at startup.

The runner may also configure `stateRoot` and `workspaceRoot`. `stateRoot`
contains authoritative local session and launch-generation records and defaults
to the platform's durable per-user application/state location. `workspaceRoot`
contains disposable isolated code workspaces and may remain under the system
temporary directory. They must not overlap. Moving or cleaning
`workspaceRoot` must never remove the ownership record that prevents duplicate
workers.

The same file may list `taskBacklogRepos` for the everyday UI. That is an
explicit repository allowlist in addition to the Domain repository, not a
discovery mechanism or authority transfer. The UI service requires both this
config path and the Pan checkout path on its command line and rejects all other
Issue repositories.

## Imports from other task systems

External systems may be migration sources or read-only context, but they do not
become task authority based on who acts next. The supported Todoist importer
preserves stable source ids, metadata, comments, scheduling, deadlines, and
recurrence in Domain Issues, verifies Project membership, and never deletes the
source. See [Todoist migration and recovery](todoist-migration.md).

`pan.md` may name other read-only sources or import mappings, but cannot move
canonical lifecycle out of GitHub or authorize a background sync loop. A future
adapter requires its own public contract, idempotency markers, complete
pagination, assignee exclusions, partial-import behavior, and verified writes.

## Boundaries

- Operate only within the configured Domain. Do not blend data from other
  Domains unless the user explicitly asks.
- Domain instructions remain subordinate to the generic Pan contracts. A
  `## Daily Briefing` section does not authorize discretionary task mutations;
  those still require agreement or a separate existing standing policy.
- Product-context repositories a session may be pointed at are read-only
  reference. They grant no authority to modify anything.
- A local UI or migration process must be explicitly bound to the config and
  Pan checkout it serves. Browser code receives no GitHub or source-system
  credential. Loopback origin, host/rebinding, repository scope, content size,
  and stale-revision checks are mandatory.
- The one exception is the Pan tool repository itself, for self-improvement
  under its normal review policy. See [self-improvement](self-improvement.md).
