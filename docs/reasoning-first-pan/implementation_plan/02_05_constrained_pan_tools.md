# Task 2.5: Constrained PAN Tools

## Goal

Implement the explicit domain-scoped operation registry through which PAN reads evidence and proposes or applies allowed changes, with no general shell, arbitrary filesystem, or unrestricted GitHub access.

## Requirements addressed

REQ-ACT-1–4, REQ-DOM-2, REQ-SEC-3, REQ-SEC-6

## Background

Task 1.2 defined tool messages and action records. Task 1.5 routes tool requests from Copilot. Tasks 2.1–2.4 provide complete Project, workstream, availability, and snapshot services. The custom agent names only PAN operations. This task creates the runtime registry but should initially expose mutations as validated proposals/dry-run results until Phase 3 adds application.

## Files to modify/create

- `src/pan-tools.js` — operation registry, argument validation, domain binding, and structured results.
- `src/action-policy.js` — initial authority matrix and common validation helpers.
- `test/pan-tools.test.js` — allowed reads, denied names, domain/path escape, malformed arguments, and proposal generation.
- `test/action-policy.test.js` — authority defaults and lifecycle protection.
- `src/index.js` — exports.

## Implementation details

1. Register named reads for complete snapshot, canonical items, Issue details/comments, workstream read/search/history, current rationale, runner availability, and unresolved attention.
2. Register proposal operations for field change, reorder, relative precedence, inferred Issue, comment/question, and no-op. Return Task 1.2 action records rather than mutating in this task.
3. Bind repository, Project, and workstream roots in constructor configuration; operation arguments may reference IDs/paths but cannot choose another domain.
4. Validate every request before source access. Reject unknown properties and unknown operation names.
5. Add an authority matrix with safe defaults: reads and dry-run proposals automatic; live reorder/field/comment/inferred creation require policy validation and material explanation; high-risk configured actions may require approval.
6. Preserve in-progress, in-review, done, active leases, and human/runner-created blocks in common policy checks.
7. Return actionable errors without exposing credentials or local paths.

## Testing suggestions

- `node --test test/pan-tools.test.js test/action-policy.test.js`
- Exercise tool dispatch through the fake agent transport from `test/pan-agent-client.test.js`.
- `npm test`

## Gotchas

- Tool availability is not mutation approval.
- Do not expose raw `GhClient`, `ProcessClient`, or arbitrary file reads.
- Keep domain binding immutable for the registry lifetime.

## Verification checklist

- [ ] Every custom-agent tool name maps to one validated registry operation.
- [ ] Cross-domain and path-escape requests fail before reads/mutations.
- [ ] Mutations remain proposals until Phase 3 application.
- [ ] Targeted tests and `npm test` pass.
