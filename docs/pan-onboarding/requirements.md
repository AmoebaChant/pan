# Pan onboarding requirements

1. Pan should provide a dedicated **Pan Setup** agent that guides a new user
   through setup conversationally.
2. The repository README should be directly usable by an agent before Pan is
   cloned. It should introduce the setup flow, ask the user where to clone Pan,
   clone the repository, and then run one simple command:

   ```powershell
   npx --yes --package . pan onboard
   ```

3. The setup agent should explain Pan, gather the information it needs, install
   the Pan agent and Pan skills, create or connect the domain repository and GitHub
   Project, configure the local Pan session and runner, add a default Pan
   self-repair playbook that delivers through a pull request, and verify that
   setup works. It should offer to create desktop shortcuts for the Pan chat and the runner.
4. The setup agent should use Pan's deterministic commands for setup mechanics
   rather than asking the user to manually write configuration files.
5. When setup finishes, the agent should tell the user how to start Pan and the
   runner.
6. The repository README should be short and approachable:
   - explain what Pan is;
   - show the single get-started command; and
   - link to the architecture and deeper documentation.
7. Connecting an existing domain should accept its existing local checkout,
   preserve compatible domain data and runner configuration, and support
   resuming setup without restarting the conversational questionnaire.
8. The onboarding trigger should be unambiguous to an agent. When a user tells an
   agent to "onboard to Pan" or "set up Pan" — including from only the repository
   URL, before anything is cloned — the agent should recognize that as a request
   to run `pan onboard` and proceed with the guided setup, rather than reasoning
   about whether it means studying the code. This intent should be stated in the
   README and in an `AGENTS.md` that Copilot CLI auto-loads from the repository
   root, and the guidance should cover the case where the agent has only cloned
   Pan in order to read that guidance.
9. Before finishing, the setup agent should explain that playbooks are
   machine-local runner policies, that connecting an existing domain on a new
   machine does not configure that machine for the same work, and what the
   default self-repair playbook covers. It should ask whether the user wants the
   machine to handle additional work and guide those who do through the choices
   needed for a domain-bound Pan session to configure and validate the runner
   profile.
