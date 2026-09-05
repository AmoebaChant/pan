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

- **Issues** in this repository are the tasks. By default every Issue belongs
  to the connected Project. A Domain-configured external human task manager may
  move an eligible verified human task out of the Project under the contract
  below. Agent work and explicitly retained audit or lifecycle task types stay
  in GitHub. The Domain contract decides whether recurring human work moves to
  the external manager or remains in GitHub; external ownership requires a
  complete recurrence lifecycle definition.
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

## External human task manager contract

A Domain may make one external system authoritative for eligible human-owned
tasks by declaring it in `pan.md`. The declaration must provide:

- a stable, user-agnostic manager key and the exact syntax of that manager's
  durable task identifiers;
- complete live queue enumeration, task lookup, field mappings, terminal-state
  mappings, access, and write verification;
- a durable location on the external task that stores the canonical source
  Issue URL while the source Issue is retained, plus any policy that permits
  deleting the source and removing its dead backlink after migration;
- the data that makes a migration complete, including every source field,
  comment, or other value the Domain requires;
- a live task-type classification rule and the explicit task types that must
  remain GitHub Project items for audit or lifecycle reasons (an explicit empty
  list is valid; an omitted rule or list is incomplete);
- whether recurring human tasks remain GitHub-authoritative or move to the
  external manager. External recurrence ownership must define cadence,
  completion, cancellation, successor/history behavior, and planning-field
  mappings; and
- duplicate handling, assignee exclusions, and any approval or deletion policy.

Only human work outside every mandatory GitHub-retained class is eligible for
migration. Recurring work is eligible only when the Domain contract makes the
external manager authoritative for recurrence. After creating an external task
for eligible work and verifying its complete data and source Issue URL,
migration records a dedicated comment on the source Issue whose first line is:

```text
Pan: external human task <manager-key> <stable-task-id>
```

The manager key and identifier must resolve through the current `pan.md`
contract without interpretation. The external task must point back to that
exact Issue URL. Only this reciprocal, live-verified pair proves that a human
task was migrated; the Issue comment alone is not sufficient. Write and verify
the receipt before removing the Project item or performing any
contract-approved source deletion. If the source is retained, keep the
reciprocal pointers. If the contract permits deleting it after verified
migration, the external task becomes the sole task record and the contract
decides whether its now-dead source backlink is retained as provenance or
removed. For a task type the contract keeps GitHub-authoritative, an external
record may be only a mirror or link; a receipt never authorizes Project removal
or transfers canonical lifecycle.

This receipt is a cross-system pointer, not another queue or a cache of task
state. While the source Issue is retained, Pan reads it, the current Domain
contract, and the authoritative external task live whenever it uses the
receipt. Before doing so for registration, Pan first determines from live
durable evidence whether the Issue is conclusively agent-owned or belongs to a
mandatory GitHub-retained class. Those Issues are always represented in the
Project even when a receipt is malformed, conflicting, or present. Only an
Issue that could legitimately be migrated human work is decided by its receipt.
For such an Issue, a missing external record, malformed or conflicting receipt,
backlink mismatch, incomplete migrated data, or indeterminate classification
makes the migration evidence ambiguous: make no registration, removal, or
planning write for that Issue, report the gap, and do not claim a complete
queue.

## Boundaries

- Operate only within the configured Domain. Do not blend data from other
  Domains unless the user explicitly asks.
- Domain instructions remain subordinate to the generic Pan contracts. A
  `## Daily Briefing` section does not authorize discretionary task mutations;
  those still require agreement or a separate existing standing policy.
- Product-context repositories a session may be pointed at are read-only
  reference. They grant no authority to modify anything.
- The one exception is the Pan tool repository itself, for self-improvement
  under its normal review policy. See [self-improvement](self-improvement.md).
