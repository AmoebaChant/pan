# Task 4.3: Hostless Session Launch

## Goal

Implement `pan session --config <path>` to preflight one domain and launch an ordinary foreground Copilot CLI session rooted exactly at that domain.

## Requirements addressed

REQ-EXP-1–4, REQ-DOM-1–10, REQ-MIG-11

## Background

`src/pan-launcher.js:29-190` currently starts/discovers a host, writes an MCP config, and launches Copilot in the reusable PAN checkout. `buildInteractiveCopilotArgs()` at `src/pan-launcher.js:283-313` disables built-in MCPs and exposes PAN bridge tools. Tasks 4.1–4.2 provide verified user-scoped assets; Tasks 1–3 provide ordinary helper commands.

This task launches the child and performs preflight. Leadership lifetime is added in Task 4.4 and native scheduling in Task 4.5.

## Files to modify/create

- `src/pan-session.js` — preflight and Copilot child launch.
- `src/pan-launcher.js` — replace host-oriented launch helpers or delegate transitional aliases.
- `src/pan-cli.js` — parse and dispatch `pan session`.
- `src/domain-identity.js` — validate local clone, remote, default branch, and configured GitHub identity.
- `test/pan-session.test.js` — preflight and child arguments.
- `test/pan-launcher.test.js` — replace host/MCP expectations.

## Implementation details

1. Load normalized version 2 configuration and require exactly one domain.
2. Validate `domain.path` exists, is a git repository, has the configured GitHub repository as the relevant remote, and resolves the expected default branch. Validate Project schema/state namespace/authentication before a writing-capable start.
3. Verify the user-scoped PAN agent/instructions/skills and the supported Copilot CLI contract.
4. Launch the configured Copilot executable as a foreground child with `cwd` equal to `domain.path`, explicit agent selection, configured/default model, inherited terminal IO, and normal built-in capabilities.
5. Pass only bounded PAN session metadata through the child environment. Do not pass bearer tokens, endpoint data, or private runner settings.
6. Add configured product-context roots only through the supported read-only mechanism and label them clearly for the agent.
7. Return/propagate the child's exit code and signal accurately.
8. Do not create host state, MCP config, endpoint, token, detached process, or background scheduler artifacts.

## Testing suggestions

- Use a fake Copilot child to assert executable, arguments, environment, `cwd`, IO, exit propagation, and model selection.
- Test repository mismatch, invalid Project schema, missing/stale assets, unsupported Copilot version, and inaccessible product context.
- Assert no host/MCP files are created.

## Gotchas

- The session working directory is the private domain, not the PAN package checkout.
- Product-context roots remain read-only and outside mutation validation.
- Do not inject terminal keystrokes or inspect private Copilot session files.

## Verification checklist

- [ ] `pan session` launches one foreground Copilot child in the configured domain root.
- [ ] Domain/repository/Project/asset/Copilot preflight failures are actionable.
- [ ] No host, endpoint, token, MCP config, or detached process is created.
- [ ] Child exit status is propagated.
- [ ] Integration tests: `test/pan-session.test.js`; `test/pan-launcher.test.js`.
