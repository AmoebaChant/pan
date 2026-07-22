# Task 2.2: Complete Evidence Snapshot Version 2

## Goal

Build one immutable snapshot that joins the complete Issue catalog, complete canonical Project, workstreams, and sanitized runner state with per-source completeness and expected-state references.

## Requirements addressed

REQ-EVD-7–16, REQ-PORT-1–4, REQ-RUN-11

## Background

`PortfolioSnapshotBuilder.build()` in `src/portfolio-snapshot.js:50-139` currently creates version 1 from Project items, workstreams, and runner availability. `PanStore.readCanonicalProject()` at `src/pan-store.js:442-450` already derives a stable identity from complete ordered Project evidence, while Task 2.1 adds the complete Issue catalog.

This task produces the fresh authorization snapshot used by reconciliation, recommendations, and mutations. Conversation history and prior snapshots remain non-authoritative.

## Files to modify/create

- `src/portfolio-snapshot.js` — build and validate version 2.
- `src/pan-store.js` — return explicit Project membership/content classifications and revisions.
- `src/runner-availability.js` — preserve sanitized completeness metadata.
- `src/pan-cli.js` — add `pan evidence portfolio`.
- `schema/portfolio-snapshot.json` — public snapshot contract.
- `test/portfolio-snapshot.test.js` — complete/incomplete source combinations.
- `test/pan-store.test.js` — Project classification and ordering evidence.

## Implementation details

1. Add the complete Issue catalog as a first-class source. Join each Project item to a configured-domain Issue when possible and classify draft, pull-request, cross-domain, unreadable, and unsupported content explicitly.
2. Preserve every Project item exactly once in canonical order, even when it is not an ordinary backlog Issue.
3. Include workstream content/blob/git revisions, sanitized runner availability and active work, current leases, and recent evidence needed by portfolio decisions.
4. Record source-by-source completeness, diagnostics, exclusions, and safety-limit failures. Derive `usableForMutation` from the exact sources required by the requested operation, not merely from process success.
5. Add resource-specific expected-state references for Project order, fields/items, Issue catalog, Project membership, workstream blobs/default-branch base, attention records, and leadership generation.
6. Derive one stable snapshot identity from all mutable authorization evidence. Paged presentation must retain that same identity.
7. Keep older snapshots readable for diagnostics but reject them for completeness-sensitive hostless mutation.

## Testing suggestions

- Extend `test/portfolio-snapshot.test.js` with catalog/Project joins, unsupported Project content, stale workstream revisions, runner incompleteness, and stable IDs.
- Verify a Project item missing from the Issue catalog is diagnosed rather than silently normalized.
- Verify one incomplete required source makes the requested mutation unusable.

## Gotchas

- Project completeness does not imply Issue-catalog completeness.
- Unsupported Project content should remain visible in order rather than disappearing.
- Do not leak runner checkout paths, credentials, terminal settings, or private capability details.

## Verification checklist

- [ ] Snapshot version 2 accounts for every Issue and every Project item needed by the decision.
- [ ] Every source has explicit completeness and diagnostics.
- [ ] Expected-state references change when their resource changes.
- [ ] Older snapshots cannot authorize hostless mutations.
- [ ] Integration tests: `test/portfolio-snapshot.test.js`; `test/pan-store.test.js`.
