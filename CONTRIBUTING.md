# Contributing

Pan is defined in Markdown. The behavior and contracts live in
[`system/`](system/overview.md); the only code is the runner under `bin/`.
Correctness is defined by the clarity and consistency of the `system/`
contracts, so when you change behavior, change the relevant `system/` document
in the same commit. There are no tests.

Keep the design MD-first: do not push behavior that belongs in a contract into
the runner. The runner should only find work, coordinate leases, launch worker
sessions, and relay the file-based signals defined in
[`system/runner.md`](system/runner.md).

Requirements: Node.js 22+ and the GitHub CLI (`gh`).

Make changes on a feature branch or an isolated worktree; never work directly on
the default branch.

This is a public tool repository and holds no user data. Never add private
workstreams, runner state, leases, credentials, or user-specific paths.
