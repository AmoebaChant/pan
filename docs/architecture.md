# PAN architecture

PAN is hostless: a foreground Copilot session supplies agent reasoning while
small helper processes perform deterministic reads and writes. There is no PAN
HTTP endpoint, MCP server, persistent Node host, detached scheduler, or
host-log process.

## Topology

```text
foreground pan session
  validates assets + domain, acquires lease, launches Copilot
       |                    |
       | native session     +-- one-shot PAN helper commands
       | schedule                    |
       v                             v
Copilot PAN agent <----------> private GitHub domain
                                  Issues + Project + workstreams
                                        ^
                                        | claim, heartbeat, delivery
                                 independent pan-runner instances
```

The public package ships generic assets under `assets/copilot`, code, and
schemas. A private domain repository contains the domain configuration,
workstream `README.md` files, Issues, Project, runner profiles, lease state,
and machine-specific details.

## Session leadership

`pan session` starts one interactive Copilot process in the domain clone. It
attempts a renewable GitHub-backed lease before launch. The holder receives a
writing session and the lease identity in its environment; another concurrent
session remains read-only. Losing a lease terminates the child session and the
user must start a new session. Session exit releases the lease.

Writing is the only mode that may schedule reviews or invoke mutation helpers.
Read-only mode is useful for inspection and discussion without domain changes.

## Native scheduling

Scheduling belongs to the writing Copilot session. PAN supplies a bootstrap
prompt for one native `/every` schedule and launch-local due metadata. The
session queue prevents overlapping work. Due metadata prevents catch-up work;
a missed session is simply gone. Startup behavior is explicit (`immediate`,
`after-interval`, or `manual`), and retry and rate-limit bounds come from the
version-2 domain configuration.

## Evidence and actions

Each helper command creates a new command context from the configured domain.
Evidence helpers read complete Issue, Project, workstream, and runner
availability snapshots. Mutation helpers validate action schema, policy,
leadership, and expected state against fresh evidence before a side effect.
They return structured receipts, diagnostics, recovery guidance, and one of
`confirmed`, `rejected`, `incomplete`, or `failed`.

Issue reconciliation adds missing repository Issues to the Project
deterministically. Merged-PR reconciliation closes eligible pull-request
deliveries. Workstream preparation and publication use an isolated workspace
and receipt rather than a PR.

## Runner delivery

A runner is independent from PAN session leadership. It has a private profile,
claims compatible ready work, maintains its own lease, and starts headed Copilot
workers in isolated worktrees. The normal delivery mode is pull request. Direct
delivery is opt-in per playbook and only completes after the runner confirms the
reported commit is reachable from the repository default branch.
