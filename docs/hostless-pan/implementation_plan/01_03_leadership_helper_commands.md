# Task 1.3: Leadership Helper Commands

## Goal

Expose leadership status, acquisition, assertion, renewal, release, and recovery diagnostics as bounded stateless commands using the existing durable lease.

## Requirements addressed

REQ-LEAD-1–12, REQ-TOOL-7, REQ-MIG-8–10

## Background

Only one PAN session may mutate a domain, although many sessions may read it. `GitHubStateFile` and `LeaderLease` in `src/leader-lease.js:8-258` already use expected-version writes, token confirmation, expiry, and safe same-machine process checks. Existing host/runtime code holds a `LeaderLease` instance in memory; hostless mutation helpers instead need to confirm a caller's session identity and generation against fresh durable state.

Task 1.1 provides version 2 leadership settings. Task 1.2 provides the common command envelope and per-process command context.

## Files to modify/create

- `src/leader-lease.js` — add non-owning status/assert operations and compatible metadata.
- `src/leadership-commands.js` — stateless command handlers.
- `src/pan-cli.js` — add `pan leadership status|acquire|assert|renew|release`.
- `schema/pan-command-result.json` — include optional leader diagnostics if needed.
- `test/leader-lease.test.js` — expand primitive coverage.
- `test/leadership-commands.test.js` — command-level behavior.

## Implementation details

1. Preserve the existing durable record fields and correctness rules. Optional `sessionId` and `holderKind` are diagnostic only; ownership still depends on holder, token, expected version, and expiry.
2. Define the session environment contract used by later helpers: stable session ID, holder identity, and unguessable leadership generation token.
3. `status` reads current durable state and reports active, expired, locally recoverable, remote/unverifiable, or absent without mutating.
4. `acquire` performs one bounded acquisition/confirmation attempt and returns writer or read-only information. It must never steal a live remote or unverifiable lease.
5. `assert` accepts the caller's session identity/generation, rereads durable state, and rejects stale, expired, replaced, or mismatched authority.
6. `renew` and `release` require the same identity/generation and expected-version protection; a stale caller cannot alter the new leader.
7. Keep runner task leases independent. Leadership commands must not read or edit Project claimant fields.
8. Treat old host records as ordinary contenders during transition, but ignore endpoint, token, state-file, and log artifacts as authority.

## Testing suggestions

- Reuse `test/leader-lease.test.js` cases for contention, heartbeat, expiry, release, local process recovery, and remote protection.
- In `test/leadership-commands.test.js`, create separate command contexts to prove no in-memory ownership is required.
- Verify a stale generation cannot assert, renew, or release after another holder wins.

## Gotchas

- Possessing a token in the environment is not sufficient; every assertion must reread durable state.
- Do not infer that a remote process is dead.
- Release should be best effort on normal shutdown, while expiry remains the abnormal-exit recovery path.

## Verification checklist

- [ ] Exactly one concurrent acquisition confirms ownership.
- [ ] Read-only callers receive clear diagnostics and retain read capability.
- [ ] Stale or lost generations cannot mutate or release current leadership.
- [ ] Existing host and hostless sessions contend through the same record.
- [ ] Integration tests: `test/leader-lease.test.js`; `test/leadership-commands.test.js`.
