# Task 2.4: Complete Portfolio Snapshot

## Goal

Build one immutable, fail-closed snapshot containing every Project item, its evidence-backed dossier, relevant workstreams, runner availability, current time, and a stable identity for reasoning and concurrency checks.

## Requirements addressed

REQ-REA-1–10, REQ-DATA-11, REQ-REL-5

## Background

Task 2.1 added complete canonical Project reads. Task 2.2 added confined workstream reads/history, and Task 2.3 added sanitized runner availability. The snapshot must classify all Project items, including closed, done, leased, blocked, and otherwise non-candidate items, so the agent cannot silently reason over a filtered subset.

## Files to modify/create

- `src/portfolio-snapshot.js` — `PortfolioSnapshotBuilder`.
- `test/portfolio-snapshot.test.js` — complete dossiers, missing evidence, all-item classification input, deterministic identity, and unchanged repeatability.
- `src/index.js` — exports.

## Implementation details

1. Read Project state, workstream index, referenced workstreams/history, runner availability, and current time through injected sources.
2. Produce a dossier per Project item with canonical index, Issue body/comments/timestamps, fields, requirements, dependencies/blockers discoverable from durable text, lease state, workstream evidence, recent changes, and compatibility evidence.
3. Include an explicit preclassification such as actionable, done, closed, actively leased, blocked, needs detail, or unsupported; this is factual lifecycle classification, not prioritization judgment.
4. Include diagnostics and evidence availability. If any read needed for complete portfolio judgment is partial, inaccessible, or internally inconsistent, mark the entire snapshot unusable for portfolio mutation.
5. Generate a stable snapshot ID from normalized durable inputs. Equivalent unchanged inputs must produce the same ID independent of object property insertion order.
6. Avoid embedding local clone paths or runner-private values in the agent-facing serialized form.
7. Keep the complete snapshot in memory; do not create a shadow queue or durable task database.

## Testing suggestions

- `node --test test/portfolio-snapshot.test.js`
- Cover one item in every lifecycle state and a missing workstream referenced by an actionable item.
- `npm test`

## Gotchas

- Do not filter to ready work before invoking PAN.
- Do not let a per-item error become silent omission.
- Snapshot identity is a concurrency/equivalence token, not durable ordering state.

## Verification checklist

- [ ] Every canonical item has one dossier and canonical index.
- [ ] Missing required evidence prevents mutation-ready status.
- [ ] Repeated unchanged builds are equivalent.
- [ ] Targeted tests and `npm test` pass.
