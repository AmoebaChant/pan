# Task 4.1: User-Scoped PAN Assets

## Goal

Create a versioned, data-neutral bundle of the hostless Pan custom agent, reusable instructions, and skills for Copilot user-scope discovery.

## Requirements addressed

REQ-EXP-3, REQ-EXP-5–7, REQ-TOOL-5–8, REQ-REL-7–9

## Background

`.github/agents/pan.agent.md` currently declares only PAN MCP tools and explicitly forbids shell, arbitrary filesystem, and direct GitHub operations. Hostless PAN instead uses ordinary built-in file/git/shell/GitHub capabilities for normal work and deterministic `pan` commands for safety-critical mechanics. The private domain must not receive copied PAN product files.

Tasks 1–3 define every deterministic helper contract the agent will invoke.

## Files to modify/create

- `assets/copilot/agents/pan.agent.md` — hostless generic Pan identity.
- `assets/copilot/instructions/pan.instructions.md` — shared domain, authority, evidence, and scheduling instructions.
- `assets/copilot/skills/pan-portfolio/SKILL.md` — review/reconciliation workflow.
- `assets/copilot/skills/pan-workstream/SKILL.md` — direct workstream prepare/edit/publish workflow.
- `assets/copilot/skills/pan-attention/SKILL.md` — attention and task commands.
- `assets/copilot/manifest.json` — asset versions, destinations, and hashes.
- `.github/agents/pan.agent.md` — retain only as package-development source/compatibility if needed.
- `test/pan-agent-definition.test.js` — validate the packaged hostless agent and skills.

## Implementation details

1. Define one PAN personality for interactive and scheduled turns: concise chief-of-staff communication, complete portfolio reasoning, durable evidence citations, uncertainty handling, and canonical Project ordering.
2. Permit ordinary built-in read/search/file/git/shell/GitHub capabilities, but require deterministic helpers for complete evidence, mutations, leadership, attention, reconciliation, configuration, and workstream publication.
3. State that read-only product-context roots are reference only and never another work domain or implicit self-modification authority.
4. Require a fresh `pan evidence portfolio` result before recommendations or mutation and deterministic reconciliation before model-selected changes.
5. Require mutating helper results to be reported as confirmed, rejected, incomplete, or failed without converting model intent into claimed success.
6. Include writing/read-only session behavior and native schedule instructions shared by interactive and scheduled turns.
7. Keep all examples generic and free of private repository names, user identities, credentials, or machine paths.
8. Generate or validate a manifest whose hashes cover every distributed asset.

## Testing suggestions

- Rewrite `test/pan-agent-definition.test.js` to inspect the packaged asset tree, required headings/invariants, helper command references, and absence of MCP-only restrictions.
- Validate every manifest path and hash.
- Verify no private identifiers or absolute user paths appear in any asset.

## Gotchas

- Tool availability is not authority.
- Do not embed domain-specific configuration or copy workstream content into assets.
- Docstrings/instructions should state intent rather than restating every implementation condition.

## Verification checklist

- [ ] Agent, instructions, and skills describe the same hostless authority model.
- [ ] Deterministic mutations route through documented helper commands.
- [ ] Product context remains explicitly read-only.
- [ ] Manifest covers every asset and contains no private data.
- [ ] Integration tests: `test/pan-agent-definition.test.js`.
