# The Pan Domain

A **Domain** is the user's private Pan knowledge/configuration repository plus
one selected task backend. GitHub Issues and a connected Project are the
default backend; a Domain may select Todoist for every managed task. Pan
operates on exactly one Domain at a time.

## What the Domain repository contains

```text
<domain-repo>/
  workstreams/<path>/README.md   durable narrative per area of work
  playbooks/<machine>/<name>.md  playbook definitions (per machine)
  pan.md                         domain-specific Pan instructions (optional)
```

- **The selected backend** holds tasks. The stable outcome remains one task
  while its exact next action moves between a person, AI, or an external wait.
- **The Project**, when GitHub is the selected backend, holds each task's
  lifecycle and fields. See [project schema](project-schema.md).
- **Workstreams** are the durable narrative for each area of work. See
  [workstreams](workstreams.md).
- **Playbooks** define kinds of work and the instructions for doing them. A
  machine runs exactly the playbooks in its `playbooks/<machine>/` folder, and
  each playbook file declares its own concurrency and working directory. See
  [playbooks](playbooks.md).
- **`pan.md`** (optional) holds domain-specific instructions that extend the
  generic system — for example, "during triage, also add any new open Issues
  from `owner/other-repo` to the backlog." Pan reads it at the start of a
  session and applies the sections scoped to that session's role alongside the
  generic system. Role-specific instructions must name their intended session.
  Workers apply general instructions and worker-scoped sections, but ignore
  sections for the main chief-of-staff session, portfolio-wide review or
  reconciliation, task triage or backlog management, and session scheduling.
  It may include a `## Daily Briefing` section naming extra read-only planning
  considerations or sources and how to inspect them; see [Daily
  Briefing](daily-briefing.md).

## How Pan reaches the Domain

Pan uses the GitHub API through `gh` for Domain knowledge. Task access goes
through the configured thin backend tool. The Domain is **never** required as a
local checkout: read and write workstreams and playbooks through the GitHub
Contents API, and read and write tasks through the selected backend.

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

The same file may name an explicit task-backend config path. Credentials stay
in a separate local credential file. The backend config selects scope,
assignee rules, and mappings; see [task backends](task-backends.md).

For GitHub-backed Domains, the file may list `taskBacklogRepos` for the everyday UI. That is an
explicit repository allowlist in addition to the Domain repository, not a
discovery mechanism or authority transfer. The UI service requires both this
config path and the Pan checkout path on its command line and rejects all other
Issue repositories.

## Imports from other task systems

External systems may be migration sources or read-only context, but they do not
become task authority based on who acts next. The legacy Todoist importer
preserves stable source ids, metadata, comments, scheduling, deadlines, and
recurrence in Domain Issues, verifies Project membership, and never deletes the
source. See [Todoist migration and recovery](todoist-migration.md).

`pan.md` declares the one selected backend. It must not create a background
sync or fallback queue. Todoist-backed Domains keep all managed tasks in
Todoist, while the private repository remains authoritative for knowledge and
playbooks.

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
