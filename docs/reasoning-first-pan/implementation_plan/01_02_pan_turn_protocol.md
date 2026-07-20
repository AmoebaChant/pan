# Task 1.2: PAN Turn Protocol

## Goal

Define and validate the versioned records exchanged between the PAN runtime, Copilot CLI agent process, constrained tools, proposed actions, and final user-facing response.

## Requirements addressed

REQ-ADV-3, REQ-REA-9, REQ-ACT-1–3, REQ-REL-1, REQ-REL-4

## Background

Task 1.1 selected the supported Copilot CLI process and tool transport and documented it in `docs/reasoning-first-pan/spikes/copilot-cli-invocation.md`. The repository already uses small structured records in `src/needs-human.js` and `src/task-worker.js`, but there is no protocol for portfolio turns or validated action proposals. The protocol must distinguish evidence, interpretation, uncertainty, requested operations, confirmed effects, and incomplete effects.

## Files to modify/create

- `schema/pan-turn.json` — request/final-response envelope.
- `schema/pan-action.json` — allowed proposed action union.
- `schema/pan-tool-message.json` — tool request/result framing selected by Task 1.1.
- `src/pan-protocol.js` — dependency-free validators and normalization helpers.
- `test/pan-protocol.test.js` — valid, malformed, unknown-version, and partial-effect cases.
- `src/index.js` — export the public protocol helpers.

## Implementation details

1. Define version `1` envelopes for autonomous review and interactive chat with a turn ID, mode, timestamp, complete-snapshot identity, user input when present, and tool-channel metadata.
2. Define proposed actions for field updates, canonical reorder, relative-precedence change, Issue creation, Issue comment, needs-human question, and no-op recommendation. Each mutation must carry evidence citations, rationale, confidence, expected mutable state, and an idempotency key.
3. Define final responses with recommendation, facts, interpretations, assumptions, uncertainties, citations, proposed/applied/rejected actions, and confirmed/incomplete effects.
4. Reject unknown versions, extra action kinds, malformed citations, missing expected state, and mutation records without idempotency keys.
5. Keep validators handwritten like `validateRunnerProfile()` in `src/runner-profile.js`; do not add a runtime dependency.
6. Make protocol errors identify the record path and corrective action.

## Testing suggestions

- `node --test test/pan-protocol.test.js`
- Add round-trip fixtures for every action kind and an unknown future version.
- `npm test`

## Gotchas

- Protocol validation is not authority validation; later policy code decides whether a valid action is permitted.
- Do not put full private portfolio snapshots into audit/result records.
- Keep citations durable and inspectable rather than model-internal references.

## Verification checklist

- [ ] Every planned PAN mutation has one explicit versioned action record.
- [ ] Unknown or malformed records fail before side effects.
- [ ] Final results can represent confirmed and incomplete effects.
- [ ] Targeted tests and `npm test` pass.
