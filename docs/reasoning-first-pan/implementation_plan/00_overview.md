# Reasoning-first PAN - Implementation Plan

## Summary

Evolve the current rule-based walking skeleton into a generic Pan agent and runtime that reasons over one complete GitHub-backed portfolio, safely updates the canonical Project order, creates sourced inferred work, and supports conversation. Preserve the existing store, attention, lease, and isolated runner behavior while incrementally migrating runner profiles to playbooks, local settings, sanitized advertisements, parallel execution, and versioned reporting.

## Phases

- **Phase 1: Copilot invocation and bounded configuration** — resolve the Copilot CLI integration first, define the generic Pan identity/protocol, and separate one-domain runtime configuration from machine runner configuration.
- **Phase 2: Complete evidence and constrained tools** — extend the store and domain readers so every reasoning turn receives a fail-closed complete portfolio snapshot through an explicit operation registry.
- **Phase 3: Reasoning and canonical ordering** — add dry-run reasoning, durable rationale, concurrency-safe Project ordering, manual relative-precedence preservation, and live validated application.
- **Phase 4: Inferred commitments** — identify sourced commitments, prevent duplicates and recreation, and recover safely from partial Issue/Project creation.
- **Phase 5: PAN runtime and conversation** — schedule/coalesce autonomous turns under the leader lease and expose interactive chat over the same agent, snapshot, actions, and durable attention state.
- **Phase 6: Playbook runner evolution** — separate shared playbooks from local settings, advertise sanitized capacity, introduce versioned reporting, and select/execute canonical-order work in parallel isolated worktrees.
- **Phase 7: Dogfood and compatibility retirement** — prove end-to-end behavior with deterministic tests and one real domain, then remove transitional policy only after compatibility gates pass.

## Phase Rationale

The Copilot CLI spike is first because autonomous turns, interactive turns, custom-agent selection, and tool transport shape every later runtime boundary. Configuration and protocol follow so subsequent slices remain generic and testable. Complete fail-closed evidence and constrained operations are established before any model-produced mutation is accepted. Dry-run reasoning then validates agent quality without changing GitHub; ordering, rationale, manual constraints, and inferred work are layered behind deterministic validators. Runtime and chat reuse those same paths. Runner migration is later because the R1 reasoning loop can preserve the existing runner, while playbooks/reporting/parallelism build on canonical ordering. Final dogfood and retirement occur only after both new and compatibility paths are exercised.

## Task Index

| File | Task | Phase | Requirements |
| --- | --- | --- | --- |
| `01_01_copilot_cli_invocation_spike.md` | Spike autonomous, interactive, custom-agent, and tool-channel invocation | 1 | REQ-ADV-1, REQ-CONV-1, REQ-ACT-1, REQ-REL-5 |
| `01_02_pan_turn_protocol.md` | Define versioned PAN turn and action protocol | 1 | REQ-ADV-3, REQ-REA-9, REQ-ACT-1–3, REQ-REL-1, REQ-REL-4 |
| `01_03_domain_configuration.md` | Add independent one-domain runtime configuration | 1 | REQ-DOM-1–7, REQ-SEC-2–3, REQ-REL-5 |
| `01_04_generic_pan_agent.md` | Add the reusable Pan custom-agent definition | 1 | REQ-DOM-2–3, REQ-ADV-1–7, REQ-SEC-1 |
| `01_05_pan_agent_client.md` | Implement the Copilot CLI Pan agent process client | 1 | REQ-ADV-1, REQ-RUN-11, REQ-ACT-1, REQ-REL-4–5 |
| `01_06_cli_configuration_split.md` | Compose PAN commands from domain config without runner config | 1 | REQ-DOM-4–6, REQ-CONV-5–11, REQ-REL-6 |
| `02_01_complete_project_read_model.md` | Extend Project reads with complete ordered evidence | 2 | REQ-DATA-2–4, REQ-DATA-11, REQ-REA-1–3, REQ-STORE-9 |
| `02_02_confined_workstream_store.md` | Add confined workstream hierarchy and git-history reads | 2 | REQ-DOM-7, REQ-DATA-5, REQ-REA-3–4, REQ-SEC-6 |
| `02_03_runner_availability_snapshot.md` | Normalize runner availability without machine-private leakage | 2 | REQ-REA-6, REQ-SEC-5, REQ-EXEC-3–4 |
| `02_04_complete_portfolio_snapshot.md` | Build complete fail-closed task dossiers | 2 | REQ-REA-1–10, REQ-DATA-11, REQ-REL-5 |
| `02_05_constrained_pan_tools.md` | Implement the domain-scoped PAN operation registry | 2 | REQ-ACT-1–4, REQ-DOM-2, REQ-SEC-3, REQ-SEC-6 |
| `03_01_reasoning_dry_run_service.md` | Run deterministic, non-mutating portfolio reasoning | 3 | REQ-ADV-2–6, REQ-REA-1–11, REQ-RUN-11 |
| `03_02_review_dry_run_cli.md` | Expose review dry-run and machine-readable output | 3 | REQ-ADV-5, REQ-CONV-11, REQ-REL-5–6 |
| `03_03_rationale_and_review_fields.md` | Add durable Project rationale and review-time fields | 3 | REQ-DATA-10, REQ-ORD-7, REQ-REL-1–2 |
| `03_04_validated_project_ordering.md` | Validate, apply, and confirm canonical ordering | 3 | REQ-ORD-1–3, REQ-ORD-9, REQ-ACT-2–8, REQ-STORE-9 |
| `03_05_manual_relative_constraints.md` | Detect and preserve manual drag precedence | 3 | REQ-ORD-4–8, REQ-REL-2 |
| `03_06_live_reasoning_application.md` | Apply accepted reasoning actions through policy | 3 | REQ-REA-9–11, REQ-ORD-1–9, REQ-ACT-1–10 |
| `04_01_commitment_candidates.md` | Represent sourced inferred commitment candidates | 4 | REQ-REA-4, REQ-INF-1, REQ-INF-3–5 |
| `04_02_commitment_dedup_and_suppression.md` | Prevent semantic/source duplicates and recreation | 4 | REQ-INF-2, REQ-INF-5–7, REQ-REL-3 |
| `04_03_inferred_issue_creation.md` | Create and recover sourced inferred Project work | 4 | REQ-DATA-1–2, REQ-DATA-12, REQ-INF-3–9, REQ-REL-4 |
| `05_01_runtime_event_scheduling.md` | Detect/coalesce domain changes and time boundaries | 5 | REQ-RUN-1–3, REQ-RUN-7–9 |
| `05_02_pan_runtime_leadership.md` | Run scheduled reasoning safely under leadership | 5 | REQ-RUN-3–6, REQ-RUN-9–11, REQ-REL-4–6 |
| `05_03_pan_chat_interface.md` | Add interactive chat through the same Pan agent | 5 | REQ-ADV-1, REQ-CONV-1–4, REQ-CONV-12 |
| `05_04_conversation_actions_and_attention.md` | Validate durable chat changes and preserve attention | 5 | REQ-ACT-9–10, REQ-CONV-2–13, REQ-REL-6 |
| `06_01_shared_playbook_schema.md` | Define and load shared domain playbooks | 6 | REQ-PLAY-1–3, REQ-SEC-1–2 |
| `06_02_local_runner_settings.md` | Add private local settings and legacy profile adapter | 6 | REQ-PLAY-4, REQ-PLAY-10, REQ-EXEC-4, REQ-SEC-5 |
| `06_03_sanitized_runner_advertisements.md` | Publish/read sanitized availability and capacity | 6 | REQ-PLAY-5, REQ-REA-6, REQ-SEC-5, REQ-REL-3 |
| `06_04_versioned_reporting_protocol.md` | Add compatible versioned execution records | 6 | REQ-REP-1–7, REQ-CONV-6, REQ-REL-3–4 |
| `06_05_canonical_playbook_runner_selection.md` | Select canonical-order work by playbook and capacity | 6 | REQ-ORD-3, REQ-EXEC-1–4, REQ-PLAY-6–7, REQ-PLAY-9 |
| `06_06_parallel_runner_worktrees.md` | Execute multiple tasks with isolated worktrees and reports | 6 | REQ-EXEC-5–16, REQ-PLAY-8, REQ-REP-3–5, REQ-SEC-4–7 |
| `07_01_reasoning_end_to_end_tests.md` | Add deterministic review/apply/chat/inference system tests | 7 | REQ-DOM-1–7, REQ-REA-1–11, REQ-ORD-1–9, REQ-INF-1–9, REQ-CONV-1–13 |
| `07_02_runner_end_to_end_tests.md` | Add playbook/reporting/parallel delivery system tests | 7 | REQ-EXEC-1–16, REQ-PLAY-1–10, REQ-REP-1–7 |
| `07_03_dogfood_and_compatibility_retirement.md` | Dogfood one domain and retire transitional paths | 7 | REQ-DATA-3, REQ-REA-11, REQ-PLAY-10, REQ-REL-6–7 |
