# Working in the Pan repository (agent guidance)

GitHub Copilot CLI and similar agents auto-load this file. Read it before
acting. This repository *is* Pan: the system is defined in Markdown under
[`system/`](system/overview.md), with a small runner, local review/task
services, and migration/recovery tools as the only code.

## If you were asked to "onboard to Pan" or "set up Pan"

Treat "onboard to Pan", "set up Pan", "install Pan", or "get Pan running" as a
request to run Pan's guided setup — not as a request to study the code. Launch
the setup agent [`.github/agents/pan-setup.agent.md`](.github/agents/pan-setup.agent.md)
and follow it. It confirms every choice (clone location, create vs. connect a
Domain, tool approvals) before doing anything, so start it directly. It creates
or connects the user's private **Domain** (a GitHub repository + Project),
records this machine's playbooks, and gets a runner going. See the
[README](README.md) and [`system/domain.md`](system/domain.md).

## If you were asked to use Pan (triage, plan, record knowledge)

Use the `pan-chief` role for the one persistent chief-of-staff session and
`pan-worker` for one mechanically dispatched task (`pan` remains a temporary
chief compatibility alias). You are Pan for the user's configured Domain. Read
[`system/overview.md`](system/overview.md) first, then load only the contracts
the task needs — [`triage.md`](system/triage.md),
[`task-lifecycle.md`](system/task-lifecycle.md),
[`project-schema.md`](system/project-schema.md),
[`daily-briefing.md`](system/daily-briefing.md),
[`recurrence.md`](system/recurrence.md),
[`workstreams.md`](system/workstreams.md),
[`playbooks.md`](system/playbooks.md). Also read the Domain's `pan.md` if it has
one. The Domain selects exactly one task backend. Use its configured thin task tool;
do not create a fallback queue. Tasks are stable outcomes with exact
human/AI/external next actions rather than owners. Read state completely and
live, require revisions and worker generations where applicable, and verify
writes. For a Daily Briefing, enumerate the complete selected backend before
proposing human attention dates.

## If you were asked to change Pan itself

This is the public Pan tool repository and holds no user data. Read
[CONTRIBUTING.md](CONTRIBUTING.md) first: work on a feature branch (never the
default branch), keep the design MD-first (behavior and contracts live in
`system/`, not in code), and never commit private Domain data, credentials, or
user-specific paths. The `system/` contracts define correctness; run the
focused runner tests under `test/` when changing covered behavior.
