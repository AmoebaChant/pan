# Task 6.1: Shared Playbook Schema

## Goal

Define and load generic shared playbooks from the private domain repository, describing task matching, worker context, setup/validation/cleanup, reporting, and default execution limits without machine-local values.

## Requirements addressed

REQ-PLAY-1–3, REQ-SEC-1–2

## Background

The current runner profile contains flat capabilities and repository configuration. Architecture requires shared domain playbooks plus private local settings. Existing `LocalTaskExecutor` and `task-worker.js` reveal the execution information a playbook must supply, but playbooks must not contain clone paths, credentials, terminal windows, or live capacity.

## Files to modify/create

- `schema/playbook.json` — versioned shared playbook schema.
- `src/playbook.js` — `loadPlaybooks()` and validators.
- `test/playbook.test.js` — valid matching, defaults, duplicate IDs, invalid limits, and machine-private fields.
- `docs/playbooks.md` — generic format and repository location.
- `src/index.js` — exports.

## Implementation details

1. Define stable ID/version, task capability match rules, supported repository identities/patterns, required environment/tools, worker agent/skills/context, pickup/setup/validation/cleanup instructions, reporting version, and default budgets.
2. Keep matching exact and explainable; reuse newline-delimited task requirements and `repo:<owner/name>` semantics during migration.
3. Reject absolute paths, credentials, terminal locators, machine names, state directories, and free-capacity values.
4. Load all configured playbook files deterministically and fail visibly on duplicate IDs or malformed enabled playbooks.
5. Validate positive budgets and reporting versions without adding runtime dependencies.
6. Document playbooks as private domain content, not files committed to this public repository beyond schema/examples with generic placeholders.

## Testing suggestions

- `node --test test/playbook.test.js`
- Include a generic fixture that contains no real repository or local path.
- `npm test`

## Gotchas

- A playbook describes shared execution knowledge, not one machine installation.
- Do not weaken current claim/worktree/delivery constraints.
- Avoid executable arbitrary shell blobs without explicit runner policy.

## Verification checklist

- [ ] Playbooks express matching and worker/reporting context.
- [ ] Machine-private values are rejected.
- [ ] Loading is deterministic and actionable on errors.
- [ ] Targeted tests and `npm test` pass.
