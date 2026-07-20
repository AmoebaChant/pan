# Task 6.2: Local Runner Settings

## Goal

Add private machine-local runner settings that enable installed playbooks and supply paths, tools, credentials references, terminal behavior, and capacity, with a compatibility adapter for existing runner profiles.

## Requirements addressed

REQ-PLAY-4, REQ-PLAY-10, REQ-EXEC-4, REQ-SEC-5

## Background

`validateRunnerProfile()` currently validates machine identity, online state, flat capabilities, store config, repositories, worktree/state paths, terminal, Copilot, capacity, lease timing, and budgets. Task 6.1 separates shared playbook data. Domain configuration from Task 1.3 already owns the store identity, so new local settings must not duplicate it as the primary source.

## Files to modify/create

- `schema/runner-settings.json` — private local settings schema.
- `src/runner-settings.js` — loader/validator and legacy profile adapter.
- `test/runner-settings.test.js` — defaults, enabled playbooks, path/tool validation, capacity, lease timing, and adapter.
- `src/runner-profile.js` and `test/runner-profile.test.js` — deprecation-compatible delegation.
- `docs/runner.md` — migration instructions.
- `src/index.js` — exports.

## Implementation details

1. Define runner ID, online state, global capacity, enabled playbook IDs, per-playbook capacity/overrides, repository clone paths/default branches, workspace/state roots, terminal settings, Copilot executable/model, lease timing, and credential references.
2. Keep credential values out of serialized/public records; settings may name environment variables or local providers.
3. Validate global/per-playbook limits, unique repository paths, default branches, and heartbeat-before-expiry as current profile validation does.
4. Adapt a legacy profile into one synthetic compatibility playbook plus local settings without changing execution semantics.
5. Emit deprecation diagnostics but keep legacy `pan-runner --profile` working.
6. Ensure local settings are never written to domain Issues, Project fields, comments, or advertisements.

## Testing suggestions

- `node --test test/runner-settings.test.js test/runner-profile.test.js`
- Compare legacy adapter output to current runner defaults.
- `npm test`

## Gotchas

- Local settings are not shared domain files.
- Do not put domain repository credentials into worker context.
- Per-playbook and global capacity must both constrain execution.

## Verification checklist

- [ ] New settings can configure the existing executor without a runner profile.
- [ ] Legacy profiles adapt without behavior loss.
- [ ] Private values cannot enter sanitized outputs.
- [ ] Targeted tests and `npm test` pass.
