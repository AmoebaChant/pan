# Reasoning-first PAN requirements

## Purpose

This document defines the product requirements for evolving PAN from its
rule-based walking skeleton into a reasoning-first personal chief of staff for
one GitHub-backed domain.

Requirements marked **R1** apply to the first reasoning-focused release.
Requirements marked **Later** apply to the subsequent runner and playbook
migration. Unless a requirement explicitly replaces existing behavior, PAN
MUST preserve the useful store, lifecycle, attention, lease, and isolated-worker
behavior already provided by the repository.

## Terms

- **Domain**: one private repository, its workstream narrative, its Issues, and
  its configured GitHub Project.
- **Canonical queue**: the ordering of items in the configured GitHub Project.
- **Actionable item**: an open Project item that may require planning, human
  attention, execution, review, or a lifecycle decision.
- **PAN turn**: one autonomous or interactive reasoning pass by the PAN agent.
- **Evidence citation**: a reference that identifies the supporting Issue,
  comment, Project field, workstream path and revision, or other durable domain
  record.
- **Manual precedence**: relative ordering explicitly established by a user in
  the GitHub Project or through PAN conversation.

## Domain boundary and configuration

- **REQ-DOM-1 (R1):** A PAN instance MUST connect to exactly one configured
  domain at a time.
- **REQ-DOM-2 (R1):** PAN MUST NOT include information from another domain in a
  recommendation or action unless the user explicitly supplies that information
  during the current interaction.
- **REQ-DOM-3 (R1):** Repository names and workstream paths MUST be treated as
  domain configuration rather than assumptions embedded in PAN's reusable
  agent definition or product behavior.
- **REQ-DOM-4 (R1):** PAN runtime configuration MUST be independently usable
  from runner execution configuration.
- **REQ-DOM-5 (R1):** Missing, malformed, inaccessible, or internally
  inconsistent domain configuration MUST prevent affected mutations and MUST
  produce an actionable error.
- **REQ-DOM-6 (R1):** PAN MUST validate that the configured Project exposes the
  required lifecycle, routing, priority, requirement, autonomy, lease, claimant,
  and workstream fields before mutating it.
- **REQ-DOM-7 (R1):** Workstream references MUST resolve only to README files
  below the domain's `workstreams/` hierarchy and MUST NOT escape that
  hierarchy.

## Canonical domain data

- **REQ-DATA-1 (R1):** GitHub Issues MUST remain the durable backlog records for
  tasks in the domain.
- **REQ-DATA-2 (R1):** The configured GitHub Project MUST remain the source of
  truth for task lifecycle, owner, priority, autonomy, execution requirements,
  lease state, workstream association, and canonical ordering.
- **REQ-DATA-3 (R1):** PAN MUST NOT maintain a second task ordering that can
  override or disagree with the current Project ordering.
- **REQ-DATA-4 (R1):** Open domain Issues that are eligible for backlog tracking
  but absent from the Project MUST be detected and added without creating a
  duplicate Issue.
- **REQ-DATA-5 (R1):** Workstream hierarchy MUST be derived from folder nesting,
  and an item's workstream association MUST use the full path relative to
  `workstreams/`.
- **REQ-DATA-6 (R1):** PAN MUST preserve the existing owner values
  `unassigned`, `human`, and `agent`.
- **REQ-DATA-7 (R1):** PAN MUST preserve the existing lifecycle values
  `untriaged`, `needs-detail`, `ready`, `in-progress`, `in-review`, `done`, and
  `blocked`.
- **REQ-DATA-8 (R1):** PAN MUST preserve the existing priority values `urgent`,
  `high`, `normal`, and `low`, and autonomy values `manual`, `full-auto`, and
  `agent-reviewer`.
- **REQ-DATA-9 (R1):** PAN MUST preserve newline-delimited capability
  requirements, including repository requirements in `repo:<owner/name>` form.
- **REQ-DATA-10 (R1):** PAN MUST expose a concise, durable rationale and review
  time for material portfolio decisions in the domain's GitHub-backed state.
- **REQ-DATA-11 (R1):** Reads that cannot enumerate all required Project items
  or all relevant field values MUST fail closed and MUST NOT produce a
  purportedly complete portfolio decision.
- **REQ-DATA-12 (R1):** Partial creation of an Issue-backed Project item MUST
  either be rolled back or reported as incomplete with enough information for a
  human to repair it.

## PAN identity and advisory behavior

- **REQ-ADV-1 (R1):** Autonomous reviews and interactive conversations MUST use
  the same logical PAN personality, goals, authority, and reasoning standards.
- **REQ-ADV-2 (R1):** PAN MUST give a clear recommendation when evidence is
  sufficient rather than presenting an unranked list of possibilities.
- **REQ-ADV-3 (R1):** PAN MUST distinguish durable facts, interpretations,
  assumptions, and uncertainty in explanations of material decisions.
- **REQ-ADV-4 (R1):** PAN MUST identify important tradeoffs and MAY challenge a
  requested or existing priority when domain evidence indicates a material
  contradiction, risk, or neglected commitment.
- **REQ-ADV-5 (R1):** User-facing recommendations SHOULD be concise and focused
  on decisions, next actions, blockers, and commitments.
- **REQ-ADV-6 (R1):** PAN MUST NOT claim certainty unsupported by the available
  domain evidence.
- **REQ-ADV-7 (R1):** PAN's communication SHOULD be warm, respectful, and
  protective of the user's time and stated commitments.

## Complete portfolio reasoning

- **REQ-REA-1 (R1):** Every planning pass MUST enumerate every Project item
  needed to classify the complete actionable portfolio before changing the
  canonical queue.
- **REQ-REA-2 (R1):** PAN MUST explicitly classify items that are not candidates
  for next work, such as completed or actively leased work, rather than silently
  omitting them from portfolio consideration.
- **REQ-REA-3 (R1):** For each actionable item, PAN MUST consider its Issue body,
  relevant comments and answers, Project fields, timestamps, workstream
  narrative, dependencies, blockers, active leases, and recent relevant changes
  when those sources are available.
- **REQ-REA-4 (R1):** PAN MUST consider explicit commitments and MAY infer
  commitments from narrative only when it can cite the source and communicate
  its confidence.
- **REQ-REA-5 (R1):** PAN MUST consider the current date and time when evaluating
  deadlines, aging, commitments, and urgency.
- **REQ-REA-6 (R1):** PAN MUST consider runner availability and compatibility
  when recommending or ordering agent-owned work.
- **REQ-REA-7 (R1):** PAN MUST identify missing or conflicting information that
  could materially change a recommendation.
- **REQ-REA-8 (R1):** When missing information prevents a safe decision, PAN
  MUST ask a focused question and MUST NOT invent the missing fact.
- **REQ-REA-9 (R1):** A material recommendation or reorder MUST include evidence
  citations sufficient for a user to inspect the supporting durable records.
- **REQ-REA-10 (R1):** Repeating a planning pass against unchanged inputs SHOULD
  produce an equivalent ordering and materially equivalent rationale.
- **REQ-REA-11 (R1):** PAN MUST NOT replace portfolio judgment with a fixed
  priority-and-status sort, although deterministic policy MAY validate inputs,
  outputs, and lifecycle safety.

## Canonical ordering and user overrides

- **REQ-ORD-1 (R1):** PAN MUST write accepted portfolio ordering decisions
  directly to the configured GitHub Project.
- **REQ-ORD-2 (R1):** Human and agent queues MUST be views or filters over the
  same canonical Project ordering.
- **REQ-ORD-3 (R1):** Agent runners MUST select compatible work according to the
  canonical Project ordering, not an independently generated priority order.
- **REQ-ORD-4 (R1):** PAN MUST detect manual precedence established outside the
  current PAN action.
- **REQ-ORD-5 (R1):** PAN MUST preserve manual precedence until the user changes
  it or explicitly authorizes PAN to replace it.
- **REQ-ORD-6 (R1):** PAN MAY insert genuinely new urgent work ahead of manually
  ordered items, but MUST preserve unaffected relative precedence and explain
  the insertion.
- **REQ-ORD-7 (R1):** PAN MUST explain any material reorder, including which
  evidence or changed condition caused it.
- **REQ-ORD-8 (R1):** Operational audit state used to recognize manual changes
  MUST NOT become an alternate queue or override the current Project order.
- **REQ-ORD-9 (R1):** A concurrent Project change that invalidates PAN's
  ordering assumptions MUST cause PAN to re-read and re-evaluate before applying
  a conflicting reorder.

## Inferred commitments and task creation

- **REQ-INF-1 (R1):** PAN MUST detect high-confidence actionable commitments in
  relevant workstream narrative when no corresponding task exists.
- **REQ-INF-2 (R1):** Before creating inferred work, PAN MUST check for semantic
  duplicates among open and previously resolved domain tasks.
- **REQ-INF-3 (R1):** An automatically inferred Issue MUST identify the source
  workstream path, source revision or timestamp, interpreted date when relevant,
  extracted action, and creation rationale.
- **REQ-INF-4 (R1):** Ambiguous or low-confidence candidate commitments MUST
  become questions or recommendations rather than automatically created Issues.
- **REQ-INF-5 (R1):** PAN MUST use a stable source identity so an unchanged
  commitment cannot create repeated Issues across planning passes.
- **REQ-INF-6 (R1):** If a user rejects or closes inferred work, PAN MUST
  suppress recreation from the unchanged source.
- **REQ-INF-7 (R1):** Removing or changing source narrative MUST NOT silently
  delete or close an existing Issue.
- **REQ-INF-8 (R1):** An inferred task MUST enter the same Project and lifecycle
  as other work and MUST NOT use a separate inferred-task queue.
- **REQ-INF-9 (R1):** If Issue creation succeeds but Project registration or
  required field application fails, PAN MUST report or repair the incomplete
  state without creating another Issue on retry.

## Runtime scheduling and leadership

- **REQ-RUN-1 (R1):** The PAN runtime MUST synchronize domain changes and
  schedule reasoning in response to new or changed tasks, answers, source
  changes, and relevant time boundaries.
- **REQ-RUN-2 (R1):** The runtime SHOULD coalesce related changes into one
  portfolio review when doing so does not miss a commitment or delay an urgent
  decision.
- **REQ-RUN-3 (R1):** The runtime MUST support both a single review cycle and
  continuous operation.
- **REQ-RUN-4 (R1):** At most one PAN runtime MAY mutate a domain as leader at a
  time.
- **REQ-RUN-5 (R1):** A runtime that cannot acquire or retain domain leadership
  MUST NOT continue applying mutations.
- **REQ-RUN-6 (R1):** Leadership loss during a PAN turn MUST prevent subsequent
  mutations based on that turn until leadership and current state are
  revalidated.
- **REQ-RUN-7 (R1):** Poll, full-review, heartbeat, notification, and retry
  cadences MUST be bounded, configurable, and documented.
- **REQ-RUN-8 (R1):** Idle operation SHOULD reduce polling frequency without
  preventing prompt response to configured urgent events.
- **REQ-RUN-9 (R1):** GitHub rate limiting and transient service failures MUST
  delay and retry work without busy-looping or duplicating mutations.
- **REQ-RUN-10 (R1):** Shutdown MUST stop new mutations, release owned
  leadership when possible, and leave durable domain state valid.
- **REQ-RUN-11 (R1):** A failed autonomous turn MUST be visible to the user or
  operator and MUST NOT be represented as a successful portfolio review.

## Actions, validation, and lifecycle safety

- **REQ-ACT-1 (R1):** PAN MUST act only through an explicitly allowed,
  domain-scoped operation set.
- **REQ-ACT-2 (R1):** Every requested mutation from a PAN turn MUST be validated
  for schema, authority, lifecycle, lease, domain, and concurrency constraints
  before application.
- **REQ-ACT-3 (R1):** Invalid, malformed, unauthorized, or out-of-domain actions
  MUST be rejected without applying their partial effects.
- **REQ-ACT-4 (R1):** PAN MUST re-read mutable state when necessary to avoid
  overwriting a concurrent human or runner change.
- **REQ-ACT-5 (R1):** PAN MUST preserve `in-progress`, `in-review`, and `done`
  work from automated retriage unless an authorized action explicitly targets
  that lifecycle state.
- **REQ-ACT-6 (R1):** PAN MUST preserve blocks created by a human or runner and
  MUST only automatically clear a block that PAN created for a condition it can
  verify has been resolved.
- **REQ-ACT-7 (R1):** Status transitions that may race with workers MUST use
  ownership protection and MUST be confirmed before PAN reports success.
- **REQ-ACT-8 (R1):** PAN MUST NOT silently treat a partially applied multi-step
  action as complete.
- **REQ-ACT-9 (R1):** The authority policy MUST identify which PAN actions are
  automatic, which require explanation, and which require human approval.
- **REQ-ACT-10 (R1):** Durable outcomes from conversation MUST be promoted to an
  appropriate Issue, Project field, comment, or workstream record rather than
  relying only on model conversation history.

## Conversation and human attention

- **REQ-CONV-1 (R1):** PAN MUST provide an interactive interface to the same
  domain context, personality, and canonical queue used by autonomous reviews.
- **REQ-CONV-2 (R1):** A user MUST be able to ask why work is ordered as it is
  and receive the current rationale with evidence citations.
- **REQ-CONV-3 (R1):** A user MUST be able to add work, change task attributes,
  establish relative precedence, reschedule work, and answer pending questions
  through PAN, subject to the same validation as autonomous actions.
- **REQ-CONV-4 (R1):** PAN MUST NOT maintain a conversation-only queue or
  conversation-only task state.
- **REQ-CONV-5 (R1):** The existing ability to list unresolved human attention
  and all `in-review` work MUST be preserved.
- **REQ-CONV-6 (R1):** Human-attention entries MUST identify the task, kind,
  priority, prompt, Issue location, and any available pull-request, machine,
  terminal, or local-URL locator.
- **REQ-CONV-7 (R1):** The existing ability to answer by item ID or Issue URL
  MUST be preserved.
- **REQ-CONV-8 (R1):** An answer MUST be recorded durably and MUST return
  `blocked` or `needs-detail` work to reconsideration without discarding the
  answer.
- **REQ-CONV-9 (R1):** Attempting to answer an item with no unresolved
  attention MUST produce a clear error and MUST NOT create a misleading answer
  state.
- **REQ-CONV-10 (R1):** The existing ability to add an untriaged Issue-backed
  item with body, workstream, owner, priority, autonomy, and repeatable
  requirements MUST be preserved.
- **REQ-CONV-11 (R1):** Machine-readable output for attention and task-creation
  operations MUST remain available.
- **REQ-CONV-12 (R1):** Conversation transcript retention MUST follow a
  documented policy, while durable decisions and commitments MUST remain
  recoverable independently of retained transcripts.
- **REQ-CONV-13 (R1):** Valid explicit user directives for workstream, owner,
  priority, autonomy, and capability requirements MUST remain supported and
  MUST be treated as durable user input unless the user changes them.

## Store and lease compatibility

- **REQ-STORE-1 (R1):** PAN and runners MUST share one validated interpretation
  of Project fields and allowed values.
- **REQ-STORE-2 (R1):** Unknown fields and invalid select values MUST be rejected
  before mutation.
- **REQ-STORE-3 (R1):** Item claims MUST use a renewable lease and MUST be
  confirmed before work starts.
- **REQ-STORE-4 (R1):** An active lease owned by another claimant MUST NOT be
  overwritten.
- **REQ-STORE-5 (R1):** An expired lease MAY be reclaimed after current state is
  verified.
- **REQ-STORE-6 (R1):** A heartbeat MUST renew only a live lease owned by the
  same claimant.
- **REQ-STORE-7 (R1):** Release MUST clear claimant and lease state and MUST be
  confirmed before the claimant reports release success.
- **REQ-STORE-8 (R1):** Failure to apply an optional Issue assignment after a
  claim MUST roll back the claim or report an unreconciled state.
- **REQ-STORE-9 (R1):** Project reads, writes, comments, ordering changes, and
  lease operations MUST report GitHub permission, schema, and availability
  failures without fabricating state.

## First-release runner compatibility

- **REQ-EXEC-1 (R1):** Existing pull-based runners MUST remain able to discover,
  claim, heartbeat, execute, and release compatible agent-owned work.
- **REQ-EXEC-2 (R1):** A runner MUST consider only `ready`, claimable,
  agent-owned work with an executable autonomy mode and exactly one supported
  target repository.
- **REQ-EXEC-3 (R1):** A runner MUST NOT claim work unless all task requirements
  match its advertised available capabilities.
- **REQ-EXEC-4 (R1):** A runner MUST respect its online state and configured
  concurrency limit.
- **REQ-EXEC-5 (R1):** Work MUST execute on a unique non-default branch in an
  isolated worktree based on the configured target repository's current default
  branch.
- **REQ-EXEC-6 (R1):** The worker context MUST include the Issue, comments and
  answers, target repository and branch, associated workstream narrative,
  execution limits, and reporting expectations.
- **REQ-EXEC-7 (R1):** A worker MUST NOT push, force-push, merge, modify a
  default branch, create or close GitHub work items, or bypass runner-owned
  delivery controls.
- **REQ-EXEC-8 (R1):** The runner MUST verify the target repository identity,
  branch, lease ownership, and existence of a task commit before publishing
  completed work.
- **REQ-EXEC-9 (R1):** Completed work MUST be pushed only to its task branch,
  handed off through a pull request, and moved to `in-review`.
- **REQ-EXEC-10 (R1):** Blocked, failed, timed-out, or budget-exhausted work MUST
  report a useful summary and locator, release its lease when possible, and move
  to a state requiring human attention.
- **REQ-EXEC-11 (R1):** Losing the task lease MUST prevent completion,
  publication, or a successful status transition based on the lost claim.
- **REQ-EXEC-12 (R1):** Failure to post a completion audit comment MUST NOT undo
  an already confirmed move to `in-review`, but the reporting failure MUST be
  visible.
- **REQ-EXEC-13 (R1):** Failure to post a needs-human comment MUST NOT prevent a
  best-effort lease release and safe blocked state.
- **REQ-EXEC-14 (R1):** The runner MUST own lease renewal independently of
  worker responsiveness.
- **REQ-EXEC-15 (R1):** Two uncoordinated local runner processes MUST NOT use
  the same runner identity and execution capacity concurrently.
- **REQ-EXEC-16 (R1):** Runner execution budgets and lease timing MUST be
  validated so that limits are positive and heartbeat renewal occurs before
  lease expiry.

## Runner playbooks and multi-machine execution

- **REQ-PLAY-1 (Later):** Shared domain playbooks MUST replace flat capability
  matching without weakening atomic claims, canonical-order selection, worktree
  isolation, or runner-owned delivery.
- **REQ-PLAY-2 (Later):** A playbook MUST declare the classes of tasks,
  repositories, environments, and tools it can service.
- **REQ-PLAY-3 (Later):** A playbook MUST provide the domain-shared pickup,
  setup, validation, cleanup, worker context, reporting expectations, and
  default execution limits needed for its work.
- **REQ-PLAY-4 (Later):** Local machine settings MUST determine which installed
  playbooks are enabled and MUST supply machine-local paths, tools, credentials,
  terminal behavior, and capacity without placing those values in shared
  playbooks.
- **REQ-PLAY-5 (Later):** Runner advertisements MUST expose only sanitized
  playbook identities, capabilities, online state, and free capacity.
- **REQ-PLAY-6 (Later):** For each free slot, a runner MUST select the
  highest-ranked compatible task from the canonical Project order and MUST
  confirm its claim before launching a worker.
- **REQ-PLAY-7 (Later):** Global and playbook-specific limits MUST bound
  concurrent work.
- **REQ-PLAY-8 (Later):** Multiple tasks MAY run concurrently against the same
  repository only when they use distinct branches, worktrees, leases, state, and
  worker sessions.
- **REQ-PLAY-9 (Later):** A machine that lacks a compatible enabled playbook or
  free slot MUST NOT claim the task.
- **REQ-PLAY-10 (Later):** Migration to playbooks MUST provide a compatibility
  path for domains using the first-release runner profile.

## Versioned execution reporting

- **REQ-REP-1 (R1):** Existing structured needs-human, answer, resolution, and
  runner-result records MUST remain readable during the first release.
- **REQ-REP-2 (R1):** Malformed structured records MUST produce a visible error
  and MUST NOT be silently treated as valid attention or completion state.
- **REQ-REP-3 (Later):** Runner and worker reporting MUST use versioned records
  for `claimed`, `started`, `heartbeat`, `progress`, `needs-human`, `completed`,
  and `failed`.
- **REQ-REP-4 (Later):** Reporting records MUST identify the task, reporting
  actor, time, state, and relevant result or attention details.
- **REQ-REP-5 (Later):** The Project item and Issue MUST expose current status,
  claimant, sanitized machine or terminal locator, optional local URL,
  unresolved questions, result summary, and pull-request links when applicable.
- **REQ-REP-6 (Later):** Unknown reporting versions MUST be rejected or safely
  ignored without corrupting the task lifecycle.
- **REQ-REP-7 (Later):** Duplicate delivery of an unchanged reporting record
  MUST NOT create duplicate lifecycle transitions or duplicate user attention.

## Privacy and security

- **REQ-SEC-1 (R1):** The public PAN repository MUST contain only reusable
  behavior, schemas, protocols, and generic documentation.
- **REQ-SEC-2 (R1):** User workstream content, live Issues, credentials, local
  paths, runner state, leases, and machine configuration MUST remain outside the
  public repository.
- **REQ-SEC-3 (R1):** PAN MUST use only credentials and permissions explicitly
  provided to its runtime and MUST report insufficient access.
- **REQ-SEC-4 (R1):** Worker sessions MUST NOT receive GitHub tokens, SSH agent
  access, or equivalent delivery credentials that are unnecessary for task
  execution.
- **REQ-SEC-5 (R1):** User-specific paths, credentials, and unsanitized machine
  configuration MUST NOT be written to target repositories, Issues, Project
  fields, comments, or runner advertisements.
- **REQ-SEC-6 (R1):** PAN MUST constrain domain file access so a workstream or
  task reference cannot read outside its configured roots.
- **REQ-SEC-7 (R1):** Autonomous workers MUST NOT bypass repository review,
  branch protection, or pull-request policy.

## Reliability and auditability

- **REQ-REL-1 (R1):** Material PAN mutations MUST be attributable to a PAN turn
  and inspectable through durable domain records.
- **REQ-REL-2 (R1):** PAN MUST record enough information to distinguish its own
  ordering and lifecycle changes from subsequent user or runner changes.
- **REQ-REL-3 (R1):** Retries MUST be safe against duplicate Issue creation,
  duplicate comments, duplicate pull requests, duplicate task launches, and
  repeated lifecycle transitions.
- **REQ-REL-4 (R1):** A failure after an external side effect MUST be reported
  with the confirmed side effects and remaining incomplete steps.
- **REQ-REL-5 (R1):** PAN MUST provide actionable diagnostics for inaccessible
  GitHub state, malformed workstream content, missing workstreams, invalid
  runner data, conflicting leases, and agent action validation failures.
- **REQ-REL-6 (R1):** PAN MUST continue to provide attention and store
  operations when portfolio reasoning is unavailable, unless doing so would
  violate current domain safety constraints.
- **REQ-REL-7 (R1):** First-release behavior MUST remain compatible with Node.js
  22 or newer and MUST preserve the package's no-runtime-dependency constraint
  unless that constraint is explicitly revised.

## Out of scope

The following are outside the first reasoning-focused release unless explicitly
promoted by a later approved requirement:

- Cross-domain reasoning, automatic federation, or a global queue spanning
  multiple domain repositories.
- A second queue, shadow priority list, or conversation-only task database.
- Pushing work to a specifically named machine instead of pull-based matching.
- An idle worker-agent session for every repository or playbook.
- Autonomous pushes to a default branch, force-pushes, merges, or bypass of
  repository review policy.
- Silent deletion of Issues because their source narrative changed.
- Replacement of GitHub Issues, Projects, and workstream markdown with a new
  system of record.
- A new graphical user interface; GitHub and conversational/CLI surfaces remain
  sufficient for R1.
- Mandatory second-agent review of portfolio decisions; this may be introduced
  later for configured higher-risk domains.
- The playbook migration and complete versioned runner-reporting protocol, except
  for preserving current runner compatibility and defining their later
  requirements above.

## Acceptance criteria summary

| Capability | Stage | Acceptance summary | Requirements |
| --- | --- | --- | --- |
| One bounded domain | R1 | A configured instance reads and mutates only one domain and rejects invalid configuration. | REQ-DOM-1–7 |
| Canonical GitHub state | R1 | Issues, Project fields, and Project ordering remain the only durable task and queue truth. | REQ-DATA-1–12 |
| Trusted PAN advisor | R1 | Autonomous and interactive turns make clear, evidence-backed recommendations with explicit uncertainty. | REQ-ADV-1–7 |
| Complete portfolio reasoning | R1 | A review considers the complete actionable portfolio and fails closed if complete enumeration is impossible. | REQ-REA-1–11 |
| Manual-order preservation | R1 | PAN updates the Project directly while retaining user-established relative precedence and explaining exceptions. | REQ-ORD-1–9 |
| Inferred commitments | R1 | A sourced, high-confidence commitment creates one non-duplicate Issue; ambiguous or rejected work is not recreated. | REQ-INF-1–9 |
| Safe runtime | R1 | One leader schedules bounded reviews, survives transient failures, and stops mutating after leadership loss. | REQ-RUN-1–11 |
| Validated actions | R1 | Mutations obey authority, schema, lifecycle, lease, and concurrency policy and expose partial failures. | REQ-ACT-1–10 |
| Conversation and attention | R1 | Users inspect and change the same queue, answer durable questions, and retain existing inbox/add behavior. | REQ-CONV-1–13 |
| Shared store and leases | R1 | PAN and runners preserve validated fields and confirmed optimistic lease ownership. | REQ-STORE-1–9 |
| Existing runner delivery | R1 | Compatible work is claimed in canonical order, executed in isolation, and handed off by pull request without default-branch mutation. | REQ-EXEC-1–16 |
| Playbook migration | Later | Shared playbooks and private machine settings enable sanitized, capacity-aware multi-machine matching. | REQ-PLAY-1–10 |
| Versioned reporting | R1 / Later | Current records remain readable in R1 and migrate to an idempotent versioned protocol later. | REQ-REP-1–7 |
| Privacy and security | R1 | Private domain and machine data stay private, workers lack delivery credentials, and review controls remain enforced. | REQ-SEC-1–7 |
| Reliability and audit | R1 | Retries are idempotent, mutations are attributable, and incomplete effects are diagnosable. | REQ-REL-1–7 |

## Unresolved product decisions

These decisions affect requirement policy or externally visible behavior and
must be resolved before their dependent implementation is considered complete:

1. The exact authority matrix for automatic PAN changes versus changes requiring
   explanation or explicit approval.
2. The confidence policy for automatic inferred-Issue creation and semantic
   duplicate suppression.
3. The durable Project representation for decision rationale, last review time,
   and manual-precedence detection.
4. The conversation transcript retention period, storage boundary, and user
   controls.
5. Default polling, full-review, notification, heartbeat, and retry cadences.
6. Whether configured higher-risk domains require an independent review agent
   before portfolio mutations.
7. The later playbook, local machine-setting, runner-advertisement, and versioned
   reporting schemas.
