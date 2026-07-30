# Pan

Pan is a personal chief of staff for workloads and agents. Work lives in a
private GitHub repository and Project called a **domain**.

## Onboard to Pan

**"Onboard to Pan" or "set up Pan" means running this guided setup** — even when
the request is just this repository's URL and nothing is cloned yet. Don't
reinterpret it as reading the code; the setup confirms every choice, so start it
directly. Agents: see [AGENTS.md](AGENTS.md).

Ask an agent on your machine to follow this README. The agent should:

1. Introduce itself as your Pan setup guide and check the requirements below.
2. Ask where you want Pan cloned; do not choose a location without asking.
3. Clone `https://github.com/AmoebaChant/pan.git`, enter that checkout, and run:

   ```powershell
   npx --yes --package . pan onboard
   ```

Pan Setup explains domains, creates or connects yours, installs Pan's assets,
configures a pull-request self-repair playbook, verifies setup, and offers shortcuts.
It also explains that playbooks are configured per machine and guides you
through adding the kinds of work you want this machine to handle.

## Requirements

- Node.js 22+
- GitHub CLI (`gh`), authenticated for private repositories and Projects
- GitHub Copilot CLI, which Pan uses for setup, chat, and agent work

## Documentation
Read [goals](docs/goals.md), [architecture](docs/architecture.md), and the [documentation](docs/).
