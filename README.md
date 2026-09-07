# Pan

Pan is a personal chief of staff for your workloads and your agents. It tracks
everything you and your agents owe, decides what's next, keeps always-on
machines supplied with work, and gets blocked agents back in front of you fast.

Pan is defined almost entirely in Markdown. The contracts under
[`system/`](system/overview.md) *are* the system — an agent that follows them is
Pan. Its only programs are a small [runner](system/runner.md) that polls for
work and launches Pan worker sessions, and an optional local
[Daily Briefing review service](system/briefing-ui.md).

- Your data lives in a private GitHub repository + Project called a **Domain**.
- This public repository holds only the reusable system and holds no user data.

Start at [`system/overview.md`](system/overview.md).

## Onboard to Pan

**"Onboard to Pan" or "set up Pan" means running the guided setup** — not
reading the code. Ask an agent on your machine (GitHub Copilot CLI) to follow
[AGENTS.md](AGENTS.md); it launches the setup guide
[`.github/agents/pan-setup.agent.md`](.github/agents/pan-setup.agent.md), which
creates or connects your Domain, sets up the Project fields, records this
machine's playbooks, and gets a runner going. It confirms every choice first.

## Running the runner

Each machine runs one runner that claims ready work matching its playbooks and
launches headed worker sessions:

```sh
node bin/pan-runner.js --config <path-to-local-config> [--once]
```

See [`system/runner.md`](system/runner.md) for the full contract.

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
[project schema](system/project-schema.md), [triage](system/triage.md),
[Daily Briefing](system/daily-briefing.md),
[recurrence](system/recurrence.md), [workstreams](system/workstreams.md),
[playbooks](system/playbooks.md),
[runner](system/runner.md),
[worker base instructions](system/worker-base-instructions.md), and
[self-improvement](system/self-improvement.md).
