# Task 4.1: Commitment Candidates

## Goal

Define and validate sourced commitment candidates from workstream narrative, including stable source identity, interpreted dates, extracted action, confidence, and evidence.

## Requirements addressed

REQ-REA-4, REQ-INF-1, REQ-INF-3–5

## Background

Task 2.2 exposes workstream content/revision and Task 2.4 includes it in the complete snapshot. PAN, not a fixed regex policy, decides whether narrative expresses an actionable commitment. Deterministic code must validate that an inferred-Issue proposal is grounded in a durable source and meets the configured high-confidence threshold.

## Files to modify/create

- `src/commitment-index.js` — candidate normalization and source fingerprint helpers.
- `schema/pan-action.json` — complete inferred-Issue candidate fields if not already present.
- `test/commitment-index.test.js` — stable fingerprints, source changes, dates, confidence threshold, and malformed citations.
- `test/reasoning-service.test.js` — accepted high-confidence versus question-only candidate.

## Implementation details

1. Define candidate fields: workstream path, revision/timestamp, source line range or stable excerpt hash, interpreted date/time zone when relevant, extracted action, rationale, confidence, and citations.
2. Generate a stable source fingerprint from normalized domain-relative path, source revision identity, and source excerpt identity. Do not include absolute paths.
3. Validate that cited source exists in the current snapshot and that the excerpt/line range matches.
4. Default automatic creation eligibility to confidence at or above 0.9 plus a concrete actionable statement. Below threshold, convert the proposal to a focused question/recommendation.
5. Treat changed source as a new candidate identity but retain links to prior inferred work for suppression/dedup checks.
6. Keep commitment identification model-driven; deterministic code validates provenance and threshold rather than scanning narrative with a competing rule engine.

## Testing suggestions

- `node --test test/commitment-index.test.js test/reasoning-service.test.js`
- Cover unchanged content across repeated reviews and edited content at the same path.
- `npm test`

## Gotchas

- A date alone is not an actionable commitment.
- Confidence without source evidence cannot authorize creation.
- Do not put full private workstream content in the fingerprint or Issue marker.

## Verification checklist

- [ ] Eligible candidates have inspectable source provenance.
- [ ] Unchanged source yields the same fingerprint.
- [ ] Ambiguous/low-confidence candidates become questions.
- [ ] Targeted tests and `npm test` pass.
