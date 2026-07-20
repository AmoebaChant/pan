# Task 1.4: Generic PAN Agent

## Goal

Create the repository-level custom-agent definition that supplies PAN's reusable personality, reasoning standards, responsibilities, authority framing, and constrained tool vocabulary for both autonomous and interactive turns.

## Requirements addressed

REQ-DOM-2–3, REQ-ADV-1–7, REQ-SEC-1

## Background

Task 1.1 proved how the installed Copilot CLI selects a repository custom agent. Task 1.2 defined structured turn/action records. PAN must be a trusted chief of staff that gives a recommendation, distinguishes facts from inference, cites durable evidence, challenges contradictions, and remains concise and warm. The definition must not contain a repository name, workstream path, user identity, machine path, credential, live state, or private example.

## Files to modify/create

- `.github/agents/pan.agent.md` — the generic PAN custom-agent definition using the exact discovery/metadata format proven in Task 1.1.
- `test/pan-agent-definition.test.js` — structural checks for required sections, genericity, and allowed tool names.
- `README.md` — identify the shipped PAN agent and its relationship to the runtime.

## Implementation details

1. Define PAN's purpose, decision-focused tone, complete-portfolio obligation, evidence/citation rules, uncertainty handling, and willingness to challenge priorities.
2. State that autonomous and interactive turns use the same identity and standards.
3. Require explicit classification of every Project item, including completed, blocked, leased, or otherwise non-candidate work.
4. Require output through the Task 1.2 protocol and actions only through named PAN operations.
5. Prohibit unrestricted shell, arbitrary filesystem, direct GitHub mutation, cross-domain knowledge, second queues, unsupported certainty, and conversation-only durable state.
6. Include authority guidance: read/recommend/dry-run freely; only propose mutations; runtime policy validates and applies them.
7. Test for accidental private paths, known fixture owner/repository names, and broad tool grants.

## Testing suggestions

- `node --test test/pan-agent-definition.test.js`
- Use the Task 1.1 fixture to confirm the actual agent can be selected.
- `npm test`

## Gotchas

- Do not duplicate detailed implementation algorithms in the agent prompt; state intent and invariants.
- Do not give the agent a general `gh`, shell, or file-write tool.
- Do not create separate autonomous and chat personalities.

## Verification checklist

- [ ] The custom agent is selectable by the proven CLI mechanism.
- [ ] The same definition covers review and chat.
- [ ] Only generic PAN operations are advertised.
- [ ] Targeted tests and `npm test` pass.
