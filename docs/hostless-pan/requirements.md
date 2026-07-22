# Hostless PAN requirements

## Purpose

This document defines the product requirements for making one long-running,
ordinary GitHub Copilot CLI session rooted in a configured domain repository
the primary PAN experience. Copilot owns the conversation and session
scheduling. The session uses ordinary filesystem, git, GitHub, and terminal
tools plus documented `pan` CLI helper commands for deterministic mechanics; it
does not depend on a PAN-specific Copilot extension, MCP server, localhost
bridge, or shared PAN service.

Unless a requirement explicitly replaces existing behavior, hostless PAN MUST
preserve the useful domain configuration, canonical GitHub state, attention,
lease, runner, delivery, and reconciliation behavior already provided by PAN.

## Terms

- **Domain**: one configured private repository, its workstream narrative, its
  Issues, and its configured GitHub Project.
- **PAN session**: an ordinary GitHub Copilot CLI session whose working
  directory is the root of one configured domain.
- **Writing session**: the PAN session that currently holds mutating leadership
  for its domain.
- **Read-only session**: a PAN session that can inspect and discuss a domain but
  cannot mutate it or schedule autonomous reviews.
- **PAN turn**: one interactive or Copilot-scheduled reasoning pass within a PAN
  session.
- **Complete evidence**: a read whose required Issue, Project, workstream, and
  operational sources have been paginated and validated without known omission
  or truncation.
- **Canonical queue**: the ordering of items in the configured GitHub Project.
- **Protected work**: work in a protected lifecycle state, subject to an active
  lease, or blocked by a human or runner.
- **Workstream update**: a change to a `workstreams/<path>/README.md` file in the
  configured domain repository.
- **Product context**: explicitly configured read-only PAN implementation or
  documentation roots that are not part of the work domain.

## Hostless session experience

- **REQ-EXP-1:** PAN MUST operate in an ordinary GitHub Copilot CLI session
  started with the configured domain repository as its working directory.
- **REQ-EXP-2:** Starting a PAN session MUST NOT start, discover, connect to, or
  require a PAN-specific Copilot extension, MCP server, coordinator, localhost
  bridge, or shared PAN service.
- **REQ-EXP-3:** PAN domain operations MUST use ordinary Copilot CLI
  filesystem, git, GitHub, and terminal tools, invoking documented `pan` CLI
  helper commands where deterministic mechanics are required.
- **REQ-EXP-4:** A PAN session MUST be usable from one validated domain
  configuration without separately starting any background or foreground PAN
  process.
- **REQ-EXP-5:** Interactive and scheduled turns MUST use the same PAN
  personality, authority policy, domain boundary, and durable state.
- **REQ-EXP-6:** A user MUST be able to discuss PAN's reusable behavior and
  documentation from the PAN session when product-context roots are configured.
- **REQ-EXP-7:** Product context MUST be presented as read-only reference and
  MUST NOT be treated as another work domain or as implicit authority to modify
  PAN itself.
- **REQ-EXP-8:** Copilot's own session scheduling MUST provide periodic review
  turns, and exiting the PAN session MUST stop those reviews; no PAN review
  originating from that session MAY begin after exit.
- **REQ-EXP-9:** The absence or failure of any former PAN host, extension, MCP,
  endpoint, token, or host-state artifact MUST NOT prevent an otherwise valid
  hostless PAN session from operating.

## Domain configuration and boundaries

- **REQ-DOM-1:** A PAN session MUST connect to exactly one configured domain at
  a time.
- **REQ-DOM-2:** The domain repository, Project identity, local domain root,
  state namespace, scheduling policy, and PAN session settings MUST be explicit
  configuration or documented defaults.
- **REQ-DOM-3:** PAN session configuration MUST remain independent of runner
  machine, terminal, repository checkout, capacity, credential, and playbook
  configuration.
- **REQ-DOM-4:** Missing, malformed, inaccessible, or internally inconsistent
  domain configuration MUST prevent affected operations and produce an
  actionable error.
- **REQ-DOM-5:** PAN MUST validate that the configured local repository and
  GitHub repository identify the same domain before using local content as
  domain evidence or committing a workstream update.
- **REQ-DOM-6:** PAN MUST validate the configured Project and all required
  fields and options before a turn may mutate Project state.
- **REQ-DOM-7:** Domain file reads and writes MUST be confined to configured
  domain roots, and workstream access MUST be confined to
  `workstreams/<path>/README.md`.
- **REQ-DOM-8:** Product-context reads MUST be confined to explicitly configured
  read-only roots and MUST NOT expand the domain mutation boundary.
- **REQ-DOM-9:** PAN MUST NOT silently combine evidence from another domain,
  repository, Project, or local checkout.
- **REQ-DOM-10:** Credentials and permissions MUST come from the active
  execution environment and MUST NOT be stored in reusable PAN source,
  documentation, or public configuration.

## Canonical GitHub state and complete evidence

- **REQ-EVD-1:** GitHub Issues MUST remain the durable task records for the
  domain.
- **REQ-EVD-2:** The configured GitHub Project MUST remain the source of truth
  for lifecycle, owner, priority, autonomy, requirements, leases, workstream
  association, and canonical ordering.
- **REQ-EVD-3:** PAN MUST NOT maintain a second task queue or ordering that can
  override or disagree with the current Project.
- **REQ-EVD-4:** When a decision depends on the domain's complete Issue
  population, PAN MUST enumerate all open and closed Issues in the configured
  repository through all result pages.
- **REQ-EVD-5:** Pull requests MUST NOT be classified as backlog Issues, even
  when the GitHub API exposes them through an Issue-compatible representation.
- **REQ-EVD-6:** Complete Issue evidence MUST preserve enough durable identity,
  state, content, timestamp, relationship, and closure information to support
  reconciliation, triage, and duplicate detection.
- **REQ-EVD-7:** A complete Project read MUST enumerate every Project item in
  canonical order and every required field value through all result pages.
- **REQ-EVD-8:** Required nested evidence, including Issue comments, labels,
  assignees, linked pull requests, and other evidence used by the decision,
  MUST be complete or explicitly excluded from that decision.
- **REQ-EVD-9:** PAN MUST identify whether each Project item is backed by an
  Issue in the configured domain and MUST NOT silently treat unreadable,
  cross-domain, draft, or pull-request items as ordinary backlog Issues.
- **REQ-EVD-10:** Every completeness-sensitive read MUST expose whether it is
  complete and MUST identify any inaccessible, truncated, inconsistent, or
  unsupported evidence.
- **REQ-EVD-11:** Reaching a pagination or safety limit before complete
  enumeration MUST be treated as incomplete evidence rather than a successful
  partial result.
- **REQ-EVD-12:** A completeness-dependent recommendation or mutation MUST fail
  closed when any required Issue, Project, workstream, or operational evidence
  is incomplete.
- **REQ-EVD-13:** Every recommendation and mutation MUST use domain state
  refreshed for that turn rather than relying only on conversation history or a
  previous scheduled review.
- **REQ-EVD-14:** Evidence used to authorize mutation MUST have a stable snapshot
  identity or equivalent expected-state reference that changes when relevant
  mutable evidence changes.
- **REQ-EVD-15:** Material recommendations and mutations MUST cite durable
  evidence that a user can inspect.
- **REQ-EVD-16:** PAN MUST distinguish facts, interpretations, assumptions, and
  uncertainty and MUST NOT claim completeness or success unsupported by the
  evidence.

## Backlog and Project reconciliation

- **REQ-REC-1:** PAN MUST detect open domain Issues eligible for backlog tracking
  that are missing from the configured Project.
- **REQ-REC-2:** Reconciliation MUST add the existing Issue to the Project and
  MUST NOT create a replacement or duplicate Issue.
- **REQ-REC-3:** Reconciliation of an unchanged missing Issue MUST be
  idempotent.
- **REQ-REC-4:** Reconciliation MUST validate the Issue identity and current
  Project membership immediately before applying the addition.
- **REQ-REC-5:** Reconciliation MUST apply required initial Project fields
  deterministically or report the item as incomplete.
- **REQ-REC-6:** If Project registration or required field application fails
  after an Issue has been found or created, PAN MUST preserve the Issue identity
  for retry and MUST NOT create another Issue.
- **REQ-REC-7:** Automatic reconciliation MUST NOT reopen closed Issues, convert
  pull requests into tasks, or delete Project items solely because their Issue
  is closed.
- **REQ-REC-8:** PAN MUST continue to reconcile linked merged pull requests by
  moving eligible `in-review` work to `done` and closing the backing Issue only
  after the merge is confirmed.
- **REQ-REC-9:** Reconciliation failures MUST be visible and MUST identify
  confirmed effects and remaining incomplete steps.
- **REQ-REC-10:** PAN MUST be able to create an Issue-backed task from an
  explicit user request or a high-confidence actionable commitment supported by
  durable domain evidence.
- **REQ-REC-11:** Before creating a task, PAN MUST check complete open and closed
  Issue evidence for semantic duplicates and stable source identity.
- **REQ-REC-12:** A sourced task MUST record the evidence location, interpreted
  action, relevant date or revision, and creation rationale.
- **REQ-REC-13:** Ambiguous or low-confidence candidate work MUST become a
  question or recommendation rather than an automatically created Issue.
- **REQ-REC-14:** Rejected or closed inferred work MUST NOT be recreated from an
  unchanged source.
- **REQ-REC-15:** Removing or changing source narrative MUST NOT silently delete
  or close an existing Issue.

## Portfolio reasoning, ordering, and durable decisions

- **REQ-PORT-1:** Every portfolio review MUST consider every item needed to
  classify the complete actionable portfolio before recommending or changing
  canonical order.
- **REQ-PORT-2:** PAN MUST consider relevant Issue content and comments, Project
  fields and order, workstream narrative, commitments, dates, dependencies,
  blockers, active leases, runner availability, and recent changes when those
  sources affect the decision.
- **REQ-PORT-3:** PAN MUST explicitly account for items excluded from next-work
  recommendations, including completed, protected, blocked, or actively leased
  work, rather than silently omitting them.
- **REQ-PORT-4:** PAN MUST give a clear recommendation when evidence is
  sufficient and MUST ask a focused question when missing information prevents
  a safe decision.
- **REQ-PORT-5:** PAN MUST write accepted ordering decisions directly to the
  configured Project.
- **REQ-PORT-6:** Human and agent queues MUST remain views over the same
  canonical Project ordering.
- **REQ-PORT-7:** PAN MUST preserve relative precedence deliberately established
  by a human unless the human changes it or explicitly authorizes replacement.
- **REQ-PORT-8:** PAN MAY insert genuinely new urgent work ahead of existing
  manual precedence, but MUST preserve unaffected relative order and explain
  the insertion.
- **REQ-PORT-9:** Material triage, routing, priority, ordering, commitment, and
  blocker decisions MUST record a specific rationale and durable evidence.
- **REQ-PORT-10:** Durable decisions or commitments arising in conversation MUST
  be promoted to an appropriate Issue, Project field, comment, or workstream
  record rather than existing only in session history.
- **REQ-PORT-11:** Repeating a review against materially unchanged complete
  evidence SHOULD produce an equivalent recommendation, ordering, and
  reconciliation result.

## Session tools and deterministic PAN helpers

- **REQ-TOOL-1:** The PAN session MUST use ordinary Copilot CLI filesystem, git,
  GitHub, and terminal tools for domain reads, searches, reasoning, and
  repository operations.
- **REQ-TOOL-2:** Documented `pan` CLI helper commands MUST provide the
  deterministic mechanics needed for complete portfolio reads, Issue and
  Project mutations, attention, runner availability, configuration,
  leadership, concurrency checks, and conflict-safe workstream delivery.
- **REQ-TOOL-3:** PAN helper commands MUST document their inputs, outputs,
  preconditions, and side effects, and MUST reject unknown or unsupported
  operations and arguments without side effects.
- **REQ-TOOL-4:** PAN helper command results MUST distinguish confirmed success,
  rejection, incomplete evidence, stale state, and partial external effects.
- **REQ-TOOL-5:** Interactive and Copilot-scheduled turns MUST follow the same
  domain, authority, lifecycle, lease, evidence, and concurrency policy whether
  they use ordinary tools or `pan` helper commands.
- **REQ-TOOL-6:** Availability of ordinary Copilot tools MUST NOT expand PAN's
  authorized mutation boundary beyond the configured domain and explicitly
  configured product-context reads.
- **REQ-TOOL-7:** Reads and recommendations MAY proceed in a read-only session;
  deterministic mutation helpers and the PAN session MUST reject mutation
  unless that session currently holds mutating leadership.
- **REQ-TOOL-8:** No required PAN operation MAY depend on a PAN-specific Copilot
  extension, MCP server, localhost bridge, or shared PAN service.

## Workstream reads and writes

- **REQ-WS-1:** PAN MUST list, read, search, and inspect history for workstream
  `README.md` files below the configured domain's `workstreams/` hierarchy.
- **REQ-WS-2:** Workstream hierarchy MUST be derived from folder nesting, and
  references MUST use the full path relative to `workstreams/`.
- **REQ-WS-3:** A PAN session MUST be able to create or update a workstream
  `README.md` when authorized by the domain policy.
- **REQ-WS-4:** A workstream write MUST be based on an identified current source
  revision and MUST fail or be re-evaluated if the target changed concurrently.
- **REQ-WS-5:** A workstream write MUST preserve unrelated tracked, untracked,
  staged, and unstaged changes in the user's existing working trees.
- **REQ-WS-6:** A workstream commit MUST contain only the intended domain
  workstream changes and any explicitly authorized closely related domain
  metadata.
- **REQ-WS-7:** Every completed workstream update MUST be attributable through a
  durable commit that identifies PAN's rationale or source turn.
- **REQ-WS-8:** PAN domain workstream updates MUST be committed directly to the
  configured domain repository's default branch and pushed without creating a
  pull request.
- **REQ-WS-9:** PAN MUST prepare each workstream update against a freshly fetched
  revision of the remote default branch in an isolated git workspace that does
  not alter the user's existing working trees.
- **REQ-WS-10:** Immediately before committing and pushing, PAN MUST verify the
  expected default-branch revision and MUST re-evaluate the update or report a
  conflict when concurrent remote changes prevent safe application.
- **REQ-WS-11:** PAN MUST push only a conflict-free attributable commit to the
  default branch and MUST NOT create an intermediate delivery branch or pull
  request for a PAN domain workstream update.
- **REQ-WS-12:** Workstream delivery MUST respect repository permissions, branch
  protection, required review, and force-operation prohibitions.
- **REQ-WS-13:** PAN MUST NOT force-push, discard remote changes, overwrite
  unrelated local changes, or claim that a conflicted workstream update
  succeeded.
- **REQ-WS-14:** Commit, push, and merge-conflict failures MUST identify the
  confirmed commit and branch state, the unresolved step, and a safe recovery
  path.
- **REQ-WS-15:** Retrying an unchanged workstream update MUST NOT create
  duplicate commits.
- **REQ-WS-16:** A workstream mutation MUST revalidate leadership and expected
  domain state before each externally visible delivery step.

## Session scheduling and turn coordination

- **REQ-SCH-1:** The writing PAN session MUST use Copilot's own session
  scheduling to support configurable periodic portfolio-review prompts while
  that session remains running.
- **REQ-SCH-2:** Read-only sessions MUST NOT schedule or execute autonomous
  portfolio reviews.
- **REQ-SCH-3:** Copilot MUST deliver a scheduled review as a PAN turn in the
  active writing session, using the same ordinary tools, documented `pan`
  helpers, authority, and complete-evidence rules as an interactive turn.
- **REQ-SCH-4:** A scheduled review MUST NOT overlap any other PAN turn in the
  same session.
- **REQ-SCH-5:** When a review becomes due during another PAN turn, PAN MUST
  coalesce or defer it and perform a fresh review after the active turn rather
  than running both turns concurrently.
- **REQ-SCH-6:** Cadence, startup-review policy, general retry, and rate-limit
  retry behavior MUST be configurable, bounded, and documented.
- **REQ-SCH-7:** Reviews missed while no writing PAN session is running MUST NOT
  execute later merely to catch up.
- **REQ-SCH-8:** After startup, the writing session MUST schedule at most one
  fresh initial review according to the configured startup policy.
- **REQ-SCH-9:** A scheduled review MUST refresh all evidence required by its
  decisions immediately before recommendation or mutation.
- **REQ-SCH-10:** Transient failures MAY be retried according to policy but MUST
  NOT busy-loop, overlap another turn, or duplicate mutations.
- **REQ-SCH-11:** A failed, rejected, or incomplete scheduled review MUST be
  visible in the PAN session and MUST NOT be represented as successful.
- **REQ-SCH-12:** Session shutdown MUST end Copilot's pending review schedule for
  that session and prevent new scheduled mutations from beginning.

## Single-writer leadership

- **REQ-LEAD-1:** At most one PAN session MAY hold mutating leadership for a
  domain at any time, including across machines.
- **REQ-LEAD-2:** Multiple PAN sessions MAY read and discuss the same domain
  concurrently.
- **REQ-LEAD-3:** A session that does not hold leadership MUST identify itself as
  read-only before accepting a mutation request.
- **REQ-LEAD-4:** Leadership acquisition and renewal MUST use durable
  concurrency control that prevents two contenders from both confirming
  ownership of the same leadership generation.
- **REQ-LEAD-5:** Leadership MUST expire unless renewed at the configured
  cadence.
- **REQ-LEAD-6:** PAN MUST revalidate current leadership immediately before
  every mutation, including each non-atomic step of a multi-system operation.
- **REQ-LEAD-7:** Leadership loss or inability to revalidate leadership MUST
  prevent all subsequent mutation steps based on the affected turn.
- **REQ-LEAD-8:** After leadership loss, the session MAY continue read-only
  conversation but MUST clearly report that mutation and scheduling authority
  are unavailable.
- **REQ-LEAD-9:** A live remote or unverifiable leader MUST remain protected
  until it releases leadership or its lease expires.
- **REQ-LEAD-10:** Reclaiming leadership from an apparently stopped local
  session MUST require positive evidence that the recorded process is no longer
  active or that the lease has expired.
- **REQ-LEAD-11:** Normal session exit SHOULD release leadership promptly;
  abnormal exit MUST become recoverable through lease expiry without manual
  corruption of canonical domain state.
- **REQ-LEAD-12:** Runner task leases MUST remain independent of PAN session
  leadership and MUST NOT be invalidated merely because the writing PAN session
  changes.

## Authority, lifecycle, and concurrency safety

- **REQ-SAFE-1:** Every mutation MUST be validated for schema, domain, authority,
  lifecycle, active leases, protected statuses, expected current state, and
  leadership before application.
- **REQ-SAFE-2:** Reads, searches, recommendations, and proposals MUST be
  automatic when their evidence is accessible and within the configured domain.
- **REQ-SAFE-3:** Adding an existing open Issue to the Project MUST be automatic
  and deterministic when all reconciliation preconditions are satisfied.
- **REQ-SAFE-4:** Routine triage field updates, Project reordering, sourced Issue
  creation, Issue comments, attention records, and workstream commits MAY apply
  without separate approval only when PAN records a specific rationale and
  durable evidence.
- **REQ-SAFE-5:** Domain policy MUST explicitly classify actions as automatic,
  approval-required, or prohibited.
- **REQ-SAFE-6:** Destructive actions, protected lifecycle changes, clearing
  human- or runner-created blocks, overriding active leases, force operations,
  and mutations outside configured domain roots MUST require explicit approval
  or be prohibited by policy.
- **REQ-SAFE-7:** PAN MUST preserve `in-progress`, `in-review`, and `done` work
  from automated retriage unless an authorized action explicitly targets that
  lifecycle state.
- **REQ-SAFE-8:** PAN MUST preserve human and runner blocks and MAY
  automatically clear only a PAN-created block whose cause it can verify is
  resolved.
- **REQ-SAFE-9:** PAN MUST preserve active runner leases, claimant state, resume
  affinity, and runner-owned operational fields.
- **REQ-SAFE-10:** PAN MUST preserve human precedence and explicit durable user
  directives unless the user changes them or authorizes an override.
- **REQ-SAFE-11:** Before changing mutable state, PAN MUST confirm that the
  expected state still matches current state; a mismatch MUST cause rejection
  or a fresh read and re-evaluation.
- **REQ-SAFE-12:** A reorder MUST contain and preserve every current Project item
  exactly once unless a separately authorized reconciliation action changes
  membership.
- **REQ-SAFE-13:** A multi-action request MUST define whether actions are
  independent or require all-or-nothing application and MUST report the actual
  outcome accordingly.
- **REQ-SAFE-14:** PAN MUST NOT report a multi-step or multi-action mutation as
  complete while any required effect is unconfirmed.
- **REQ-SAFE-15:** Retries MUST be idempotent with respect to Issue creation,
  Project addition, field transitions, comments, ordering, workstream commits,
  branches, and pull requests.

## Attention and conversation behavior

- **REQ-ATTN-1:** The existing ability to list unresolved human attention and
  all `in-review` work MUST remain available from the hostless PAN experience
  and CLI.
- **REQ-ATTN-2:** Attention entries MUST identify the task, kind, priority,
  prompt, Issue location, and available pull-request, machine, terminal, local
  URL, or resume locator.
- **REQ-ATTN-3:** The existing ability to answer by item ID or Issue URL MUST be
  preserved.
- **REQ-ATTN-4:** An answer MUST be recorded durably and MUST return eligible
  `blocked` or `needs-detail` work to reconsideration without discarding the
  answer, prior priority, or runner resume affinity.
- **REQ-ATTN-5:** Attempting to answer an item with no unresolved attention MUST
  produce a clear error and MUST NOT create misleading answer state.
- **REQ-ATTN-6:** Genuine human-blocking questions MUST remain distinct from
  operational failures such as session exit, terminal closure, launch failure,
  or missing worker result.
- **REQ-ATTN-7:** Operational failures MUST remain eligible for safe runner retry
  and MUST NOT create false urgent human attention.
- **REQ-ATTN-8:** The existing ability to add an untriaged Issue-backed item with
  body, workstream, owner, priority, autonomy, and repeatable requirements MUST
  be preserved.
- **REQ-ATTN-9:** Machine-readable output for attention, answer, task-addition,
  review, and mutation results MUST remain available.
- **REQ-ATTN-10:** Conversation history and local session metadata MUST NOT be
  the only durable record of an answer, commitment, mutation, or delivery.

## Runner preservation

- **REQ-RUN-1:** Per-machine runner daemons MUST remain separate deterministic
  execution services and MUST NOT be replaced by PAN session scheduling or
  model reasoning.
- **REQ-RUN-2:** Existing runners MUST remain able to discover, atomically claim,
  heartbeat, execute, and release compatible `ready`, claimable, agent-owned
  work with an executable autonomy mode while a hostless PAN session is running
  or absent.
- **REQ-RUN-3:** Runner selection MUST continue to use canonical Project order,
  task requirements, enabled playbooks, online state, and available capacity.
- **REQ-RUN-4:** An active task lease owned by another claimant MUST NOT be
  overwritten by PAN or another runner.
- **REQ-RUN-5:** Runner lease renewal MUST remain independent of worker
  responsiveness and PAN session leadership.
- **REQ-RUN-6:** Each worker task MUST remain isolated by branch, worktree,
  task state, and worker session.
- **REQ-RUN-7:** Runner-controlled validation MUST remain responsible for
  accepting delivery evidence and applying task lifecycle transitions.
- **REQ-RUN-8:** Runner playbooks MUST use branch-and-pull-request delivery by
  default, and MAY explicitly configure direct default-branch merge and push
  when the target repository policy permits it.
- **REQ-RUN-9:** Pull-request delivery MUST remain `in-review` until merged-PR
  reconciliation confirms completion; validated direct delivery MAY complete
  immediately.
- **REQ-RUN-10:** Lost leases, operational stops, and incomplete delivery MUST
  continue to fail safely without claiming completion or erasing resumable
  state.
- **REQ-RUN-11:** Hostless PAN MUST continue to read sanitized runner
  availability and active work without exposing private machine settings or
  credentials.
- **REQ-RUN-12:** Removing the PAN host MUST NOT require a runner profile to
  contain PAN session scheduling, leadership, conversation, or domain mutation
  settings.
- **REQ-RUN-13:** PAN's own runner playbook MAY explicitly select direct
  default-branch merge and push; this exception MUST be visible in the playbook
  and MUST retain validation, lease, no-force, and conflict-reporting safety.

## Reliability, auditability, and privacy

- **REQ-REL-1:** Every material mutation MUST be attributable to a PAN turn and
  inspectable through durable domain records.
- **REQ-REL-2:** PAN MUST report GitHub, git, filesystem, permission, schema,
  validation, leadership, and concurrency failures without fabricating state.
- **REQ-REL-3:** A failure after an external side effect MUST identify every
  confirmed effect and every required step that remains incomplete.
- **REQ-REL-4:** PAN MUST preserve canonical domain validity when a turn is
  cancelled, the CLI exits, leadership is lost, or a dependency fails.
- **REQ-REL-5:** Rate limiting and transient service failures MUST use bounded
  retry behavior and MUST NOT cause duplicate side effects.
- **REQ-REL-6:** Attention, task-addition, configuration, and safe read
  operations SHOULD remain available when portfolio reasoning is unavailable,
  unless current domain safety constraints prevent them.
- **REQ-REL-7:** User-specific workstreams, Issues, configuration, credentials,
  runner state, leases, machine settings, and session metadata MUST remain in
  the private domain repository or local machine configuration.
- **REQ-REL-8:** The reusable PAN repository MUST remain data-neutral and MUST
  not receive private domain content as an incidental result of hostless
  operation.
- **REQ-REL-9:** Logs and diagnostics MUST avoid exposing credentials and
  unnecessary private machine configuration.

## Migration and compatibility

- **REQ-MIG-1:** Existing valid domain configurations MUST remain usable or be
  accepted by a deterministic migration that preserves their domain identity,
  Project, state namespace, agent settings, and attention assignee.
- **REQ-MIG-2:** New Copilot session-scheduling settings MUST have documented
  defaults, and PAN domain workstream delivery MUST migrate to direct
  default-branch commit and push without a pull request.
- **REQ-MIG-3:** Existing runner profiles and runner commands MUST continue to
  operate independently without migration to the PAN session configuration.
- **REQ-MIG-4:** Existing Project fields, lifecycle values, priorities, autonomy
  values, capability requirements, Issues, comments, leases, and canonical order
  MUST remain valid without destructive data migration.
- **REQ-MIG-5:** Existing structured attention, answer, runner-result, and
  delivery records MUST remain readable.
- **REQ-MIG-6:** Existing non-host attention, answer, task-addition, review, and
  runner workflows MUST retain equivalent behavior or provide an explicit
  replacement command with actionable migration guidance.
- **REQ-MIG-7:** Commands or options whose only purpose was to start, connect to,
  inspect, or stop a PAN host, extension, MCP server, bridge, or shared service
  MAY be retired, but MUST NOT silently start one and MUST explain how to start
  an ordinary domain-rooted Copilot CLI session.
- **REQ-MIG-8:** Obsolete extension, MCP, localhost endpoint, token, host state,
  and host log artifacts MUST NOT be treated as current leadership or
  authoritative domain state after migration.
- **REQ-MIG-9:** During a transition period, an older PAN host and a hostless PAN
  session targeting the same domain MUST contend for the same mutating
  leadership so they cannot both write.
- **REQ-MIG-10:** Migration MUST preserve the ability to release or recover
  existing leadership state without editing canonical Issues or Project data.
- **REQ-MIG-11:** The hostless release MUST remain compatible with Node.js 22 or
  newer and the package's supported GitHub CLI authentication model unless a
  separately approved requirement revises those constraints.
- **REQ-MIG-12:** Existing runner playbooks without an explicit delivery mode
  MUST retain branch-and-pull-request delivery, while explicitly configured
  direct playbooks, including PAN's own playbook, MUST retain their selected
  mode when valid.

## Out of scope

The following are outside the hostless PAN feature:

- A PAN-specific Copilot extension, MCP server, resident coordinator, watchdog,
  localhost HTTP service, shared PAN service, or detached scheduler.
- Replacing per-machine runner daemons with a model-driven execution loop.
- Cross-domain reasoning, federation, or a global queue spanning multiple
  domain repositories.
- A second task queue, shadow priority list, or conversation-only task store.
- Implicit write access to PAN's reusable product repository or any configured
  product-context root.
- Autonomous force-pushes, branch-protection bypass, automatic pull-request
  merges, destructive Issue deletion, or unauthorized protected-state changes.
- Catch-up execution of every review missed while PAN was not running.
- Pushing work to a specifically named runner instead of pull-based matching.
- A new graphical user interface.

## Acceptance criteria summary

| Capability | Acceptance summary | Requirements |
| --- | --- | --- |
| Hostless PAN session | One ordinary, domain-rooted Copilot CLI session converses, reasons, and receives Copilot-scheduled reviews without a PAN extension, MCP server, host, bridge, or shared service. | REQ-EXP-1–9 |
| Bounded domain | The session validates one domain, confines domain writes and product-context reads, and rejects mismatched or cross-domain inputs. | REQ-DOM-1–10 |
| Complete evidence | PAN completely enumerates required Issues and Project evidence, distinguishes pull requests, cites durable sources, and fails closed on partial evidence. | REQ-EVD-1–16 |
| Backlog reconciliation and creation | Existing open Issues missing from the Project are added exactly once, sourced work is created without duplication, and merged pull requests complete eligible work only after confirmation. | REQ-REC-1–15 |
| Portfolio decisions | A complete review produces evidence-backed recommendations and canonical Project changes while preserving human precedence. | REQ-PORT-1–11 |
| Session tools and helpers | Interactive and scheduled turns use ordinary file, git, GitHub, and terminal tools plus documented `pan` helpers for deterministic mechanics, with no extension, MCP, bridge, or shared-service dependency. | REQ-TOOL-1–8 |
| Workstream delivery | PAN safely commits each workstream update directly to the domain default branch and pushes without a pull request, preserving unrelated work, never force-pushing, and reporting conflicts. | REQ-WS-1–16 |
| Session scheduling | Copilot's own scheduling gives only the writing session bounded, non-overlapping periodic reviews; missed reviews do not catch up and all scheduling stops with the session. | REQ-SCH-1–12 |
| Single writer | Concurrent sessions may read, but only one cross-machine leader can mutate; every mutation revalidates leadership and stops after loss. | REQ-LEAD-1–12 |
| Safe authority | Mutations obey schema, evidence, lifecycle, lease, expected-state, approval, and idempotency policy and never misreport partial effects. | REQ-SAFE-1–15 |
| Attention and conversation | Inbox, answers, task addition, durable outcomes, machine-readable results, and the distinction between questions and operational failures remain available. | REQ-ATTN-1–10 |
| Preserved runners | Existing runner daemons continue canonical selection, atomic claims, lease renewal, isolated execution, and validated delivery; playbooks default to branch plus PR but may explicitly select safe direct default-branch delivery. | REQ-RUN-1–13 |
| Reliability and privacy | Effects are attributable and diagnosable, retries are bounded, canonical state survives interruption, and private data remains private. | REQ-REL-1–9 |
| Migration compatibility | Existing domain data, configurations, records, runners, and leadership remain safe while host, extension, MCP, bridge, and shared-service integration is retired with guidance and delivery defaults migrate explicitly. | REQ-MIG-1–12 |
