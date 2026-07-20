# Task 2.2: Confined Workstream Store

## Goal

Add a reusable domain-repository reader that enumerates workstream hierarchy, reads referenced README files, searches narrative, and returns relevant git history without allowing path escape.

## Requirements addressed

REQ-DOM-7, REQ-DATA-5, REQ-REA-3–4, REQ-SEC-6

## Background

Workstreams are folders below `workstreams/` with `README.md`; folder nesting is the hierarchy. `resolveWorkstreamReadme()` in `src/local-task-executor.js:440-465` already validates slash-separated relative paths and confines resolution to the workstream root. Portfolio reasoning also needs enumeration, file timestamps/content hashes, and recent git commits. `ProcessClient` can run bounded `git` commands.

## Files to modify/create

- `src/workstream-store.js` — `WorkstreamStore` with list/read/search/history methods.
- `src/local-task-executor.js` — reuse the shared confined resolver instead of owning a duplicate.
- `test/workstream-store.test.js` — hierarchy, nested paths, symlink/path escape, missing README, search, and git history.
- `test/local-task-executor.test.js` — retain resolver compatibility.
- `src/index.js` — exports.

## Implementation details

1. Extract the existing path validation into a shared exported resolver that accepts only canonical `/`-separated workstream paths.
2. Enumerate only `workstreams/**/README.md`; derive each full path and parent/children from folders, never frontmatter.
3. Read content with a content hash, filesystem timestamp, and current git revision. Reject references outside the root, including symlink/junction escapes after real-path resolution.
4. Add bounded literal/regex search over workstream README content with source path and line ranges.
5. Add recent history for one workstream path using `git log` from the configured domain clone, with commit SHA, time, subject, and changed path.
6. Treat missing or unreadable referenced workstreams as actionable snapshot errors; unrelated malformed files may be reported without pretending the read was complete.

## Testing suggestions

- `node --test test/workstream-store.test.js test/local-task-executor.test.js`
- Build temporary fixture repositories using Node filesystem/process APIs already available in tests.
- `npm test`

## Gotchas

- Lexical `path.resolve()` checks alone do not stop symlink/junction escape.
- Do not read arbitrary markdown outside `workstreams/`.
- Do not parse or invent parent frontmatter.

## Verification checklist

- [ ] Workstream hierarchy comes only from folder nesting.
- [ ] Referenced reads and searches cannot escape the configured root.
- [ ] Snapshot-ready revision/history metadata is returned.
- [ ] Targeted tests and `npm test` pass.
