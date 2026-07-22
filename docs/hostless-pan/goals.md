# Hostless PAN goals

## Goal

Make a long-running GitHub Copilot CLI session using the PAN custom agent the
primary PAN experience. PAN operates directly in one configured private domain
repository, reasons about its complete portfolio, maintains durable domain
state, and schedules periodic reviews while that session remains running.

Hostless means there is no separate PAN coordinator service or localhost HTTP
bridge. The active Copilot CLI process hosts PAN's conversation, reasoning,
scheduling, and domain tools. Per-machine runner daemons remain separate
deterministic execution services.

## Product outcomes

- PAN chat can read, search, reason about, create, and update workstream
  `README.md` files below the configured domain's `workstreams/` hierarchy.
- Workstream updates are conflict-safe, attributable commits made directly to
  the domain repository's default branch and pushed without a pull request.
  Updates preserve unrelated working-tree changes, detect concurrent remote
  changes, never force-push, and report unresolved commit or push conflicts
  instead of claiming success.
- PAN can completely enumerate open and closed Issues in the configured domain
  repository when needed for backlog reconciliation, triage, and duplicate
  detection. Pull requests are not backlog Issues. Incomplete pagination or
  inaccessible evidence prevents decisions that depend on completeness.
- Open backlog Issues missing from the configured Project are detected and
  reconciled without creating duplicate Issues.
- PAN can reason about triage, routing, commitments, blockers, and relative
  priority, then update canonical Project fields and ordering so its decisions
  remain visible to people and runners.
- The single writing PAN session can schedule periodic portfolio-review prompts.
  Additional sessions remain read-only and do not schedule reviews. Reviews do
  not overlap another PAN turn, visible failures are reported, and durable state
  is refreshed before every recommendation or mutation.
- Cadence and retry behavior are configurable. Reviews missed while PAN is not
  running do not execute later merely to catch up; PAN performs a fresh review
  after startup according to its configured policy.
- Per-machine runner daemons remain responsible for playbook matching, atomic
  task claims, lease renewal, worker isolation, and implementation-agent
  lifecycle.
- Runner playbooks use branch-and-pull-request delivery by default. A playbook
  may explicitly select direct default-branch merge and push for repositories
  whose policy permits it.
- Existing attention, task-addition, lease, delivery, and merged-pull-request
  reconciliation behavior remains available when the PAN session is running.
- Users can discuss PAN itself from the PAN session. The reusable PAN repository
  and documentation are read-only product context, not another work domain or
  implicit self-modification authority.

## Safety and authority

- At most one PAN session may hold mutating leadership for a domain. Leadership
  is revalidated before each mutation; read-only sessions may coexist.
- Reads are confined to configured domain roots plus explicitly configured
  read-only product-context roots.
- Every mutation is validated for schema, domain, authority, lifecycle, active
  leases, protected statuses, and expected current state.
- Mutations fail closed on incomplete evidence or stale state and never report
  partially applied effects as complete.
- Reads and recommendations are automatic. Reconciliation of existing open
  Issues into the Project is automatic and deterministic.
- Routine triage field changes, Project reordering, Issue creation or comments,
  and workstream commits may apply without a separate approval when PAN records
  a specific durable rationale and evidence.
- Destructive actions, changes to protected lifecycle states, clearing
  human- or runner-created blocks, overriding active leases, force operations,
  and changes outside configured domain roots require explicit approval or are
  prohibited by policy.
- PAN preserves human precedence, runner-owned operational state, active work,
  human or runner blocks, and existing repository delivery policy.

## Durable state

- GitHub Issues remain the durable task records.
- The configured GitHub Project remains the source of truth for lifecycle,
  routing, priority, autonomy, requirements, leases, workstream association, and
  canonical ordering.
- Committed workstream Markdown remains the durable narrative record.
- Conversation history, schedules, and local session metadata are conveniences,
  not a second task queue or the only record of a decision or commitment.
- The public PAN repository remains data-neutral. Private workstreams, Issues,
  configuration, credentials, runner state, and machine settings stay in the
  domain repository or local machine configuration.

## Success criteria

1. PAN starts from one validated domain configuration without starting or
   connecting to a separate PAN host.
2. A PAN turn can produce a complete cited portfolio review and refuses
   completeness-dependent mutations when any required source is partial.
3. An active PAN session schedules and performs non-overlapping periodic review
   turns, and no reviews run after that session exits.
4. Concurrent PAN sessions cannot both mutate the same domain.
5. PAN safely updates Project fields and ordering without overwriting manual
   precedence, leases, protected lifecycle states, or concurrent changes.
6. PAN commits and pushes a workstream update directly to the domain default
   branch as an attributable commit, or clearly reports the conflict or
   incomplete effect.
7. Existing runners continue to claim canonical ready work atomically and
   preserve their current delivery behavior.
8. PAN can read its reusable implementation and documentation as product context
   without gaining authority to modify that repository.

## Non-goals

- PAN does not continue scheduled work after its Copilot CLI session exits.
- PAN does not require a watchdog, resident host service, or localhost HTTP API.
- PAN does not replace the per-machine runner daemon with model reasoning.
- PAN does not maintain a second queue outside GitHub Projects.
- PAN does not provide implicit cross-domain reasoning.
- Implementation agents do not receive unnecessary domain-wide authority or
  bypass task leases and delivery policy.
