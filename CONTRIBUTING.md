# Contributing

Development requires Node.js 22 or newer.

Run `npm test` before submitting changes. When a deliberate change invalidates
an assertion, update that test in the same change so the suite always reflects
current behavior. Add tests for contracts worth protecting: field and schema
validation, task leases and claims, delivery validation, and path isolation.
Prefer those over assertions on exact user-facing prose, which change often and
catch little.

Make changes on a feature branch or in an isolated worktree. Never work directly
on the default branch.

This is a public tool repository. Do not add private workstreams, runner state,
locators, leases, credentials, or user-specific paths.

The [onboarding requirements](docs/pan-onboarding/requirements.md) describe what
setup must deliver.
