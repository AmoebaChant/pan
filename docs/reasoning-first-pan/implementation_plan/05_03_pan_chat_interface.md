# Task 5.3: Pan Chat Interface

## Goal

Add `pan chat` as an interactive interface to the same Pan custom agent, current domain snapshot, canonical queue, and constrained tools used by autonomous reviews.

## Requirements addressed

REQ-ADV-1, REQ-CONV-1–4, REQ-CONV-12

## Background

Task 1.5 supports interactive PAN turns using the invocation mechanism chosen by the spike. Task 2.4 builds current snapshots, and Task 3.6 applies validated actions. The transcript safe default is local ephemeral retention count zero unless domain config explicitly enables bounded local retention; durable outcomes must be promoted to GitHub-backed records.

## Files to modify/create

- `src/conversation-service.js` — session loop, snapshot refresh, agent turn, and response rendering.
- `src/pan-cli.js` — parse/run `chat` and one-shot `chat --message`.
- `test/conversation-service.test.js` — same agent identity, fresh context, follow-up, cancellation, and retention.
- `test/pan-cli.test.js` and `test/pan-cli-integration.test.js` — chat parsing/composition.
- `docs/triage-and-attention.md` — chat usage and transcript policy.

## Implementation details

1. Start each user turn from a fresh or validated-current complete snapshot; conversation history may provide discourse context but cannot replace durable state.
2. Use `PanAgentClient.chat()` with the same custom-agent name and Task 1.2 protocol as reviews.
3. Support interactive stdin/stdout and one-shot message mode for tests/automation.
4. Keep local transcript retention disabled by default. If enabled, store only bounded local files outside the domain repository with clear deletion behavior.
5. Render concise recommendations, current rationale/citations, applied/rejected actions, and pending approvals.
6. Refresh/re-evaluate after any applied action before answering follow-up questions about current order.

## Testing suggestions

- `node --test test/conversation-service.test.js test/pan-cli.test.js test/pan-cli-integration.test.js`
- Verify no transcript file is written with default configuration.
- `npm test`

## Gotchas

- Do not maintain conversation-only task/order state.
- Do not assume an earlier-turn snapshot is still current after mutation.
- Interactive process reuse must follow the Task 1.1 result; do not invent unsupported session semantics.

## Verification checklist

- [ ] Chat and autonomous review use the same Pan identity/protocol.
- [ ] Current GitHub-backed state wins over transcript memory.
- [ ] Default transcript retention writes nothing durable.
- [ ] Targeted tests and `npm test` pass.
