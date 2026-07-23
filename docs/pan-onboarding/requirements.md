# PAN onboarding requirements

1. PAN should provide a dedicated **Pan Setup** agent that guides a new user
   through setup conversationally.
2. From a local checkout, getting started should require one simple command:

   ```powershell
   npx --yes --package . pan onboard
   ```

3. The setup agent should explain PAN, gather the information it needs, install
   the Pan agent and PAN skills, create or connect the domain repository and GitHub
   Project, configure the local PAN session and runner, and verify that setup
   works. It should offer to create desktop shortcuts for the Pan chat and the runner.
4. The setup agent should use PAN's deterministic commands for setup mechanics
   rather than asking the user to manually write configuration files.
5. When setup finishes, the agent should tell the user how to start PAN and the
   runner.
6. The repository README should be short and approachable:
   - explain what PAN is;
   - show the single get-started command; and
   - link to the architecture and deeper documentation.
7. Connecting an existing domain should accept its existing local checkout,
   preserve compatible domain data and runner configuration, and support
   resuming setup without restarting the conversational questionnaire.
