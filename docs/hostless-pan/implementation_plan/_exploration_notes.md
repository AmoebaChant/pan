# Hostless PAN exploration notes

## Current entry points and process topology

- `bin/pan.js` delegates all user commands to `runPanCli()` in `src/pan-cli.js`.
- `src/pan-cli.js:38-313` is the composition root. It currently creates `PanStore`, `AttentionService`, `PanReviewService`, `PanRuntime`, `PanHost`, and the launcher paths in one command dispatcher.
- `src/pan-cli.js:346-513` parses the host-era commands `start`, `stop`, `host`, `connect`, `daemon`, `review`, `chat`, `inbox`, `answer`, and `add`. `src/pan-cli.js:825-839` owns their help text.
- `src/pan-launcher.js:29-190` currently starts/discovers a detached host, writes an MCP config, opens Copilot in the PAN product checkout, or connects to an existing localhost endpoint.
- `src/pan-launcher.js:283-313` builds Copilot arguments around the PAN MCP tools. Hostless launch must instead use the configured domain root, explicit user-scoped agent selection, ordinary built-in capabilities, and no MCP config.
- `src/pan-host.js`, `src/pan-mcp-server.js`, `bin/pan-mcp.js`, `src/pan-agent-client.js`, `src/pan-runtime.js`, and `src/pan-daemon.js` contain resident host, bridge, separate prompt-process, timer, or legacy daemon responsibilities selected for removal after equivalent short-lived commands exist.

## Configuration and leadership

- `src/domain-config.js:61-163` loads and validates only version 1. `src/domain-config.js:182-275` normalizes host-era cadence names. `schema/domain-config.json` mirrors that shape.
- Version 2 must retain domain, Project, state, agent, attention, leadership, review, and self-repair data while adding `session`, `scheduling`, product-context roots, and explicit action policy. Version 1 must normalize in memory with migration diagnostics.
- `src/pan-setup.js:274-295` creates version 1 configuration; setup output and docs must move to version 2 without coupling runner settings to session settings.
- `GitHubStateFile` and `LeaderLease` in `src/leader-lease.js:8-258` already provide expected-version writes, token confirmation, expiry, heartbeat, release, and same-machine dead-process recovery. Preserve the record compatibility and expose these primitives through stateless CLI commands.
- Existing tests in `test/leader-lease.test.js` cover contention, renewal, loss, release, local recovery, and remote protection. Extend them rather than replacing the lease model.

## Store, complete evidence, and reconciliation

- `PanStore` in `src/pan-store.js:152-1262` is the deterministic GitHub adapter.
- `readCanonicalProject()` at `src/pan-store.js:442-450` completely paginates Project items through `#readProjectConnection()` at `src/pan-store.js:1062-1133`.
- `normalizeGraphQlItem()` at `src/pan-store.js:1264-1342` currently rejects non-Issue Project content and requires nested connections to fit fixed first-page limits. Hostless evidence needs explicit classification and source diagnostics rather than treating every unsupported Project item as an ordinary Issue.
- `syncOpenIssues()` at `src/pan-store.js:452-489` uses `gh issue list --limit 1000`, reads only open Issues, and does not prove completeness or exclude pull requests through an explicit contract. Replace it with a complete open/closed Issue catalog and deterministic reconciliation.
- `createItem()` at `src/pan-store.js:203-268` deletes the Issue when Project setup fails. Hostless recovery must preserve the Issue identity and report remaining steps so retry cannot create a duplicate.
- `reconcileMergedPullRequests()` and `completeMergedPullRequest()` at `src/pan-store.js:372-440` preserve the required merge check, but rollback-oriented errors need structured confirmed/remaining-effect receipts.
- `PortfolioSnapshotBuilder.build()` in `src/portfolio-snapshot.js:50-139` combines Project, workstreams, and runner availability into version 1. Snapshot version 2 must add the complete Issue catalog, reconciliation state, per-source completeness, and resource-specific expected revisions.
- `test/pan-store.test.js` already covers complete Project pagination, nested-evidence refusal, stable IDs, safety limits, task leases, attention transitions, and merged-PR completion. `test/portfolio-snapshot.test.js` is the existing snapshot test home.

## Actions and mutation safety

- `schema/pan-action.json` and `src/pan-protocol.js:51-87` define version 1 actions with one snapshot ID and action-specific targets.
- `ActionPolicy` in `src/action-policy.js:17-81` classifies proposal/live authority and `lifecycleViolations()` at `src/action-policy.js:83-205` protects active leases, protected statuses, blocks, and complete reorder membership.
- `PanReviewService.applyActions()` and `#apply()` in `src/pan-review-service.js:141-294` currently own live validation and application in memory. `#applyAction()` at `src/pan-review-service.js:296-435` directly changes fields/order, creates Issues, adds comments, and requests attention.
- Hostless action validation/application must become a short-lived command that reloads config and evidence, validates the current leadership generation before every external step, checks resource-specific expected state, applies idempotently, confirms effects, and emits the common result envelope.
- Preserve the existing tests in `test/action-policy.test.js`, `test/pan-protocol.test.js`, and `test/pan-review-service.test.js` as behavior references while moving command-process coverage to new integration tests.

## Workstreams and git delivery

- `WorkstreamStore` in `src/workstream-store.js:17-198` already lists, reads, searches, and reads git history with path and symlink confinement.
- `resolveWorkstreamReadme()` and `resolveConfinedWorkstreamReadme()` at `src/workstream-store.js:200-235` are the path-safety primitives to reuse.
- No write path exists. Add a separate delivery component that prepares a detached isolated worktree from a freshly fetched remote default branch and later validates an allowlisted workstream-only diff, revalidates leadership/base/blob state, commits with PAN attribution, pushes non-force to the default branch, confirms the remote, detects retry markers, and cleans up safely.
- `test/workstream-store.test.js` is the read/confinement test home. New git integration tests should use disposable local bare remotes and prove the user's dirty checkout is unchanged.

## Attention and runner behavior

- `AttentionService` in `src/attention-service.js:21-173` already implements inbox, answer, and Issue-backed add behavior. Preserve its JSON shapes while exposing the hostless `pan attention ...` command family and compatibility aliases.
- Merged-PR completion remains in `PanStore`; missing-Issue registration and merged-PR repair should be explicit `pan reconcile ...` operations with receipts.
- `normalizePlaybooks()` and `validatePlaybook()` in `src/playbook.js:3-98` already default omitted delivery to `pull-request` and accept explicit `direct`.
- `LocalTaskExecutor` validates reported PR or direct delivery, while `RunnerDaemon` moves direct delivery to `done` and PR delivery to `in-review`. Preserve this behavior and add migration/acceptance coverage for legacy playbooks and PAN's explicit direct playbook.

## Agent and user-scoped distribution

- `.github/agents/pan.agent.md` is currently repository-scoped and forbids shell/filesystem/GitHub use except PAN MCP tools. It must be rewritten for ordinary built-in capabilities and documented helper commands.
- `test/pan-agent-definition.test.js` validates the current repository agent and named tool allowlist. Replace this with package-asset and installed-user-manifest validation.
- The package currently includes `.github/agents` in `package.json`, but no versioned user-scope installer, manifest, instructions bundle, or reusable hostless skills.
- Add a package-owned asset tree plus install/status/repair commands that use supported Copilot user directories, content hashes, conflict diagnostics, atomic replacement, and no private domain content.

## Session launch and native scheduling

- The new `pan session --config <path>` launcher should remain foreground, acquire leadership when possible, launch read-only when not, pass a session ID and leadership generation through the child environment, heartbeat while Copilot runs, terminate the child on leadership loss, release on exit, and return the child's exit code.
- The child `cwd` must be `config.domain.path`; local and GitHub repository identity plus Project schema must be preflighted.
- Native scheduling belongs to the Copilot session, not a Node timer. Package instructions/skills must tell the writing session how to establish the supported `/every` or `/after` schedule, apply startup policy once, run a session-local due check for long cadences, refresh evidence per turn, and create no schedule in read-only mode.
- `test/pan-launcher.test.js`, `test/pan-cli-integration.test.js`, and `test/copilot-invocation-contract.test.js` are the current launcher/CLI contract homes and should be rewritten around a fake Copilot child and no host/MCP artifacts.

## Documentation and validation

- The only project quality command is `npm test`, which runs `node --test test/*.test.js`.
- Primary docs needing hostless updates are `README.md`, `docs/domain-configuration.md`, `docs/runner.md`, `docs/triage-and-attention.md`, `docs/architecture.md`, and relevant schema/module docs.
- Final acceptance must prove no host, MCP, endpoint, token, detached scheduler, or shared in-memory service is required; concurrent sessions have one writer; helpers work as independent processes; complete evidence fails closed; workstream delivery is direct and conflict-safe; attention and runners retain behavior.
