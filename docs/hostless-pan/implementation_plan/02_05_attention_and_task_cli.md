# Task 2.5: Attention and Task CLI

## Goal

Expose inbox, answer, and Issue-backed task addition through a documented `pan attention` command family while preserving existing behavior and JSON compatibility.

## Requirements addressed

REQ-ATTN-1–10, REQ-MIG-5–6, REQ-REL-6

## Background

`AttentionService` in `src/attention-service.js:21-173` already lists unresolved attention plus `in-review` work, answers by ID or Issue URL, restores prior priority and resume affinity, and adds Issue-backed untriaged work. `src/pan-cli.js:205-224` exposes legacy top-level `inbox`, `answer`, and `add` commands.

Tasks 1.1–1.2 provide hostless configuration and the common command envelope. This task keeps attention available independently of portfolio reasoning or any PAN host.

## Files to modify/create

- `src/attention-commands.js` — bounded command handlers and result formatting.
- `src/attention-service.js` — accept fresh expected-state/leadership hooks for mutating transitions.
- `src/pan-cli.js` — add `pan attention list|answer|add`; retain compatibility aliases temporarily.
- `test/attention-service.test.js` — state and idempotency regression coverage.
- `test/attention-commands.test.js` — command parsing and JSON compatibility.
- `docs/triage-and-attention.md` — document the replacement family in the later docs task if not edited here.

## Implementation details

1. Map `pan attention list` to the current inbox behavior and retain task, kind, priority, prompt, Issue URL, PR, machine, terminal, local URL, and resume locators.
2. Map `pan attention answer <id-or-url> <text>` to durable answer recording and reconsideration. Revalidate leadership and current attention/lifecycle state before each mutation step.
3. Reject an answer when there is no unresolved attention, except for the existing safe recovery of a previously recorded answer whose transition was incomplete.
4. Map `pan attention add` to Issue-backed untriaged task creation with body, workstream, owner, priority, autonomy, and repeatable requirements.
5. Keep genuine human questions distinct from operational runner failures; do not promote launch/exit failures into urgent attention.
6. Preserve legacy JSON payload fields inside the common result envelope so scripts can migrate deterministically.
7. Ensure list remains available read-only and mutating operations reject when leadership is absent.

## Testing suggestions

- Extend `test/attention-service.test.js` for answer retries, no-attention rejection, priority restoration, resume affinity, and operational failures.
- In `test/attention-commands.test.js`, compare legacy alias payloads with the nested command payloads.
- Verify list works when reasoning services are unavailable.

## Gotchas

- Conversation history is not the durable answer record.
- Do not erase prior priority or runner resume affinity.
- Task addition must preserve Issue identity if Project registration later becomes incomplete; Task 3.3 completes that recovery model.

## Verification checklist

- [ ] Hostless attention list includes unresolved questions and all `in-review` work.
- [ ] Answers are durable, idempotent, and restore eligible work safely.
- [ ] Invalid answers have no side effects.
- [ ] Task addition retains all existing structured options and JSON data.
- [ ] Integration tests: `test/attention-service.test.js`; `test/attention-commands.test.js`.
