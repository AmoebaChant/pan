# Hostless PAN - Implementation Plan

## Summary

Replace PAN's resident host and MCP bridge with one foreground, domain-rooted Copilot CLI session plus short-lived deterministic `pan` helper commands. The implementation preserves complete GitHub-backed evidence, single-writer safety, attention and runner behavior, while adding direct workstream commits, user-scoped PAN assets, and native session scheduling.

## Phases

- **Phase 1: Stateless contracts and configuration** — define versioned configuration, command results, and leadership operations that every later helper can load independently.
- **Phase 2: Complete evidence and reconciliation** — build a complete Issue/Project snapshot and deterministic maintenance commands before model-selected mutations are allowed.
- **Phase 3: Safe mutations and workstream delivery** — move action application behind leadership-aware optimistic helpers and add conflict-safe direct workstream publishing.
- **Phase 4: User-scoped PAN session** — distribute reusable PAN assets and launch one foreground Copilot session with leadership and native schedule instructions.
- **Phase 5: Compatibility and retirement** — preserve runner policy, migrate commands, remove host/MCP runtime code, and update package documentation.
- **Phase 6: System validation and cleanup** — prove independent-process, session, git-delivery, and end-to-end acceptance behavior before deleting final compatibility residue.

## Phase Rationale

Configuration, result envelopes, and leadership assertions come first because every short-lived helper must share those contracts without a service container. Complete evidence and deterministic reconciliation precede mutation so action helpers can fail closed against stable expected state. Workstream delivery is implemented before session launch so the ordinary Pan agent has all required mutation mechanics on day one. User-scoped distribution and launcher supervision then compose those helpers into the hostless experience. Host-oriented commands and files are retired only after replacement workflows and runner compatibility exist, and final system tests gate the last cleanup.

## Task Index

| File | Task | Phase | Requirements |
| --- | --- | --- | --- |
| `01_01_domain_config_v2_migration.md` | Add version 2 domain/session configuration and migration | 1 | REQ-DOM-1–4, REQ-SCH-6–8, REQ-MIG-1–3 |
| `01_02_stateless_command_envelope.md` | Define the common helper command/result contract | 1 | REQ-TOOL-2–4, REQ-REL-1–5, REQ-MIG-4–5 |
| `01_03_leadership_helper_commands.md` | Expose durable leadership as stateless commands | 1 | REQ-LEAD-1–12, REQ-TOOL-7, REQ-MIG-8–10 |
| `02_01_complete_issue_catalog.md` | Enumerate complete open/closed Issue evidence | 2 | REQ-EVD-1, REQ-EVD-4–6, REQ-EVD-8, REQ-EVD-10–11 |
| `02_02_complete_evidence_snapshot_v2.md` | Build snapshot version 2 with source completeness | 2 | REQ-EVD-7–16, REQ-PORT-1–4, REQ-RUN-11 |
| `02_03_missing_issue_reconciliation.md` | Reconcile open Issues missing from the Project | 2 | REQ-REC-1–7, REQ-SAFE-3, REQ-SAFE-11–15 |
| `02_04_merged_pr_reconciliation_receipts.md` | Make merged-PR reconciliation explicit and recoverable | 2 | REQ-REC-8–9, REQ-ATTN-9, REQ-REL-2–5 |
| `02_05_attention_and_task_cli.md` | Expose attention, answer, and task-addition helpers | 2 | REQ-ATTN-1–10, REQ-MIG-5–6, REQ-REL-6 |
| `03_01_action_contract_expected_state.md` | Extend action schema for optimistic resource checks and groups | 3 | REQ-SAFE-1, REQ-SAFE-11–15, REQ-TOOL-3–4, REQ-MIG-4–5 |
| `03_02_leadership_aware_action_apply.md` | Implement stateless action validate/apply commands | 3 | REQ-PORT-5–10, REQ-LEAD-6–8, REQ-SAFE-1–15 |
| `03_03_issue_creation_recovery.md` | Preserve and recover sourced Issue creation effects | 3 | REQ-REC-10–15, REQ-EVD-4–6, REQ-REL-3–5 |
| `03_04_workstream_prepare.md` | Prepare isolated workstream edit operations | 3 | REQ-WS-1–6, REQ-WS-9–10, REQ-DOM-5–7 |
| `03_05_workstream_publish.md` | Commit and push workstream updates directly | 3 | REQ-WS-7–16, REQ-LEAD-6–7, REQ-REL-1–5 |
| `04_01_user_scoped_pan_assets.md` | Create the hostless Pan agent, instructions, and skills bundle | 4 | REQ-EXP-3, REQ-EXP-5–7, REQ-TOOL-5–8, REQ-REL-7–9 |
| `04_02_asset_install_status_repair.md` | Install and verify PAN assets at user scope | 4 | REQ-EXP-4–7, REQ-DOM-4, REQ-REL-7–9 |
| `04_03_hostless_session_launch.md` | Launch Copilot in the validated domain root | 4 | REQ-EXP-1–4, REQ-DOM-1–10, REQ-MIG-11 |
| `04_04_session_leadership_supervision.md` | Supervise writer/read-only session lifetime | 4 | REQ-LEAD-1–12, REQ-EXP-8–9, REQ-REL-2–4 |
| `04_05_native_schedule_bootstrap.md` | Configure native, session-scoped review scheduling | 4 | REQ-SCH-1–12, REQ-EXP-5, REQ-EVD-13 |
| `05_01_runner_delivery_policy.md` | Lock runner PR defaults and explicit direct mode | 5 | REQ-RUN-1–13, REQ-MIG-3, REQ-MIG-12 |
| `05_02_host_command_migration.md` | Redirect or retire host-era commands with guidance | 5 | REQ-MIG-1–10, REQ-EXP-9, REQ-REL-6 |
| `05_03_remove_host_mcp_runtime.md` | Remove PanHost, MCP, timers, and prompt-process runtime | 5 | REQ-EXP-2–4, REQ-TOOL-8, REQ-MIG-7–10 |
| `05_04_hostless_documentation_and_package.md` | Update docs, schemas, exports, and package contents | 5 | REQ-TOOL-3, REQ-SCH-6, REQ-MIG-1–12, REQ-REL-7–9 |
| `06_01_stateless_helper_process_tests.md` | Test helpers as independent CLI processes | 6 | REQ-TOOL-2–8, REQ-EVD-10–16, REQ-SAFE-11–15 |
| `06_02_session_contract_integration_tests.md` | Test launch, contention, leadership loss, and scheduling | 6 | REQ-EXP-1–9, REQ-SCH-1–12, REQ-LEAD-1–12 |
| `06_03_workstream_delivery_integration_tests.md` | Test isolated direct git delivery and recovery | 6 | REQ-WS-3–16, REQ-REL-1–5 |
| `06_04_final_e2e_cleanup.md` | Run acceptance scenarios and remove remaining legacy residue | 6 | REQ-REC-1–15, REQ-ATTN-1–10, REQ-RUN-1–13, REQ-MIG-1–12 |
