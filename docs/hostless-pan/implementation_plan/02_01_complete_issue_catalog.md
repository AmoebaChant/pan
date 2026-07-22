# Task 2.1: Complete Issue Catalog

## Goal

Add a complete, explicitly paginated open-and-closed Issue catalog that excludes pull requests and exposes nested-evidence completeness.

## Requirements addressed

REQ-EVD-1, REQ-EVD-4–6, REQ-EVD-8, REQ-EVD-10–11

## Background

The GitHub Project is the canonical queue but is not the complete backlog population. `PanStore.syncOpenIssues()` at `src/pan-store.js:452-489` currently uses one bounded `gh issue list` call for open Issues. `findIssueByMarker()` at `src/pan-store.js:551-573` uses the same fixed limit. Neither operation proves complete open/closed enumeration or explicitly classifies API records that are pull requests.

Tasks 1.1–1.2 provide validated configuration and a common helper result. This task creates the evidence source used by snapshots, reconciliation, and duplicate prevention.

## Files to modify/create

- `src/issue-catalog.js` — complete repository Issue reader and normalizer.
- `src/pan-store.js` — expose lower-level Issue/comment/relationship operations needed by the catalog.
- `src/gh-client.js` — support paginated REST/GraphQL calls while preserving safe subprocess behavior.
- `src/pan-cli.js` — add `pan evidence issues`.
- `test/issue-catalog.test.js` — pagination, exclusion, and incompleteness cases.
- `test/pan-store.test.js` — retained store adapter coverage.

## Implementation details

1. Enumerate all repository Issues in both open and closed states through every page. Use an API shape that exposes pull-request identity so PR-backed Issue representations are explicitly excluded.
2. Preserve Issue number, node/database identity as available, URL, state, title, body, created/updated/closed timestamps, labels, assignees, author, and durable relationship information required by reconciliation and duplicate checks.
3. Page comments and other nested evidence when a decision requests them. If a nested source is intentionally excluded, record that scope so callers cannot mistake the catalog for complete evidence for that decision.
4. Detect cursor repetition, changed totals/revisions, inaccessible pages, malformed records, and configured safety-limit exhaustion. Return incomplete diagnostics rather than a partial success.
5. Produce a stable catalog identity from ordered mutable evidence.
6. Make `pan evidence issues --json` emit the common envelope, catalog identity, source completeness, excluded PR count, and diagnostics.
7. Do not mutate GitHub in this task.

## Testing suggestions

- Test multiple pages spanning open and closed Issues.
- Include PR-shaped records, closed Issues, paged comments, changed totals, repeated cursors, missing fields, and safety-limit exhaustion.
- Verify stable identity for unchanged data and a changed identity after material Issue/comment changes.

## Gotchas

- `gh issue list --limit` is a limit, not proof of completeness.
- Pull requests must not enter semantic duplicate detection or missing-backlog reconciliation.
- Do not claim complete nested evidence when comments or relationships were omitted.

## Verification checklist

- [ ] Every open and closed Issue is enumerated through all pages.
- [ ] Pull requests are explicitly identified and excluded.
- [ ] Nested evidence is complete or explicitly scoped out.
- [ ] Safety limits produce incomplete results, never partial success.
- [ ] Integration tests: `test/issue-catalog.test.js`; relevant `test/pan-store.test.js` cases.
