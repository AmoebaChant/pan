---
name: pan-config
description: Read and change this PAN domain's configuration (default agent model, cadences, review policy, self-repair) and this machine's runner profile (Copilot tool approval mode) through the read_config/update_config and read_runner_profile/update_runner_profile tools, and restart the host and runner so changes take effect. Use when the user asks to view or change PAN configuration, the default model, timeouts, credit caps, review policy, self-repair, or the tool approval mode.
---

# PAN configuration

Use this skill whenever the user wants to inspect or change how this PAN domain
or this machine's runner is configured. There are two surfaces, each with its
own read/update tool pair; you never edit files directly:

- **Domain config** (`pan.json`) — shared across every machine running the
  domain. Use `read_config` and `update_config`.
- **Runner profile** (`runners/<machine>.json`) — private to this machine. Use
  `read_runner_profile` and `update_runner_profile`. This is where the Copilot
  tool approval mode lives.

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

## Tool approval mode lives in the runner profile

The Copilot tool approval mode (`prompt` or `allow-all`) is a per-machine trust
decision, so it lives in this machine's **runner profile**
(`runners/<machine>.json`) at `copilot.approvalMode`, not in the domain config.
Manage it with the runner profile tools, not `update_config`:

1. Call `read_runner_profile`. It returns this machine's complete profile
   object, its file path, and a `schemaReference` pointing at
   `schema/runner-profile.json`.
2. Copy the returned `profile` object, set `copilot.approvalMode` to `prompt`
   or `allow-all` (create the `copilot` object if it is absent), and keep every
   other field exactly as it was.
3. Call `update_runner_profile` with the complete modified object in `profile`.
   It validates against the schema and rejects any invalid change without
   applying a partial edit.
4. Report what changed, then tell the user to restart `pan-runner` on this
   machine (see below).

`allow-all` is an explicit opt-in that lets Copilot run tools on this machine
without prompting. Confirm the user intends that before enabling it. Never
submit a partial profile; dropping a required field will be rejected.

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
