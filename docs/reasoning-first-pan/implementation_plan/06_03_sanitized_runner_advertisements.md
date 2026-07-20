# Task 6.3: Sanitized Runner Advertisements

## Goal

Publish and read idempotent sanitized runner advertisements containing only playbook identities, capabilities, online state, and free capacity for PAN reasoning and runner coordination.

## Requirements addressed

REQ-PLAY-5, REQ-REA-6, REQ-SEC-5, REQ-REL-3

## Background

Task 2.3 provides an R1 in-process sanitized view of legacy profiles. Tasks 6.1–6.2 add playbooks and local settings. Architecture requires advertisements in GitHub-backed operational state so PAN and other machines can observe availability without access to local settings. `GitHubStateFile` provides expected-version writes on the state branch.

## Files to modify/create

- `schema/runner-advertisement.json` — versioned sanitized record.
- `src/runner-advertisement.js` — build, publish, read, expiry, and aggregate.
- `test/runner-advertisement.test.js` — sanitization, contention, expiry, duplicate publish, and capacity changes.
- `src/runner-availability.js` — consume advertisements before legacy profiles.
- `docs/runner.md` — advertisement lifecycle.
- `src/index.js` — exports.

## Implementation details

1. Define runner ID, record version, observed/expiry time, online state, playbook IDs, sanitized capability strings, global free capacity, and per-playbook free capacity.
2. Explicitly reject paths, terminal details, credentials, environment values, repository clone paths, local URLs, and worker locators.
3. Publish through per-runner state files with expected-version updates and stable content for unchanged capacity.
4. Treat expired records as offline/zero capacity; retain them only as diagnostics.
5. Aggregate deterministically and expose provenance/timestamp to portfolio snapshots.
6. Make repeated publish/read idempotent and safe under transient failure.

## Testing suggestions

- `node --test test/runner-advertisement.test.js test/runner-availability.test.js`
- Serialize records and assert no Windows/Unix absolute path patterns.
- `npm test`

## Gotchas

- Advertisements are availability evidence, not task assignment.
- Free capacity is ephemeral and must expire.
- Never expose active task private context in an advertisement.

## Verification checklist

- [ ] Only approved sanitized fields are publishable.
- [ ] Expired/missing data cannot look available.
- [ ] PAN snapshots can consume aggregate advertisements.
- [ ] Targeted tests and `npm test` pass.
