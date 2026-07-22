# Task 4.2: Asset Install, Status, and Repair

## Goal

Install, verify, upgrade, and repair the packaged PAN assets in supported Copilot user-scope locations without modifying private domain repositories.

## Requirements addressed

REQ-EXP-4–7, REQ-DOM-4, REQ-REL-7–9

## Background

Task 4.1 creates a versioned asset bundle and hash manifest. The current package only includes `.github/agents` through `package.json`; there is no user-level installer or conflict detector. `pan session` must preflight these assets before starting a writing session.

## Files to modify/create

- `src/pan-assets.js` — discover supported user directories and install/verify assets.
- `src/pan-cli.js` — add `pan assets install|status|repair`.
- `src/pan-setup.js` — optionally install assets after domain bootstrap, reporting results separately.
- `package.json` — include the complete asset tree.
- `test/pan-assets.test.js` — install, stale, conflict, and atomicity tests.
- `test/pan-setup.test.js` — setup integration result.

## Implementation details

1. Resolve supported Copilot user-level agent, instruction, and skill directories from the active environment/platform contract. Keep discovery isolated so Copilot layout changes are testable.
2. `status` compares installed files to the package manifest and reports missing, current, stale, malformed, shadowed, or locally conflicting assets.
3. `install` writes missing assets and a version/hash receipt using atomic replacement. It must not overwrite conflicting user modifications without an explicit repair/force policy.
4. `repair` replaces PAN-owned stale/corrupt assets after preserving enough diagnostics for recovery. Never delete unrelated user assets.
5. Validate the installed files after writing, including manifest hashes and agent/skill parseability.
6. Make writing-session preflight require a current, unambiguous asset installation. Read-only diagnostics may still run when repair is needed.
7. Keep the package asset source data-neutral and never write it into `domain.path`.

## Testing suggestions

- Use injected user directories to test fresh install, idempotent reinstall, package upgrade, missing file, modified file, malformed manifest, and atomic write failure.
- Verify unrelated files survive install/repair.
- Verify setup reports asset failure without deleting already-created remote/domain resources.

## Gotchas

- Do not guess at per-domain `.github` locations; distribution is user-scoped.
- Avoid silently overwriting user modifications that are not positively identified as PAN-owned.
- A package version match alone is insufficient; verify content hashes.

## Verification checklist

- [ ] Status distinguishes current, stale, missing, malformed, and conflicting assets.
- [ ] Install/repair is atomic and idempotent.
- [ ] Unrelated user files and all domain files remain unchanged.
- [ ] Writing-session preflight can rely on the verified manifest.
- [ ] Integration tests: `test/pan-assets.test.js`; `test/pan-setup.test.js`.
