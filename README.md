# Pan

Pan is a personal chief of staff for your workloads and your agents. It tracks
everything you and your agents owe, decides what's next, keeps always-on
machines supplied with work, and gets blocked agents back in front of you fast.

Pan is defined almost entirely in Markdown. The contracts under
[`system/`](system/overview.md) *are* the system — an agent that follows them is
Pan. Its programs are a small [runner](system/runner.md) that polls for work and
launches Pan worker sessions, an optional local
[Daily Briefing review service](system/briefing-ui.md), an everyday task UI,
and idempotent migration/recovery tools.

- Your data lives in a private GitHub repository + Project called a **Domain**.
- This public repository holds only the reusable system and holds no user data.

Start at [`system/overview.md`](system/overview.md).

Pan ships two role bootstraps: `pan-chief` is the one persistent Domain
chief-of-staff session, while `pan-worker` executes one runner-selected task.
The older `pan` agent is a temporary compatibility alias for `pan-chief`.

Start or resume the chief without embedding backend details in its prompt:

```sh
pan-chief start --config /absolute/path/to/machine-binding.json
pan-chief resume --config /absolute/path/to/machine-binding.json
```

## Onboard to Pan

**"Onboard to Pan" or "set up Pan" means running the guided setup** — not
reading the code. Ask an agent on your machine (GitHub Copilot CLI) to follow
[AGENTS.md](AGENTS.md); it launches the setup guide
[`.github/agents/pan-setup.agent.md`](.github/agents/pan-setup.agent.md), which
creates or connects your Domain, sets up the Project fields, records this
machine's playbooks, and gets a runner going. It confirms every choice first.

## Running the runner

Each machine runs one runner that claims explicitly authorized
`ready-for-ai` work matching its playbooks and launches headed worker sessions:

```sh
node bin/pan-runner.js --config <path-to-local-config> [--once]
```

The experimental Todoist-backed pilot uses
`node bin/pan-backend-runner.js --config <path>`. Its normal configuration
loads the machine's live Domain playbooks and always launches `pan-worker`.

See [`system/runner.md`](system/runner.md) for the full contract.

## Everyday task UI

Try the public-safe fixture first:

```sh
node bin/pan-tasks.js --demo
```

Live mode requires explicit checkout and machine config bindings:

```sh
node bin/pan-tasks.js --config /absolute/path/to/config.json --checkout "$PWD"
```

The responsive UI provides Today, Needs me, In motion, Recent activity, and All
tasks without exposing GitHub credentials to the browser. See
[`system/briefing-ui.md`](system/briefing-ui.md).

## Todoist migration

`bin/pan-todoist-migrate.js` snapshots, plans, applies, verifies, and prepares
pilot recovery mappings without deleting source tasks or history. See
[`system/todoist-migration.md`](system/todoist-migration.md).

Lifecycle cutover is deliberately separate and writer-exclusive. Stop every
runner, task UI, briefing session, and other Project writer; save a baseline
plan; review an explicit per-item authorization file that matches each approved
agent task's playbook and dependency text; then apply:

```sh
node bin/pan-lifecycle-migrate.js plan \
  --config /absolute/path/to/config.json --checkout "$PWD" \
  --authorization /absolute/path/to/authorization.json \
  --report /absolute/path/to/baseline.json
node bin/pan-lifecycle-migrate.js apply \
  --config /absolute/path/to/config.json --checkout "$PWD" \
  --authorization /absolute/path/to/authorization.json \
  --confirm-writers-stopped \
  --report /absolute/path/to/cutover.json
node bin/pan-lifecycle-migrate.js plan \
  --config /absolute/path/to/config.json --checkout "$PWD" \
  --authorization /absolute/path/to/authorization.json \
  --report /absolute/path/to/current-state.json
node bin/pan-lifecycle-migrate.js rollback-plan \
  --config /absolute/path/to/config.json --checkout "$PWD" \
  --report /absolute/path/to/rollback.json
node bin/pan-lifecycle-migrate.js rollback-apply \
  --config /absolute/path/to/config.json --checkout "$PWD" \
  --confirm-writers-stopped \
  --report /absolute/path/to/rollback-result.json
```

The authorization document is
`{"format":"pan-lifecycle-migration-authorization","version":1,"items":[...]}`;
each item contains exact `itemId`, `playbook`, `dependencies`, and
`"executionAuthorized":true`. Legacy ownership alone never authorizes AI.
Version 1 also accepts exact `verifiedHumanCheckpoint` and
`verifiedDeliberateHold` entries that explicitly deny execution and attest
verified process death and stopped writers; see the complete schema in
[`system/todoist-migration.md`](system/todoist-migration.md). An expired lease
alone is not death evidence. Unapproved retained sessions remain held for
operator reconciliation. Closed terminal machine/session provenance predating
claim generations is preserved as non-runnable history. Rollback is generated
only from current live pilot state, checks the complete Issue/Project projection
again before every write, preserves dates, playbooks, dependencies,
worker/session evidence, Issue text, comments, and recurrence progress, and
changes only the retained legacy `owner`/`Status` projection plus revision
history. It refuses active, uncertain, stale, or externally inconsistent items.
The equivalent
`pan-todoist-migrate recovery-plan` / `recovery-apply` commands are available
for the Todoist migration workflow. Never replay stale baseline state.

## Local Daily Briefing UI

Pan includes an optional responsive review page for marking up a complete Daily
Briefing proposal and sending one batch of feedback back to the Pan session.
It is served by a local MCP process and keeps no database:

```sh
node bin/pan-briefing-mcp.js --demo
```

That safe fixture mode is available at `http://127.0.0.1:4319/` and does not
connect to Copilot or any live task system. For MCP-backed use, save the
following as checkout-local `.mcp.json`:

```json
{
  "mcpServers": {
    "pan-briefing": {
      "type": "stdio",
      "command": "node",
      "args": ["bin/pan-briefing-mcp.js"],
      "tools": ["*"],
      "timeout": 43200000
    }
  }
}
```

The live page is available at `http://127.0.0.1:4318/` while a Copilot session
in this checkout is using the MCP server. See
[`system/briefing-ui.md`](system/briefing-ui.md).

## Requirements

- Node.js 22+
- GitHub CLI (`gh`), authenticated for private repositories and Projects
- GitHub Copilot CLI, which Pan uses for setup, chat, and worker sessions

## Documentation

The system is the documentation. Read [`system/overview.md`](system/overview.md)
and the contracts it links: [domain](system/domain.md),
[outcome task lifecycle](system/task-lifecycle.md),
[project schema](system/project-schema.md), [triage](system/triage.md),
[Daily Briefing](system/daily-briefing.md),
[recurrence](system/recurrence.md), [workstreams](system/workstreams.md),
[playbooks](system/playbooks.md),
[runner](system/runner.md),
[worker base instructions](system/worker-base-instructions.md), and
[self-improvement](system/self-improvement.md).
