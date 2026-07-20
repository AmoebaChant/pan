# Task 3.1: Reasoning Dry-run Service

## Goal

Run a complete portfolio-reasoning turn and return validated recommendations/actions without applying any GitHub or workstream mutation.

## Requirements addressed

REQ-ADV-2–6, REQ-REA-1–11, REQ-RUN-11

## Background

Task 1.5 provides `PanAgentClient`; Task 2.4 builds complete snapshots; Task 2.5 provides constrained read tools and action proposals. The current `PanDaemon.tick()` directly applies deterministic `deriveTriage()` and `compareBacklogItems()`. This service introduces model judgment safely before replacing that path.

## Files to modify/create

- `src/reasoning-service.js` — `ReasoningService.review({ dryRun: true })`.
- `test/reasoning-service.test.js` — complete input, proposed actions, invalid output, omitted item, unstable response, and failed turn.
- `src/index.js` — exports.

## Implementation details

1. Build one snapshot and reject mutation-capable reasoning if it is incomplete.
2. Invoke `PanAgentClient.review()` with the snapshot ID, current time, every dossier, current canonical order, manual constraints if available, and authority summary.
3. Require the final response to classify every item ID exactly once. Reject missing, duplicate, or unknown items.
4. Validate citations against evidence present in the snapshot.
5. Validate action records structurally and through non-mutating policy checks; collect accepted proposals and rejected proposals with reasons.
6. Require a clear recommended human next action and agent queue recommendation when evidence supports them.
7. Preserve facts/interpretations/assumptions/uncertainty separately in the result.
8. Make repeated reviews over an identical snapshot testable with a fixed fake agent response; do not enforce byte-identical model prose.

## Testing suggestions

- `node --test test/reasoning-service.test.js`
- Include a fixed priority/status sort response that is valid structurally but rejected when it lacks portfolio evidence.
- `npm test`

## Gotchas

- Dry-run must not call any mutating store method.
- A polished response that omits an item is not a complete review.
- Do not fall back to `compareBacklogItems()` when the agent fails.

## Verification checklist

- [ ] Every snapshot item is classified and citations resolve.
- [ ] Proposed actions are validated but not applied.
- [ ] Failed turns are visible and never reported as successful review.
- [ ] Targeted tests and `npm test` pass.
