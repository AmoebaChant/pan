# Task 1.6: CLI Configuration Split

## Goal

Make PAN attention and runtime commands load domain configuration independently while preserving legacy runner-profile operation during migration.

## Requirements addressed

REQ-DOM-4–6, REQ-CONV-5–11, REQ-REL-6

## Background

Task 1.3 introduced `loadDomainConfig()`. Currently `runPanCli()` in `src/pan-cli.js:21-81` always loads `loadRunnerProfile()`, then uses its `store` and machine identity. Existing `inbox`, `answer`, and `add` behavior in `AttentionService` must remain available even before reasoning is fully wired. Runner CLI composition in `bin/pan-runner.js` remains profile-based.

## Files to modify/create

- `src/pan-cli.js` — parse `--config`/`PAN_CONFIG`, compose store/attention from domain config, and retain a deprecated `--profile` fallback.
- `test/pan-cli.test.js` — pure parsing and conflict cases.
- `test/pan-cli-integration.test.js` — injected loader/factory composition tests.
- `README.md` and `docs/triage-and-attention.md` — new configuration examples and compatibility notice.

## Implementation details

1. Add `--config <domain-config.json>` and `PAN_CONFIG`; prefer explicit CLI, then environment.
2. Keep `--profile`/`PAN_PROFILE` only as a compatibility adapter that extracts the old `store` values and emits a deprecation warning outside JSON output.
3. Reject simultaneous domain config and runner profile inputs.
4. Construct `PanStore` solely from domain config for `inbox`, `answer`, and `add`.
5. Preserve command arguments, JSON result shapes, answer-by-ID/URL, repeatable requirements, and add defaults.
6. Introduce injected config loaders/store factories so tests do not read real files or GitHub.
7. Leave `daemon` behavior on its compatibility path until `PanRuntime` exists, but route its configuration parsing through the new structure.

## Testing suggestions

- `node --test test/pan-cli.test.js test/pan-cli-integration.test.js test/attention-service.test.js`
- Verify legacy profile mode and new config mode return equivalent attention results.
- `npm test`

## Gotchas

- Do not require runner repository paths or terminal settings for attention commands.
- Do not print warnings into machine-readable JSON.
- Do not remove `PAN_PROFILE` yet.

## Verification checklist

- [ ] PAN attention commands work with only domain config.
- [ ] Runner CLI remains independently profile-based.
- [ ] Legacy profile use is compatible and visibly deprecated.
- [ ] Targeted tests and `npm test` pass.
