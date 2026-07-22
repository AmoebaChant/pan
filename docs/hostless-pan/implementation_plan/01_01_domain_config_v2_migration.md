# Task 1.1: Domain Configuration Version 2 and Migration

## Goal

Introduce the hostless domain/session configuration shape, continue reading version 1 safely, and provide deterministic validation and atomic migration without changing runner profiles.

## Requirements addressed

REQ-DOM-1–4, REQ-SCH-6–8, REQ-MIG-1–3

## Background

Hostless PAN runs one ordinary Copilot session for one configured domain. `src/domain-config.js:61-163` currently accepts only version 1 and exposes host-oriented `cadences`; `schema/domain-config.json` mirrors that shape. `src/pan-setup.js:274-295` also creates version 1. Runner configuration remains independent in `src/runner-profile.js` and must not absorb session or leadership settings.

This foundational task produces normalized version 2 configuration for later stateless helpers and `pan session`. Version 1 files must remain readable in memory with explicit migration diagnostics, while a write occurs only through an explicit migration/update command.

## Files to modify/create

- `schema/domain-config.json` — define version 2 and the accepted version 1 compatibility shape.
- `src/domain-config.js` — normalize versions, validate hostless fields, and expose migration helpers.
- `src/domain-config-file.js` — new atomic read/replace/migrate file operations.
- `src/pan-setup.js` — emit version 2 for newly created domains.
- `src/index.js` — export the new configuration APIs.
- `test/domain-config.test.js` — version/default/validation/migration coverage.
- `test/pan-setup.test.js` — assert setup writes version 2.

## Implementation details

1. Define version 2 sections matching the architecture: domain and Project identity; state namespace; `session.agent` and labeled `productContextRoots`; bounded `scheduling` settings; leadership lease/heartbeat settings; action policy; attention; and retained self-repair settings.
2. Remove host polling, transcript-hosting, detached runtime, endpoint, and host supervision settings from the normalized version 2 result. Accept their version 1 equivalents only for compatibility mapping and diagnostics.
3. Map version 1 `agent` and cadence values in memory. Map the old full-review cadence to `scheduling.reviewIntervalSeconds`; use documented defaults for startup, enabled, general retry, and rate-limit retry.
4. Validate the absolute domain root, confined state paths, read-only product-context roots, leadership relationships, scheduling bounds, and action classifications with field-specific errors.
5. Keep runner-only key rejection from `src/domain-config.js:370-383`.
6. Add a migration function that returns the proposed version 2 document and diagnostics without writing. Add an atomic replace function that writes a sibling temporary file, validates it, and renames it over the original only after success.
7. Make setup produce version 2 directly. Do not modify or infer any runner profile fields.

## Testing suggestions

- Extend `test/domain-config.test.js` for version 1 normalization, version 2 defaults, product-context confinement, invalid scheduling/leadership relationships, and unknown host-only fields in version 2.
- Verify failed atomic replacement leaves the original file unchanged.
- Extend `test/pan-setup.test.js` to inspect the generated `pan.json`.

## Gotchas

- Reading a version 1 file must not silently rewrite it.
- Product-context roots are read-only references and never expand `domain.path`.
- Do not store credentials, terminal settings, runner capacity, or machine identity.

## Verification checklist

- [ ] Version 1 and version 2 configurations normalize to one hostless runtime shape.
- [ ] Migration diagnostics name every remapped or obsolete field.
- [ ] Explicit migration writes atomically and preserves the original on failure.
- [ ] New setup output is version 2 and runner profiles remain unchanged.
- [ ] Integration tests: `test/domain-config.test.js`; `test/pan-setup.test.js`.
