# Task 2.3: Runner Availability Snapshot

## Goal

Normalize current runner profiles into a read-only availability view that PAN can use for R1 recommendations without leaking machine-local paths, credentials, or terminal details.

## Requirements addressed

REQ-REA-6, REQ-SEC-5, REQ-EXEC-3–4

## Background

`RunnerProfileSource.load()` reads every JSON file from `<domain>/runners`, and `matchingRunner()` consumes `id`, `online`, and `capabilities`. Full profiles also contain repository paths, workspace/state directories, terminal settings, assignee, and Copilot settings. Portfolio reasoning needs availability and compatibility now; the later playbook phase will replace this adapter with sanitized advertisements.

## Files to modify/create

- `src/runner-availability.js` — normalize legacy profiles into sanitized availability records.
- `src/runner-profile-source.js` — expose sanitized load mode or delegate to the new module.
- `test/runner-availability.test.js` — sanitization, free capacity, malformed profile, and deterministic ordering.
- `src/index.js` — exports.

## Implementation details

1. Define an R1 availability record with stable runner ID, online state, exact capabilities, maximum capacity, observed active lease count when available, and free capacity.
2. Strip machine name if it is not needed for matching, and always strip local paths, terminal configuration, repository clone locations, credentials, assignee, and Copilot executable/model.
3. Derive free capacity conservatively: if active-use data is unavailable, advertise zero or an explicit unknown state rather than claiming capacity.
4. Preserve deterministic ordering by runner ID so unchanged snapshots are stable.
5. Report malformed profiles as snapshot diagnostics. Do not silently omit a profile if its absence could change compatibility conclusions.
6. Keep `matchingRunner()` compatibility until the later playbook matcher replaces it.

## Testing suggestions

- `node --test test/runner-availability.test.js test/runner-profile.test.js`
- Assert serialized availability contains none of the known local path fields.
- `npm test`

## Gotchas

- Availability is evidence for prioritization, not permission to assign work to a named machine.
- Do not publish this record yet; Phase 6 adds advertisements.
- Unknown capacity must not be treated as free capacity.

## Verification checklist

- [ ] PAN receives only sanitized matching/capacity data.
- [ ] Missing or invalid runner evidence is visible.
- [ ] Existing legacy profile loading remains compatible.
- [ ] Targeted tests and `npm test` pass.
