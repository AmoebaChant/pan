# PAN architecture

PAN separates agent reasoning from deterministic runtime and execution
plumbing. One PAN instance connects to one private domain repository.

## Concepts

### Tool repository

The public `pan` repository contains reusable behavior:

- the PAN custom-agent definition;
- the PAN runtime and command-line interface;
- constrained GitHub and workstream tools;
- runner and worker-session launching code;
- playbook, Project, lease, and reporting schemas; and
- generic documentation and conventions.

It must not contain private work, user-specific configuration,
repository-specific playbooks, machine paths, credentials, or live runner
state.

### Domain repository

A domain repository is one bounded body of work connected to one PAN instance.
Its Git repository name is arbitrary. It contains:

- workstream narrative under `workstreams/<path>/README.md`;
- GitHub Issues for backlog items;
- one GitHub Project containing lifecycle, routing, and canonical ordering;
- shared project/task playbooks; and
- sanitized runner advertisements and GitHub-backed operational state.

Separate work and personal domains use separate PAN instances. Cross-domain
reasoning is a possible future federation feature, not an implicit behavior.

### PAN custom agent

The repository-level `.github/agents/pan.agent.md` definition describes PAN's
personality, goals, responsibilities, reasoning standards, authority, and
allowed tools. Scheduled portfolio reviews and interactive conversations are
turns of the same logical agent.

### PAN runtime

The PAN runtime is an ordinary local program connected to one domain repository.
It:

- polls GitHub and synchronizes workstream markdown;
- detects new or changed tasks, answers, source commits, and time boundaries;
- coalesces events and schedules portfolio-reasoning turns;
- invokes the PAN custom agent for autonomous and interactive work;
- validates structured agent actions and enforces policy;
- maintains the per-domain leader lease; and
- hosts the persistent conversational PAN interface.

The runtime's rules decide when PAN should reason and whether an action is safe.
They do not replace PAN's judgment with fixed prioritization rules.

### PAN tools

PAN acts through a constrained tool interface built over the GitHub store and
the local domain clone. The target interface includes operations to:

- enumerate every Project item in canonical order;
- read and search workstream markdown and relevant git history;
- read Issue bodies, comments, fields, and timestamps;
- create sourced Issues and detect duplicates;
- update fields and Project ordering;
- record concise rationale and review time;
- ask for clarification; and
- inspect runner playbooks, availability, and active work.

The tool implementation receives domain configuration at runtime. The PAN agent
definition contains no user-specific repository or path.

### Runner

Each participating machine runs one lightweight, non-AI runner. It polls the
domain Project for the highest-ranked compatible `owner=agent`, `ready` work and
claims it atomically before launching a worker.

A runner does not need an idle Copilot session for every repository. It only
starts a headed session when a local playbook matches available work and an
execution slot is free.

### Playbook

A shared playbook in the private domain repository describes:

- the task and repository requirements it matches;
- common pickup, setup, validation, and cleanup instructions;
- the worker-agent definition, skills, and prompt context;
- reporting requirements; and
- default execution limits.

Local machine settings enable installed playbooks and provide paths, installed
tools, credentials, terminal configuration, and capacity. The runner advertises
only sanitized playbook IDs, capabilities, repository scopes, delivery modes,
online state, and free capacity.

### Worker session

After a claim, the runner creates a dedicated branch and isolated worktree, then
opens a headed Copilot CLI session with the playbook, Issue, comments, answers,
workstream context, and reporting protocol. Global and playbook-specific limits
allow multiple tasks in the same repository to run concurrently.

## Runtime topology

```text
 PAN runtime on one machine
 poll/sync | schedule | host chat | enforce leases
                  |
                  v
 PAN custom agent
 reason across all tasks and workstreams | explain | act through tools
                  |
                  v
 Domain repository
 markdown + GitHub Issues/Project (canonical queue)
                  ^
                  | pull + claim + heartbeat + report
        +---------+-------------------+
        |                             |
 Machine A runner              Machine B runner
 installed playbooks           installed playbooks
        |                             |
 launch headed worker sessions in isolated worktrees
```

Only one PAN runtime may lead a domain at a time. Many runners may participate
in that domain, including runners on machines other than the PAN host.

## Portfolio reasoning

Each planning pass must enumerate every actionable Project item. Retrieval may
provide detailed evidence, but it may not silently omit candidate work.

PAN builds evidence-backed task dossiers from:

- Issue bodies, comments, fields, and timestamps;
- the associated workstream and relevant related workstreams;
- dependencies, blockers, and active leases;
- explicit and inferred commitments;
- current date and time; and
- recent task, Project, and workstream changes.

PAN then updates the GitHub Project's canonical ordering and concise explanation.
The human queue is a saved view over that ordering, filtered to actionable
human-owned work. Agent runners pull from the same ordering after filtering for
compatible ready work.

### Manual ordering

A manual Project drag is a durable user decision. PAN preserves the resulting
relative precedence constraint while allowing genuinely new urgent work to be
inserted. PAN explains material insertions or reorderings.

The runtime may retain operational audit state to detect changes it did not
apply, but that state is not a second queue and cannot override the current
Project order.

### Inferred tasks

When PAN finds a high-confidence actionable commitment in workstream narrative
without an existing task, it creates a sourced Issue and adds it to the Project.
The Issue records the source path, source revision or timestamp, interpreted
date, extracted action, and rationale.

PAN checks for semantic duplicates and stable source fingerprints. Ambiguous
actions become questions. Rejected or closed inferred work is suppressed rather
than recreated unchanged. Source removal never silently deletes an Issue.

## Reporting protocol

The public repository defines versioned records for:

- `claimed`
- `started`
- `heartbeat`
- `progress`
- `needs-human`
- `completed`
- `failed`

The runner owns the lease and heartbeat even when the worker session is
unresponsive. Workers report through constrained PAN tools and own semantic
delivery work such as integration and conflict resolution. The runner validates
remote delivery and records an append-only Issue journal covering starts,
resumes, operational stops, questions, answers, and completion. Journal locators
include the machine, runner, playbook, branch, worktree, terminal title, and
optional local URL needed to resume safely.

## Current implementation

The current walking skeleton already provides:

- a low-dependency GitHub store;
- Project schema validation and optimistic leases;
- a singleton rule-based triage daemon;
- an attention CLI; and
- a pull-based local runner that launches isolated Copilot worktrees.

The next architecture step is to add the generic PAN agent and tool interface,
replace fixed prioritization with a complete portfolio-reasoning turn, and
separate PAN instance configuration from runner configuration. The existing
store, lease, and runner code are foundations rather than discarded prototypes.

## Open implementation questions

- How the Node runtime invokes autonomous and interactive Copilot CLI turns.
- Polling, full-review, heartbeat, notification, and retry cadences.
- The Project fields used for concise rationale, review time, and detected manual
  ordering.
- The exact shared playbook, local machine-settings, and runner-advertisement
  schemas.
- Conversation transcript retention; durable outcomes must be promoted to the
  domain repository.
- Whether higher-risk domains use a second agent to review portfolio changes.
