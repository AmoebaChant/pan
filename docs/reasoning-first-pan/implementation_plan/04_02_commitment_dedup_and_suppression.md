# Task 4.2: Commitment Deduplication and Suppression

## Goal

Prevent inferred commitments from duplicating open or resolved work and suppress recreation after rejection/closure of the unchanged source.

## Requirements addressed

REQ-INF-2, REQ-INF-5–7, REQ-REL-3

## Background

Task 4.1 provides stable source fingerprints. `PanStore.syncOpenIssues()` only detects open Issues absent from the Project; it does not search resolved Issues or semantic similarity. The safe default combines exact source markers with deterministic normalized similarity and requires the PAN proposal to cite the considered duplicate evidence.

## Files to modify/create

- `src/commitment-index.js` — build task index, parse markers, similarity scoring, and suppression decisions.
- `src/pan-store.js` — read open and closed Issue metadata needed by the index.
- `test/commitment-index.test.js` — exact source, open semantic duplicate, closed/rejected suppression, changed source, and false-positive bounds.
- `test/pan-store.test.js` — complete open/closed Issue enumeration and failures.

## Implementation details

1. Define a compact versioned inferred-source marker embedded in Issue bodies with fingerprint, source path, revision/timestamp, and interpreted date.
2. Enumerate both open and closed domain Issues needed for duplicate checks; fail closed if the search is incomplete.
3. Suppress automatically on exact source fingerprint, including a closed inferred Issue from unchanged source.
4. Add deterministic normalized title/action similarity using case folding, punctuation removal, stop-word filtering, and token overlap. Use a conservative high threshold and return candidate matches for PAN evidence rather than silently merging.
5. Require inferred creation actions to state `noDuplicate`, `duplicateOf`, or `needsQuestion` with cited Issue evidence.
6. Never close/delete an existing Issue because source narrative was removed or changed.
7. Make repeated index builds deterministic.

## Testing suggestions

- `node --test test/commitment-index.test.js test/pan-store.test.js`
- Include near-matches that must not suppress unrelated work.
- `npm test`

## Gotchas

- Closed is not equivalent to safe recreation.
- Semantic similarity must be conservative and explainable.
- Do not depend on model conversation memory for suppression.

## Verification checklist

- [ ] Exact unchanged sources never create repeated Issues.
- [ ] Open/resolved semantic candidates are surfaced with evidence.
- [ ] Removed source does not alter existing Issues.
- [ ] Targeted tests and `npm test` pass.
