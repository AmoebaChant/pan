# Task 1.3: Domain Configuration

## Goal

Add a validated PAN runtime configuration that connects exactly one domain repository and Project without requiring machine runner execution settings.

## Requirements addressed

REQ-DOM-1–7, REQ-SEC-2–3, REQ-REL-5

## Background

The current `loadRunnerProfile()` in `src/runner-profile.js` combines store identity, domain clone path, machine capabilities, repositories, terminal, Copilot, capacity, and budgets. PAN commands load that profile in `src/pan-cli.js:21-29`. The reasoning runtime needs only one bounded domain plus runtime cadences, agent invocation, leadership, and transcript policy. Runner configuration must remain independently usable.

## Files to modify/create

- `schema/domain-config.json` — public schema for generic PAN domain/runtime settings.
- `src/domain-config.js` — `loadDomainConfig()` and `validateDomainConfig()`.
- `test/domain-config.test.js` — defaults, path confinement, invalid combinations, and actionable errors.
- `docs/domain-configuration.md` — generic example and migration from `store` in a runner profile.
- `src/index.js` — exports.

## Implementation details

1. Define required domain repository, Project owner/number, absolute local clone path, state branch/path, and PAN agent name.
2. Add bounded defaults for active poll, idle poll, full review, leader lease/heartbeat, notification, retry, and transcript retention. Preserve the current 30-second active, five-minute idle, and fifteen-minute rate-limit defaults where applicable.
3. Validate owner/name repository format, positive cadence relationships, absolute domain path, and state file paths that cannot escape the configured repository/state namespace.
4. Represent optional higher-risk review policy without enabling it by default.
5. Exclude runner repositories, worktree roots, credentials, terminal settings, capacity, and machine identifiers.
6. Produce path-specific errors and wrap unreadable/invalid JSON similarly to `loadRunnerProfile()` at `src/runner-profile.js:15-29`.

## Testing suggestions

- `node --test test/domain-config.test.js`
- Cover malformed JSON, missing Project fields, invalid cadence relationships, and unexpected runner-only fields.
- `npm test`

## Gotchas

- Do not silently infer the domain from a runner profile in the new loader.
- Do not store tokens or credential values in the config schema.
- A config file path may be anywhere; only the configured domain clone path determines workstream access.

## Verification checklist

- [ ] Domain config is sufficient to construct the store, leader state, runtime, and agent client.
- [ ] Runner-only settings are rejected or absent.
- [ ] Invalid configuration prevents mutation with actionable diagnostics.
- [ ] Targeted tests and `npm test` pass.
