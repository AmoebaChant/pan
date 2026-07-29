# Pan

Pan is a personal chief of staff for workloads and agents. Work lives in a
private GitHub repository and Project called a **domain**.

## Requirements

- Node.js 22+
- GitHub CLI (`gh`), authenticated for private repositories and Projects
- GitHub Copilot CLI, which Pan uses for setup, chat, and agent work

## Set up Pan with an agent

Ask an agent on your machine to follow this README. The agent should:

1. Introduce itself as your Pan setup guide and check the requirements above.
2. Ask where you want Pan cloned; do not choose a location without asking.
3. Clone `https://github.com/AmoebaChant/pan.git`, enter that checkout, and run:

   ```powershell
   npx --yes --package . pan onboard
   ```

Pan Setup explains domains, creates or connects yours, installs Pan's assets,
configures a pull-request self-repair playbook, verifies setup, and offers shortcuts.

## Documentation
Read [goals](docs/goals.md), [architecture](docs/architecture.md), and the [documentation](docs/).
