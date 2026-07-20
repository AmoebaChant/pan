# Task 3.2: Review Dry-run CLI

## Goal

Expose a one-cycle `pan review --dry-run` command with concise human output and complete machine-readable output.

## Requirements addressed

REQ-ADV-5, REQ-CONV-11, REQ-REL-5–6

## Background

Task 3.1 added `ReasoningService.review()` without side effects. `src/pan-cli.js` already parses commands and emits table or JSON output for attention operations. This task makes reasoning inspectable before live application and must not disrupt `inbox`, `answer`, or `add`.

## Files to modify/create

- `src/pan-cli.js` — parse and run `review --dry-run [--json]`.
- `test/pan-cli.test.js` — parsing and required dry-run guard.
- `test/pan-cli-integration.test.js` — injected reasoning result formatting and failure exit behavior.
- `docs/triage-and-attention.md` and `README.md` — usage and dry-run semantics.

## Implementation details

1. Add `review` with `--dry-run` mandatory until live application is implemented. Reject an unqualified live review.
2. Compose domain config, store, workstream source, availability source, snapshot builder, tool registry, agent client, and reasoning service through injectable factories.
3. Human output should show the recommended next work, material ordering changes, questions, uncertainties, and citations without dumping the full snapshot.
4. JSON output should return the complete validated Task 1.2 result, including snapshot ID and rejected actions.
5. Exit unsuccessfully on incomplete snapshot, agent invocation failure, malformed response, or incomplete classification.
6. Ensure no mutation method is invoked in integration tests.

## Testing suggestions

- `node --test test/pan-cli.test.js test/pan-cli-integration.test.js test/reasoning-service.test.js`
- Verify `pan inbox` still works when the agent executable is unavailable.
- `npm test`

## Gotchas

- `--dry-run` must be semantic, not merely a display flag.
- Do not print private local paths in human or JSON output.
- Attention/store operations must remain usable when reasoning fails.

## Verification checklist

- [ ] `pan review --dry-run` produces concise and JSON forms.
- [ ] No live mutation path is reachable.
- [ ] Reasoning failures are actionable and nonzero.
- [ ] Targeted tests and `npm test` pass.
