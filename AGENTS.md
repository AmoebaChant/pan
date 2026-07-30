# Working in the Pan repository (agent guidance)

GitHub Copilot CLI and similar agents auto-load this file from the repository
root. Read it before acting.

## If you were asked to "onboard to Pan" or "set up Pan"

Treat any of these as a request to run Pan's guided setup — **not** as a request
to study, summarize, or familiarize yourself with the code:

- "onboard to Pan"
- "set up Pan" / "install Pan" / "get Pan running"
- "onboard me to Pan, the repo is here: `<url>`"

This can begin on a fresh machine that has only the GitHub Copilot CLI, before
this repository is cloned. Proceed without extended deliberation:

1. If Pan is not already cloned locally, ask the user where they want it, then
   `git clone https://github.com/AmoebaChant/pan.git` there. If you already
   cloned it somewhere just to read this file, confirm that location is fine (or
   move it) before continuing.
2. From that checkout, run the guided setup:

   ```powershell
   npx --yes --package . pan onboard
   ```

3. `pan onboard` launches Pan's conversational `pan-setup` agent. It confirms
   every choice — clone location, create vs. connect a domain, and tool
   approvals — before doing anything. So start it directly rather than asking
   whether "onboard" meant something else, and rather than pausing over its side
   effects; it will ask.

`pan onboard` installs Pan's Copilot assets and then creates or connects the
user's private **domain** repository and GitHub Project, configures the local
session and runner, adds the default pull-request self-repair playbook, verifies
the result, explains that playbooks are configured per machine, guides the user
through adding work for this machine, and offers desktop shortcuts. The
[README](README.md) is the canonical summary.

If you cannot drive a nested interactive `copilot` session (for example, you are
a non-interactive agent), act as the setup guide yourself: follow
[`.github/agents/pan-setup.agent.md`](.github/agents/pan-setup.agent.md) and run
the deterministic `pan setup`, `pan verify`, and `pan shortcuts create` commands,
asking the user each question that agent would ask.

## If you were asked to change Pan itself

This is the public Pan tool repository. Read [CONTRIBUTING.md](CONTRIBUTING.md)
first. In short: work on a feature branch or worktree (never the default
branch), run `npm test` before submitting, and never commit private
workstreams, runner state, credentials, or user-specific paths.
