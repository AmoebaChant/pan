---
name: pan-config
description: Read and change this PAN domain's configuration (default agent model, cadences, review policy, self-repair) through the read_config and update_config tools, and restart the host and runner so changes take effect. Use when the user asks to view or change PAN configuration, the default model, timeouts, credit caps, review policy, self-repair, or the tool approval mode.
---

# PAN configuration

Use this skill whenever the user wants to inspect or change how this PAN domain
is configured. You act only through the `read_config` and `update_config` tools;
you never edit files directly.

## Procedure

1. Call `read_config`. It returns the current domain config object, its file
   path, and a `schemaReference` pointing at `schema/domain-config.json`.
2. Copy the returned `config` object, change only the fields the user asked
   about, and keep every other field exactly as it was.
3. Call `update_config` with the complete modified object in `config`. It
   validates against the schema and rejects any invalid change without applying
   a partial edit.
4. Report what changed, then tell the user the change is saved but requires a
   restart (see below). You cannot restart the host or runner yourself.

Never submit a partial config. Dropping a required field will be rejected.

## Config file shape

The domain config (`pan.json`) connects one PAN runtime to one repository and
Project. It contains no credentials. The full contract lives in
`schema/domain-config.json` and `docs/domain-configuration.md`.

```json
{
  "version": 1,
  "domain": {
    "repository": "owner/domain",
    "projectOwner": "owner",
    "projectNumber": 12,
    "path": "C:\\domains\\domain"
  },
  "state": { "branch": "pan-state", "path": ".pan" },
  "agent": { "name": "pan", "model": "gpt-5.6-sol" }
}
```

## Settings you are commonly asked to change

- `agent.model` — default Copilot model for autonomous reviews and
  `pan connect`. Omit it to fall back to `auto`. A single interactive session
  can still override it with `pan connect --model <id>` or `/model`.
- `agent.turnTimeoutSeconds`, `agent.maxAiCredits` — optional safeguards; omit
  to pass no turn timeout or credit cap.
- `cadences.*` — polling, review, lease, and retry intervals in seconds.
- `reviewPolicy.higherRisk` — disabled unless `enabled: true` with an explicit
  `actionKinds` list.
- `selfRepair` — disabled unless `enabled: true` with a repository, workstream,
  and requirements.

## Tool approval mode is not in this config

The Copilot tool approval mode (`prompt` or `allow-all`) lives in the **private
runner profile** (`runners/<machine>.json`), not the domain config, so
`update_config` cannot change it. If the user asks to change it, explain that
they must edit the runner profile's approval field (or re-run `pan setup` for a
new domain) and restart the runner. `allow-all` is an explicit opt-in.

## Restart after a change

Configuration changes take effect only when the host and runner restart. There
is no supervisor, so the user must restart them:

```powershell
pan stop --config <path-to-domain-config.json>
pan start --config <path-to-domain-config.json>
# restart the runner in its terminal (Ctrl+C, then relaunch):
pan-runner --profile <path-to-runner-profile.json>
```

Give the user these commands with their actual config and profile paths after a
successful `update_config`.
