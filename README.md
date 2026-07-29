# Pan

Pan is a personal chief of staff that helps you navigate your workloads and
manage agents on your behalf. Your work lives in a private GitHub repository and
Project called a **domain**, and a session serves one domain at a time.

## Requirements

- Node.js 22+
- GitHub CLI (`gh`), authenticated for private repositories and Projects
- GitHub Copilot CLI, which Pan uses for setup, chat, and agent work

## Get started

```powershell
git clone https://github.com/AmoebaChant/pan.git
Set-Location .\pan
npx --yes --package . pan onboard
```

The Pan Setup agent explains the model, creates or connects your domain, installs
Pan and its skills, configures a local session and runner, and can create desktop
shortcuts. Pan runs in the foreground and stops when its session exits.

## Documentation

Read [goals](docs/goals.md), [open questions](docs/open-questions.md), and [architecture](docs/architecture.md).
Reference: [domain configuration](docs/domain-configuration.md), [runner](docs/runner.md), [triage and attention](docs/triage-and-attention.md).