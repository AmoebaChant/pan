# Reasoning-first PAN exploration notes

## Project conventions

- The repository is dependency-free ESM for Node.js 22 (`package.json:5-24`).
- Tests use `node:test` with `node:assert/strict`; `npm test` runs the complete suite (`package.json:19-23`).
- No `.github/copilot-instructions.md` exists in this worktree. Repository guidance is in `README.md` and `CONTRIBUTING.md`.
- The public repository must not contain private domain content, credentials, machine paths, live leases, or runner state (`CONTRIBUTING.md:10-14`, `docs/store-schema.md:45-50`).

## Current walking skeleton

- `src/pan-store.js` contains `PanStore`, the shared GitHub Issues/Projects adapter. It validates `schema/project-fields.json`, creates Issue-backed Project items with rollback, enumerates Project items through bounded GraphQL pagination, reads comments, updates fields and ordering, synchronizes missing open Issues, and implements optimistic item leases.
- `src/pan-daemon.js` contains `PanDaemon`, the singleton rule-based triage loop. `tick()` synchronizes Issues, loads runner profiles, applies `deriveTriage()`, blocks unmatched agent work, and reorders with `compareBacklogItems()` (`src/pan-daemon.js:146-303`).
- `src/triage-policy.js` contains the transitional deterministic directive parser, requirement matching, and priority/status sort. `compareBacklogItems()` must not remain the canonical portfolio policy once reasoning is enabled (`src/triage-policy.js:87-105`).
- `src/leader-lease.js` contains `GitHubStateFile` and `LeaderLease`, reusable foundations for singleton runtime leadership and GitHub-backed operational audit state.
- `src/pan-cli.js` loads the runner profile for every PAN command, composes `PanStore`, `AttentionService`, and `PanDaemon`, and exposes `daemon`, `inbox`, `answer`, and `add`. This is the main integration point for separate domain configuration and new `review`/`chat` commands.
- `src/attention-service.js` preserves durable inbox, answer, and add behavior over the store. `answer()` records a marked comment and returns blocked or needs-detail work to reconsideration (`src/attention-service.js:47-65`).
- `src/needs-human.js` defines current marked comment records for needs-human, answers, resolutions, and runner results. New versioned reporting must remain able to read these records.
- `src/runner-profile.js` and `schema/runner-profile.json` mix domain store configuration with machine-local execution settings. They are the compatibility source to split, not a pattern to preserve unchanged.
- `src/runner-daemon.js` pulls `owner=agent`, `Status=ready`, claimable work, then sorts it again by priority and Issue number (`src/runner-daemon.js:64-119`, `src/runner-daemon.js:321-325`). The new runner must preserve the order returned by `PanStore`.
- `src/local-task-executor.js` already creates unique branches/worktrees, verifies repository identity, launches a headed session, and owns push/PR handoff. `resolveWorkstreamReadme()` is the existing path-confinement implementation to extract/reuse (`src/local-task-executor.js:440-465`).
- `src/task-worker.js` currently invokes Copilot CLI in autonomous mode with broad tool enablement plus explicit shell denials (`src/task-worker.js:102-129`). Its argument construction and result-file convention are relevant to the required invocation spike.
- `src/runner-lock.js` prevents two processes from sharing one runner identity and state capacity.
- `src/polling.js` provides bounded idle backoff, rate-limit detection, and abortable waits.
- `src/process-client.js` is the reusable subprocess wrapper with timeout and output limits.
- `src/index.js` is the package export surface and must be updated as new reusable modules are introduced.

## Store and schema integration points

- `schema/project-fields.json` currently requires owner, Status, priority, requirements, autonomy, lease-until, claimed-by, and workstream. The reasoning release needs durable rationale and review-time fields added here and documented in `docs/store-schema.md`.
- `PanStore.#listItems()` preserves the GraphQL Project connection order, so returned array order can be the canonical queue.
- `PROJECT_ITEM_SELECTION` currently omits Issue `updatedAt`, comment metadata, and Project item update/version metadata. Portfolio snapshot work must add enough evidence and concurrency tokens without silently truncating data.
- `PanStore.reorderItems()` performs sequential `updateProjectV2ItemPosition` mutations but does not preflight current order or confirm the result. Add a validated compare/read/apply/confirm path rather than weakening existing lease methods.
- `PanStore.syncOpenIssues()` already detects open Issues absent from the Project without creating duplicate Issues.
- `PanStore.createItem()` attempts rollback after partial creation. Inferred-task retry recovery should build on it while retaining the source fingerprint in the Issue body so an already-created Issue can be rediscovered.

## Test patterns and fixtures

- `test/pan-store.test.js` uses a stateful `FakeGh` to exercise GraphQL reads, Project edits, Issue creation rollback, comments, synchronization, ordering, and leases. Extend this fixture for Project order confirmation, rationale fields, Issue history, and inferred-task recovery.
- `test/pan-daemon.test.js` uses a small `FakeStore` and direct `tick()` calls. Preserve these tests while moving deterministic triage behind compatibility mode; add focused runtime tests rather than converting every existing test at once.
- `test/runner-daemon.test.js` uses `FakeStore`, `FakeExecutor`, and `FakeHandle` to verify claim, heartbeat, result, and failure behavior. Add canonical-order, playbook matching, reporting, and concurrency cases here or in narrowly named sibling test files.
- `test/pan-cli.test.js` tests pure argument parsing. Add domain-config, `review --dry-run`, and `chat` parsing here; test command composition with injected agent/store factories in a separate `pan-cli-integration.test.js`.
- `test/attention-service.test.js` covers existing inbox/add/answer compatibility and should remain unchanged except for additional durable conversation-action cases.
- `test/runner-profile.test.js` covers inferred store paths and runner defaults. Retain it as the legacy-profile compatibility suite while adding `domain-config.test.js`, `playbook.test.js`, and `runner-settings.test.js`.
- Use targeted commands such as `node --test test/domain-config.test.js test/pan-cli.test.js` while implementing; every task also ends with `npm test`.

## Planned module boundaries

- `src/domain-config.js` + `schema/domain-config.json`: one-domain runtime configuration, independent of runner settings.
- `.github/agents/pan.agent.md`: generic PAN identity, standards, authority framing, and constrained tool names with no private values.
- `src/pan-agent-client.js`: Copilot CLI invocation selected by the first spike, supporting autonomous and interactive turns through one protocol.
- `src/pan-protocol.js` + schemas: versioned turn request, tool request/result, proposed action, and final response records.
- `src/workstream-store.js`: confined workstream enumeration/read/search plus relevant git history.
- `src/portfolio-snapshot.js`: complete, fail-closed dossiers over every Project item, comments, workstreams, leases, time, and runner advertisements.
- `src/pan-tools.js`: explicit domain-scoped read and mutation operations; no general shell or unrestricted filesystem access.
- `src/action-policy.js`: schema, authority, lifecycle, lease, domain, and concurrency validation.
- `src/order-audit.js` and `src/order-policy.js`: GitHub-backed last-applied audit, conservative manual relative-precedence constraints, stable ordering validation, and urgent insertion support.
- `src/commitment-index.js`: source fingerprints, duplicate/suppression records, and inferred-task recovery.
- `src/pan-runtime.js`: event coalescing, scheduled reviews, leader enforcement, retries, and shutdown; `PanDaemon` remains a compatibility wrapper until retirement.
- `src/conversation-service.js`: interactive turns over the same snapshot/actions, with durable outcomes promoted to GitHub state.
- `src/playbook.js`, `src/runner-settings.js`, `src/runner-advertisement.js`, and `src/reporting.js`: later runner model and compatibility adapters.

## Safe defaults for unresolved parameters

- Resolve exact Copilot CLI autonomous, interactive, custom-agent, and tool-channel mechanics through the first implementation spike. If no native structured tool channel is usable, use newline-delimited JSON over stdio for the runtime process boundary and keep the agent limited to the PAN operation registry.
- Store concise per-item rationale in a required Project text field `pan-rationale` and the last accepted portfolio review time in `pan-reviewed-at`. Store operational order audit on the existing `pan-state` branch, never as a second queue.
- Treat an externally changed Project order conservatively: persist adjacent relative-precedence constraints from the observed order. New urgent items may be inserted without reversing constrained pairs; explicit chat directives may replace selected constraints.
- Default autonomous inferred-Issue creation to structured candidates marked high confidence by PAN, with a stable source fingerprint and no exact, source, resolved, or high-similarity duplicate. Ambiguous candidates become needs-human questions.
- Keep transcripts local and ephemeral by default, with a configurable retention count of zero; durable decisions must be written to Issues, Project fields/comments, or approved workstream tools.
- Preserve current polling defaults initially (30-second active poll, bounded five-minute idle poll, fifteen-minute rate-limit delay), then expose separate configured full-review, heartbeat, notification, and retry cadences.
