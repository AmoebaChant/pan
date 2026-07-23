# PAN

PAN is a personal chief of staff that helps you navigate your workloads and
manage agents on your behalf. Your work and tasks live in a private GitHub
repository and Project called a **domain**, and you can use separate domains for
areas such as work and personal life.

## Requirements

- Node.js 22+
- GitHub CLI (`gh`), authenticated with access to private repositories and Projects
- GitHub Copilot CLI, which PAN uses for setup, chat, and agent work

## Get started

```powershell
git clone https://github.com/AmoebaChant/pan.git
Set-Location .\pan
npx --yes --package . pan onboard
```

The Pan Setup agent explains the model, creates or connects your domain,
installs Pan and the PAN skills, configures a local session and runner, verifies
the result, and can create desktop shortcuts.

PAN runs in the foreground; nothing continues after its session exits. Learn
more in the [architecture](docs/architecture.md), [domain configuration](docs/domain-configuration.md),
[runner guide](docs/runner.md), and [triage and attention guide](docs/triage-and-attention.md).
