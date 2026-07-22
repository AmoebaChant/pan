# Hostless PAN architecture

## Executive summary

Hostless PAN is one ordinary GitHub Copilot CLI session rooted in a configured
private domain repository. `pan session` validates the domain, makes the generic
PAN agent, instructions, and skills available, acquires single-writer leadership
when possible, and launches Copilot as its foreground child. Copilot provides the
conversation, ordinary file/git/shell/GitHub tools, and native session-scoped
prompt scheduling. Deterministic `pan` CLI commands provide the mechanics that
must not depend on model interpretation: complete evidence reads, Project
updates, action validation, leadership checks, attention, reconciliation, and
conflict-safe workstream delivery.

There is no PAN host, Copilot extension, PAN MCP server, localhost HTTP bridge,
shared PAN service, detached scheduler, or second conversational runtime.
`pan session` may remain as a small foreground supervisor while Copilot runs so
it can heartbeat and release the durable leadership lease. It exposes no socket,
endpoint, token service, RPC surface, or independently useful background
process. When the Copilot child exits, the launcher exits and scheduling ends.

| Concern | Before | After |
| --- | --- | --- |
| Primary experience | Start a PAN host, then connect a Copilot client | Run `pan session`; Copilot starts in the private domain root |
| Agent location | Agent discovered from the reusable PAN checkout | Versioned generic agent and skills installed at Copilot user scope |
| Domain access | PAN-specific tool bridge | Ordinary Copilot file, git, shell, and GitHub capabilities |
| Deterministic safety | Long-lived host services apply PAN operations | Stateless `pan` helper commands validate and apply each operation |
| Scheduling | PAN-owned timers and separate prompt processes | Copilot native `/every` or equivalent supported session scheduling |
| Leadership | Resident PAN runtime heartbeats a lease | Foreground launcher heartbeats; every mutating helper revalidates it |
| Evidence | Project-first snapshot with bounded Issue synchronization | Complete open/closed Issue and Project evidence with explicit completeness |
| Workstreams | Read-only domain narrative | Isolated edit, direct default-branch commit, and non-force push without PR |
| Local artifacts | Host state, endpoint, bearer token, MCP config, host log | Normal Copilot/session diagnostics plus bounded local operation receipts |
| Runner | Separate deterministic `pan-runner` | Retained; PR delivery remains default and direct delivery is explicit |

This architecture covers the ordinary session experience and domain boundary
(REQ-EXP-1–9, REQ-DOM-1–10), evidence and reconciliation
(REQ-EVD-1–16, REQ-REC-1–15), ordinary tools and deterministic helpers
(REQ-TOOL-1–8), workstream delivery (REQ-WS-1–16), native scheduling and
single-writer leadership (REQ-SCH-1–12, REQ-LEAD-1–12), safe mutation and
retained workflows (REQ-SAFE-1–15, REQ-ATTN-1–10, REQ-RUN-1–13), and
migration/reliability requirements (REQ-REL-1–9, REQ-MIG-1–12).

## Decisions and assumptions

The updated requirements are sufficiently specific to select an architecture.
The following decisions constrain implementation:

1. A supported Copilot CLI version must provide custom agents, user-level
   skills, ordinary GitHub capabilities, and session-scoped scheduling. Native
   scheduling is currently exposed through `/every` and `/after`; PAN does not
   recreate those timers (REQ-EXP-3, REQ-SCH-1).
2. Agent and skill distribution uses Copilot's supported user-level discovery
   locations. The private domain repository remains data-only and does not
   receive copied PAN product files (REQ-EXP-6–7, REQ-REL-7–8).
3. The foreground `pan session` launcher is lifecycle supervision, not a host.
   It owns only startup validation, child-process lifetime, lease heartbeat, and
   best-effort release. Domain operations are ordinary CLI invocations
   (REQ-EXP-2–4, REQ-LEAD-5, REQ-LEAD-11).
4. A writing session that loses leadership fails closed. Because there is no
   control service that can safely rewrite a running session's schedule, the
   launcher ends the Copilot child and tells the user how to restart read-only
   or contend for leadership again. This is the minimal safe interpretation of
   REQ-LEAD-7–8 and REQ-SCH-2.
5. PAN workstream updates always use direct default-branch delivery. Runner
   delivery is a separate policy: branch plus pull request remains the default,
   while a playbook may explicitly select direct delivery
   (REQ-WS-8–13, REQ-RUN-8–13).
6. Exact Copilot schedule bootstrapping is isolated behind a CLI-version
   contract. PAN may use only a documented native mechanism; it must not inject
   terminal keystrokes or depend on private session files. If the supported CLI
   cannot establish the configured schedule, startup fails with an actionable
   manual `/every` instruction rather than silently running unscheduled
   (REQ-SCH-1, REQ-REL-2).

## Current architecture

### Current process topology

```text
pan start / pan host
        |
        v
+-------------------------------+
| resident PAN host             |
| leadership | timers | policy  |
| snapshot cache | HTTP server  |
+---------------+---------------+
                |
         endpoint + token
                |
                v
        PAN MCP proxy
                |
                v
Copilot CLI rooted in reusable PAN repository

pan-runner processes ----------------> GitHub Issues / Project
```

The current launcher creates local runtime state, starts or discovers a resident
host, generates bridge configuration, and opens Copilot in the reusable PAN
repository. The host owns scheduling, leadership, snapshot preparation,
attention/reconciliation integration, and action application. The bridge exists
primarily to forward interactive tool calls to those long-lived services.

### Reusable foundations

The migration preserves the deterministic behavior already represented by:

- complete Project pagination, schema validation, Issue/Project mutations, task
  leases, attention transitions, and merged-PR completion;
- durable leader records with expected-version writes, expiry, renewal,
  release, and safe same-machine recovery;
- portfolio snapshot identity, workstream evidence, runner availability, and
  diagnostics;
- action schema/policy validation, protected lifecycle handling, expected-state
  checks, idempotency, and confirmed/rejected/incomplete outcomes;
- confined workstream path handling and git history;
- runner selection, atomic task claims, independent lease heartbeat, isolated
  workers, and validated PR/direct delivery.

These capabilities become libraries behind short-lived CLI commands rather than
objects owned by a resident PAN process.

### Current gaps

- Starting chat depends on a separately running PAN process and bridge
  (REQ-EXP-2–4).
- Copilot starts in the reusable product repository rather than the private
  domain root (REQ-EXP-1, REQ-DOM-5).
- Complete open-and-closed Issue evidence and required nested pagination are not
  consistently available before reasoning (REQ-EVD-4–12).
- Workstreams cannot be delivered as direct, attributable default-branch commits
  (REQ-WS-3–16).
- Mutation application does not uniformly revalidate leadership and expected
  state before every external step (REQ-LEAD-6–7, REQ-SAFE-11).
- Review scheduling belongs to the PAN host rather than the active Copilot
  session (REQ-SCH-1–12).

## Target topology

```text
                         one foreground terminal

  pan session --config <domain pan.json>
             |
             | validate domain + agent installation
             | acquire durable writer lease if available
             v
  +--------------------------------------------------------+
  | small foreground launcher/supervisor                   |
  | - Copilot child lifetime                               |
  | - leader lease heartbeat and best-effort release       |
  | - no tools, API, listener, scheduler, or shared state  |
  +---------------------------+----------------------------+
                              |
                              | child cwd = domain root
                              | session identity in environment
                              v
  +--------------------------------------------------------+
  | ordinary GitHub Copilot CLI session                    |
  | - generic PAN agent + instructions + skills            |
  | - conversation and native scheduled prompts            |
  | - built-in file, git, shell, and GitHub capabilities   |
  +---------------------------+----------------------------+
                              |
                    shell invokes documented commands
                              |
                              v
  +--------------------------------------------------------+
  | short-lived pan CLI helpers                            |
  | evidence | Project | actions | leadership | attention  |
  | reconciliation | workstream delivery | configuration  |
  +----------+--------------------+------------------------+
             |                    |
             v                    v
  confined local domain      GitHub Issues + Project
  and isolated worktree      leader state + runner records

  read-only product roots (explicitly allowed)

  independent pan-runner daemons --------------------------+
```

Only the launcher and its Copilot child are session-lived. Every helper command
loads validated configuration, reads fresh durable state, performs one bounded
operation, emits a structured result, and exits. Two helper invocations share no
authoritative memory; their shared truth is the domain repository and GitHub.

## Key architectural changes

### 1. `pan session` launches an ordinary domain-rooted session

```text
pan session
   |
   +-- load/migrate config without rewriting it
   +-- validate local clone <-> configured GitHub repository
   +-- validate Project schema and state namespace
   +-- verify generic PAN agent/instruction/skill versions
   +-- verify Copilot version and native scheduling support
   +-- attempt leadership
   +-- launch Copilot in domain.path with agent "pan"
   +-- establish native schedule only if writing leader
   +-- supervise child and lease until child exits
```

Copilot's working directory is exactly the configured domain root. The normal
trust boundary therefore includes domain files below that root. Product-context
roots are separately configured read-only directories and are added only when
needed; they do not expand the domain write boundary (REQ-DOM-7–9).

Startup modes are:

- **writing**: leadership acquired; mutations and the configured review schedule
  are enabled;
- **read-only**: another live or unverifiable leader exists; conversation and
  complete reads are available, mutation helpers reject, and no review schedule
  is created;
- **failed**: configuration, repository identity, Project schema, agent
  distribution, authentication, or required CLI support is invalid.

`pan session` starts a new Copilot session by default. Resuming a prior writing
session is allowed only after leadership is reacquired and its PAN-owned native
schedule is normalized. If leadership is unavailable, PAN starts a fresh
read-only session rather than reviving a schedule created while that prior
session was a writer (REQ-SCH-2, REQ-LEAD-3).

The launcher returns Copilot's exit code after attempting lease release. It does
not remain after the session exits (REQ-EXP-8, REQ-SCH-12).

### 2. Generic PAN agent, instructions, and skills are user-scoped

The reusable package remains data-neutral and is the source of versioned PAN
behavior. Installation or upgrade synchronizes:

- the generic PAN custom agent to Copilot's user-level agents directory;
- reusable PAN instructions to a user-level instructions directory;
- PAN skills to Copilot's user-level skills directory.

`pan session` checks a manifest containing the installed PAN package version and
content hashes. A missing, stale, locally conflicting, or malformed installation
produces repair guidance before a writing session starts. The launcher selects
the agent explicitly rather than relying on model inference.

The generic agent changes its authority model:

- it may use ordinary built-in read/search/file/git/shell/GitHub capabilities;
- domain mutations must still follow PAN policy and deterministic helper
  contracts;
- it invokes helpers through ordinary shell commands and consumes their JSON;
- it treats product context as labeled read-only reference;
- it never treats availability of a powerful built-in tool as permission to
  bypass domain, leadership, lifecycle, lease, or expected-state checks.

This avoids per-domain copies and allows PAN upgrades without committing product
runtime files into private work repositories (REQ-EXP-5–7, REQ-TOOL-5–6,
REQ-REL-8).

### 3. Ordinary capabilities plus deterministic helper commands

PAN uses built-in capabilities where ordinary semantics are sufficient:

- file listing, reading, searching, and editing within allowed roots;
- `git` inspection and isolated worktree editing;
- shell invocation and local diagnostics;
- GitHub reads that do not require a completeness or mutation guarantee.

Documented helper commands are required where correctness depends on pagination,
compare-and-set behavior, policy, idempotency, or multi-step receipts:

| Command family | Responsibility |
| --- | --- |
| `pan evidence ...` | Complete Issue/Project/workstream/runner reads, snapshot identity, completeness diagnostics |
| `pan project ...` | Deterministic membership, field, and canonical-order operations |
| `pan action validate/apply` | Schema, authority, policy, expected-state, idempotency, execution, confirmation |
| `pan leadership ...` | Status, bounded acquisition, assertion, renewal, release, recovery diagnostics |
| `pan attention ...` | Inbox, answer, and Issue-backed task addition with structured output |
| `pan reconcile ...` | Missing-Issue registration, merged-PR completion, and repair of partial transitions |
| `pan workstream ...` | Isolated preparation, validation, commit, and direct default-branch push |
| `pan config ...` | Read, validate, migrate, and atomically replace domain/session configuration |

Every helper supports machine-readable output and uses a common envelope:

```text
status: confirmed | rejected | incomplete | failed
operationId
domain identity
snapshot / expected-state identity
confirmed effects
remaining required steps
diagnostics and safe recovery
```

Unknown commands, arguments, action kinds, and schema versions fail before side
effects. Helpers never infer authorization merely from their current directory
or from possession of GitHub credentials (REQ-TOOL-2–8, REQ-REL-1–6).

### 4. Complete evidence is refreshed per turn

The Project is the canonical queue, but it is not the complete Issue population.
A portfolio review begins by invoking a complete evidence helper:

```text
validate domain and Project schema
          |
enumerate all open + closed domain Issues
exclude pull requests from backlog Issues
paginate required comments, labels, assignees, and linked PRs
          |
enumerate every Project item and required field in canonical order
classify draft, PR, cross-domain, and unreadable content
          |
read workstreams and sanitized runner availability
          |
emit stable snapshot + source-by-source completeness
```

Safety limits are denial-of-service guards, not a definition of completeness.
Pagination exhaustion, changing cursors/totals, inaccessible nested evidence,
unsupported item types, or inconsistent revisions mark the relevant source
incomplete. A completeness-dependent recommendation or action is then rejected
rather than based on a partial portfolio (REQ-EVD-4–16).

The snapshot presentation may be paged for model context, but every page names
the same immutable snapshot identity. Conversation memory never substitutes for
a fresh authorization snapshot (REQ-EVD-13–16).

### 5. Deterministic reconciliation precedes portfolio mutation

The writing session performs deterministic maintenance before model-selected
portfolio changes:

1. find eligible open domain Issues missing from the Project;
2. revalidate Issue identity and membership;
3. add the existing Issue, never a replacement Issue;
4. initialize required fields deterministically;
5. reconcile confirmed merged pull requests for eligible `in-review` work;
6. rebuild evidence after any confirmed effect.

A read-only session reports required reconciliation but does not apply it.
Failures identify the existing Issue or partially transitioned item so retry
cannot create a duplicate (REQ-REC-1–9).

Model-proposed task creation remains separate. It requires complete open and
closed Issue evidence, a stable source identity, durable rationale, and
high-confidence interpretation. Ambiguous work becomes a question
(REQ-REC-10–15).

### 6. Action validation is stateless and optimistic

The PAN agent writes proposed action JSON to a bounded local operation file or
pipes it to `pan action validate/apply`. The helper applies these layers:

```text
schema
  -> configured domain
  -> complete evidence
  -> current leadership token/generation
  -> authority and approval classification
  -> lifecycle and protected-state policy
  -> active task lease and human precedence
  -> resource-specific expected current state
  -> idempotency lookup
  -> external write
  -> confirmation read
```

Expected state is resource-specific:

- Project field: item, field, expected value, and snapshot identity;
- canonical order: complete ordered item set and snapshot identity;
- Issue create/comment: catalog revision and stable idempotency marker;
- Project membership: Issue identity and expected absence;
- workstream: expected blob revision and remote default-branch revision;
- attention: latest attention record and current lifecycle/lease values.

GitHub Projects do not provide a general transaction. PAN therefore uses
compare-read-write-confirm and reports partial external effects honestly.
Unsupported all-or-none groups are rejected before mutation
(REQ-SAFE-1–15, REQ-REL-2–5).

### 7. Foreground leadership without a host

Leadership remains a durable lease in the configured GitHub state namespace.
The record contains a holder identity, machine and launcher PID where available,
an unguessable generation token, and expiry. Expected-version writes and a
confirmation read prevent two contenders from both confirming the same
generation.

```text
pan session A ---- acquire/confirm ----\
                                        +--> leader record in GitHub
pan session B ---- acquire/confirm ----/     exactly one confirmed token

launcher A heartbeat ---- expected version + same token
mutating helper ---------- fresh read + same token + unexpired lease
```

The launcher passes its session identity and lease generation only to the
Copilot child environment. A mutating helper must receive that session identity
and independently confirm the durable leader record immediately before every
external write. Local possession of stale values is insufficient.

Lifecycle:

- acquisition failure launches read-only and creates no schedule;
- successful acquisition starts the heartbeat and enables schedule bootstrap;
- a live remote or unverifiable holder remains protected;
- a confirmed dead same-machine launcher or expired lease may be reclaimed by
  expected-version write;
- heartbeat contention, expiry, or token mismatch ends the writing session
  before further scheduled or interactive mutation;
- normal child exit stops heartbeat and performs best-effort release;
- abnormal launcher exit is recovered by lease expiry.

The supervisor has no domain-operation API. It cannot answer tool calls and does
not hold a service container. Runner task leases remain independent
(REQ-LEAD-1–12).

### 8. Native session-scoped review scheduling

Only a writing session creates the configured native Copilot schedule:

```text
writing session starts
      |
      +-- startup=immediate       -> one fresh review prompt
      +-- startup=after-interval  -> first review after interval
      +-- startup=manual          -> no automatic prompt
      |
      +-- native recurring schedule: "run PAN portfolio review"

Copilot session queue serializes prompts
      |
      +-- scheduled turn refreshes evidence before reasoning
      +-- helper retries are bounded and idempotent

session exits -> native schedule stops
```

PAN stores cadence policy, not a durable next-run queue. Reviews missed while no
session is running are not replayed. Resuming a session restarts the interval
from resume according to Copilot's native behavior and applies the configured
startup policy at most once for that launch (REQ-SCH-6–8).

When a configured review cadence is longer than Copilot's maximum native
interval, PAN schedules a native prompt at the maximum supported interval. That
prompt first runs a deterministic session-local due check and performs a
portfolio review only when the configured cadence has elapsed in the current
launch. The due record is convenience metadata, not a durable queue; a new
launch follows the startup policy instead of catching up missed reviews.

Copilot's session queue is the non-overlap mechanism. A scheduled prompt due
during an active turn waits in the same session rather than starting another PAN
process. The review prompt instructs PAN to coalesce stale triggers, refresh
evidence, and emit a visible rejected/incomplete result on failure
(REQ-SCH-3–5, REQ-SCH-9–11).

### 9. Conflict-safe direct workstream delivery

PAN never edits or cleans the user's existing working tree. A workstream update
uses an isolated detached worktree based on a freshly fetched remote default
branch:

```text
pan workstream prepare <path>
   |
   +-- validate domain and workstream path
   +-- fetch remote default branch
   +-- capture base commit and target blob/absence
   +-- create isolated detached worktree
   v
Copilot edits only workstreams/<path>/README.md with built-in file tools
   |
pan workstream publish <operation>
   |
   +-- validate allowlisted diff and domain conventions
   +-- revalidate leadership, target blob, and remote branch
   +-- create attributable commit
   +-- ordinary non-force push HEAD:<default-branch>
   +-- confirm remote contains the commit
```

No remote delivery branch or pull request is created. A remote advance causes
the push or pre-push comparison to fail; PAN must refresh and re-evaluate rather
than overwrite it. Branch protection or required-review policy produces an
incomplete/rejected result and recovery guidance, not a bypass
(REQ-WS-8–14).

Commit metadata includes the PAN operation/turn identity and concise rationale.
A stable marker lets retries recognize an already published change and avoid
duplicate commits. The receipt records whether the isolated commit exists,
whether the remote moved, whether the push was confirmed, and what remains
(REQ-WS-7, REQ-WS-14–16).

### 10. Attention and merged-PR behavior remain available

The existing user-facing behavior remains available through direct command
families and the PAN agent:

- list unresolved human attention and all `in-review` work;
- answer by item ID or Issue URL;
- preserve durable answers, previous priority, and runner resume affinity;
- reject answers when no unresolved attention exists;
- distinguish genuine human questions from operational failures;
- add an Issue-backed untriaged item with structured fields and requirements;
- emit machine-readable results.

Merged-PR reconciliation confirms an actual merge before moving eligible work to
`done` and closing the Issue. PAN never merges the PR itself
(REQ-ATTN-1–10, REQ-REC-8–9).

### 11. Runner architecture is retained

```text
canonical Project order
        |
filter ready + agent-owned + executable autonomy
        |
match requirements + enabled playbook + capacity
        |
atomic task lease and independent heartbeat
        |
isolated worker branch/worktree/Copilot session
        |
runner validation and delivery receipt
```

`pan-runner` remains a separate deterministic foreground daemon and operates
whether or not a PAN session exists. Runner profiles do not acquire PAN
scheduling, conversation, or leadership settings.

Runner playbooks default to `pull-request`. A playbook may explicitly select
`direct` when repository policy permits it. Direct mode still requires an
isolated branch/worktree, validation, an active runner task lease, non-force
delivery, conflict detection, and confirmed remote state. PAN's own runner
playbook may select this exception explicitly. PR delivery remains `in-review`
until merged-PR reconciliation; validated direct delivery may complete
immediately (REQ-RUN-1–13).

## Data and contract changes

### Domain configuration version 2

Version 2 retains domain identity, Project identity, local path, state namespace,
agent settings, attention assignee, leadership cadences, review policy, and
self-repair policy. It adds or clarifies:

| Section | Setting | Meaning / default |
| --- | --- | --- |
| `session` | `agent` | user-level PAN agent name; default `pan` |
| `session` | `productContextRoots` | explicit labeled read-only roots; default empty |
| `scheduling` | `enabled` | native periodic reviews; default true for writing sessions |
| `scheduling` | `reviewIntervalSeconds` | recurring cadence migrated from full-review cadence |
| `scheduling` | `startup` | `immediate`, `after-interval`, or `manual` |
| `scheduling` | `retrySeconds` | bounded retry guidance for a failed review |
| `scheduling` | `rateLimitRetrySeconds` | bounded rate-limit retry guidance |
| `leadership` | lease/heartbeat settings | launcher lease lifetime and renewal cadence |
| `policy` | action classifications | automatic, approval-required, or prohibited |

Domain workstream delivery has no mode setting: it is direct to the default
branch by requirement. Runner delivery remains in runner playbooks and defaults
independently to pull request.

The loader accepts version 1, maps existing cadence and agent fields in memory,
and emits migration diagnostics. An explicit config migration command writes
version 2 atomically. Host polling, transcript-hosting, endpoint, and detached
runtime settings have no effect after migration (REQ-MIG-1–3).

### Leader record

The compatible durable leader record remains:

| Field | Purpose |
| --- | --- |
| `holder` | stable machine/process identity |
| `machine`, `pid` | safe same-machine dead-process recovery |
| `token` | confirmed ownership generation |
| `expiresAt` | lease expiry |
| optional `sessionId`, `holderKind` | diagnostics only |

Correctness depends on expected-version writes, token confirmation, and expiry,
not local host artifacts (REQ-MIG-8–10).

### Evidence snapshot

The next snapshot version adds:

- complete open/closed Issue catalog and explicit PR exclusion;
- complete Project membership and canonical order;
- source-by-source completeness and diagnostics;
- workstream git/blob revisions;
- sanitized runner availability and active work;
- reconciliation effects and unresolved steps;
- resource-specific expected-state references.

Older snapshots remain readable for diagnostics but cannot authorize a
completeness-sensitive hostless mutation.

### Action and command results

The action protocol adds workstream updates, deterministic reconciliation
receipts, action-group semantics, and resource-specific expected revisions.
Existing Issue/Project actions and structured attention/runner records remain
readable (REQ-MIG-4–5).

## Command migration

| Command | Hostless behavior |
| --- | --- |
| `pan session --config <path>` | Primary foreground domain-rooted Copilot experience |
| `pan start`, `pan connect` | Transitional guidance or alias to `pan session`; never start/discover a host |
| `pan host`, `pan stop`, detached/background options | Retired with actionable session-exit guidance |
| `pan review` | Retained one-shot review; mutating mode acquires a bounded lease |
| `pan chat` | Retired in favor of the ordinary interactive session, or retained as one-shot compatibility |
| `pan inbox`, `pan answer`, `pan add` | Retained under attention commands with equivalent JSON |
| `pan daemon` | Retired for domain reasoning; does not become another scheduler |
| `pan evidence/project/action/leadership/reconcile/workstream/config` | Documented deterministic helper families |
| `pan-runner` | Retained |

No compatibility command may silently launch a host, bridge, detached scheduler,
or shared process. A one-shot mutating command contends for the same leader lease
as `pan session` and releases it when finished (REQ-MIG-6–10).

Configuration restart guidance becomes:

- session/agent/scheduling/domain changes: exit and rerun `pan session`;
- runner profile/playbook changes: restart only `pan-runner`;
- no host restart exists.

## Migration strategy

### Phase 1: establish stateless helper contracts

- Expose complete evidence, Project, action validation, leadership, attention,
  reconciliation, configuration, and workstream delivery as bounded CLI
  operations with structured results.
- Make every mutation independently revalidate leadership and expected state.
- Add direct default-branch workstream delivery and complete Issue evidence.
- Keep existing GitHub records and runner behavior unchanged.

### Phase 2: add the ordinary session path

- Install/version the generic PAN agent, instructions, and skills at user scope.
- Add `pan session` with domain-rooted launch, foreground lease supervision,
  read-only fallback, and native schedule bootstrap.
- Validate behavior with one writing session, concurrent read-only sessions, and
  transitional older processes contending for the same lease.

### Phase 3: make hostless operation the default

- Redirect or retire host-oriented commands with migration guidance.
- Migrate configuration explicitly while continuing to read valid version 1.
- Preserve one-shot review, attention, task addition, and runner commands.
- Treat old endpoint/token/state/log artifacts as obsolete diagnostics only.

### Phase 4: remove obsolete runtime paths

- Remove resident coordination, local bridge, detached review scheduling,
  generated bridge configuration, and host lifecycle handling.
- Remove agent instructions that restrict PAN to bridge-contributed tools.
- Retain deterministic stores, schemas, policy, reconciliation, workstream,
  attention, leadership, and runner behavior behind CLI entry points.
- Preserve all Issues, Project items/fields/order, comments, leases, workstreams,
  and runner records; no destructive GitHub migration is required.

## Code removal plan

The following responsibilities disappear rather than move:

- localhost HTTP listening, authorization, health, shutdown, and tool dispatch;
- endpoint/port discovery and bearer-token generation/storage;
- host readiness files, required host logs, and generated MCP configuration;
- MCP proxy forwarding and host-owned in-memory service state;
- detached host start/stop orchestration;
- host-owned snapshot caches and periodic review timers;
- separate prompt-mode processes used for scheduled conversation;
- extension integration, registration, lifecycle, and tool assumptions;
- configuration whose only purpose was polling or supervising a resident PAN
  reasoning process.

The retained runtime code is ordinary reusable command logic: GitHub/store
access, complete evidence, action/policy validation, lease primitives,
attention, reconciliation, workstream delivery, configuration, and runners.

## Alternatives considered

### Keep a host but embed it under `pan session`

Rejected. A child coordinator that exposes tools or owns domain services is
still a host, even without a visible window. It would preserve split ownership
and lifecycle complexity contrary to REQ-EXP-2–4.

### Replace the HTTP bridge with direct MCP

Rejected. It would still make required PAN operations depend on a PAN-specific
tool server and would duplicate capabilities already available through ordinary
shell commands (REQ-TOOL-1, REQ-TOOL-8).

### Implement scheduling in the launcher

Rejected. A launcher timer would recreate a PAN scheduler outside Copilot and
could outlive or race the session. Copilot's native schedule already provides
the required session lifetime and serialized prompt queue (REQ-SCH-1–5).

### Use only raw `gh` and `git` commands with prompt instructions

Rejected for deterministic mechanics. Prompt conventions alone cannot guarantee
complete pagination, leadership compare-and-set, expected-state validation,
idempotency, or truthful partial-effect receipts. Raw tools remain appropriate
for ordinary reads and edits, while helpers enforce safety-critical operations
(REQ-TOOL-2–7, REQ-SAFE-1).

### Copy PAN files into every private domain

Rejected. It would fork reusable behavior, pollute private domain history, and
complicate upgrades. User-level agent and skill distribution keeps the product
generic and the domain data-only (REQ-REL-7–8).

### Continue PR delivery for PAN workstream updates

Rejected. Updated requirements explicitly select direct default-branch commit
and push for domain narrative. PR delivery remains the runner default, where
review and implementation delivery policy are separate concerns
(REQ-WS-8–13, REQ-RUN-8).

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Native scheduling behavior changes by Copilot version | Pin and preflight a supported CLI contract; fail with upgrade/manual schedule guidance |
| User-level PAN assets become stale or shadowed | Version/hash manifest, explicit agent selection, status/repair command |
| Built-in tools bypass helper policy | Agent instructions require helper use for mutations; acceptance tests verify durable state and helper receipts, not model claims |
| Leadership is lost while Copilot remains active | Supervisor ends the writing child; helpers independently reject stale tokens before each write |
| Launcher crashes without release | Short renewable lease and expiry-based recovery |
| Large portfolios exceed model/tool output | Complete helper-side enumeration, stable snapshot identity, paged presentation, fail-closed completeness |
| Project changes during enumeration | Detect revision/cursor/count inconsistency; retry boundedly or report incomplete |
| GitHub lacks multi-resource transactions | Compare-read-write-confirm and explicit confirmed/remaining effect receipts |
| Remote default branch advances during workstream delivery | Fresh fetch, expected base/blob, isolated worktree, ordinary non-force push, re-evaluation |
| Domain checkout contains unrelated changes | Never publish from that checkout; use an isolated detached worktree and allowlisted diff |
| Product context expands authority | Explicit read-only roots and mutation target validation against the single domain |
| Transitional old runtime still writes | Shared compatible leader record until old runtime removal |
| Native scheduled prompt is delayed by user work | Copilot session queue serializes it; evidence is refreshed when it actually runs |

## Testing strategy

### Unit tests

- version 1-to-2 config normalization, defaults, invalid combinations, and
  atomic replacement;
- user-level agent/instruction/skill manifest validation and conflict detection;
- domain path, remote identity, workstream path, and product-context confinement;
- complete open/closed Issue pagination, PR exclusion, changing cursors/totals,
  nested evidence pagination, and explicit incompleteness;
- complete Project ordering, membership, and reconciliation idempotency;
- leader acquisition, contention, confirmation, heartbeat, expiry, release,
  same-machine recovery, and stale-token rejection;
- action policy, lifecycle/lease/precedence protection, expected-state mismatch,
  idempotency, action groups, and partial-effect envelopes;
- isolated workstream diff validation, attribution, direct non-force push
  rejection, remote advance, retry detection, and cleanup;
- runner playbook default PR mode and explicit direct mode;
- attention and merged-PR reconciliation regressions.

### Integration tests

- run helpers as independent processes against fake `gh` and disposable git
  repositories, proving no in-memory service dependency;
- launch a fake Copilot child and verify cwd, selected agent, environment,
  heartbeat lifetime, signal handling, exit propagation, and best-effort release;
- contend two sessions and prove only one can schedule or mutate;
- lose leadership during each multi-step operation and verify later writes stop;
- perform complete evidence/reconciliation before interactive and scheduled
  review prompts;
- interrupt after Issue creation, Project addition, field update, commit, and
  push and verify accurate retry/receipt behavior;
- prove a dirty user checkout remains byte-for-byte unchanged;
- run existing runner end-to-end behavior for both PR and explicit direct
  playbooks.

### Copilot CLI contract tests

Offline contract tests verify:

- domain-rooted launch arguments and explicit PAN agent selection;
- discovery of user-level agent, instructions, and skills;
- ordinary built-in tool availability without PAN-specific tool integration;
- supported native schedule creation/listing/removal semantics;
- schedule lifetime ending with the session;
- read-only startup creating no schedule;
- launcher response to leadership loss and Copilot child exit.

An opt-in authenticated probe uses a disposable private domain to verify the
supported Copilot version can start the PAN agent, invoke a deterministic helper
through the shell, run one native scheduled review in the same session, and stop
all review activity on exit.

### End-to-end acceptance matrix

Release acceptance covers:

- first writing session, second read-only session, handoff, abnormal exit, and
  lease expiry;
- complete cited review and refusal on incomplete Issue, Project, workstream, or
  runner evidence;
- missing-Issue reconciliation without duplicate creation;
- stale field, order, Issue, leadership, and workstream revisions;
- direct default-branch workstream commit/push with remote contention and no PR;
- attention request/answer and operational-failure distinction;
- confirmed merged-PR completion and accurately reported partial transition;
- configured startup/cadence/retry behavior, no overlap, no catch-up, and stop on
  session exit;
- unchanged runner claim, heartbeat, worker isolation, PR-default delivery, and
  explicit direct delivery.
