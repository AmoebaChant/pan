# Pan

Pan is a Markdown-defined personal chief of staff for one private Domain. The
Domain stores workstream knowledge, playbooks, instructions, and one selected
task backend. This public repository contains reusable contracts, backend
adapters, agents, and a small task/session runner.

Start at [`system/overview.md`](system/overview.md).

## Task API

```sh
node bin/pan-task.js --config <backend.json> list
node bin/pan-task.js --config <backend.json> update <id> \
  --input '{"agentStatus":"requested"}'
node bin/pan-task.js --config <backend.json> update <id> \
  --input '{"nextStep":"PR published - ready for review"}'
node bin/pan-task.js --config <backend.json> comment <id> \
  --input '{"content":"Progress update"}'
```

GitHub and Todoist expose the same work and session contract. Work Status is
`open|done|rejected`; Agent status is empty, `requested`, or `running`; session
IDs persist independently; and optional `nextStep` text is descriptive only.
Start from
[`bin/example-task-backend.json`](bin/example-task-backend.json).

## Runner

`pan-runner` and `pan-backend-runner` invoke the same implementation:

```sh
node bin/pan-runner.js --config <runner.json> [--once|--dry-run]
node bin/pan-runner.js --config <runner.json> --inspect-playbooks
```

The runner opens or resumes explicit requests and supervises only processes it
launched. It does not decide readiness, completion, dependencies, approvals,
dates, ownership, or workspace policy. See [`system/runner.md`](system/runner.md).
[`bin/example-config.json`](bin/example-config.json) shows the runner config.
Tasks without an assigned playbook use Pan's general default. A missing named
playbook never silently falls back.

## Chief and worker

`pan-chief` is the persistent Domain coordinator. `pan-worker` executes one
task. Business judgment remains in their Markdown instructions, task comments,
workstreams, and playbooks.

## Requirements

- Node.js 22+
- authenticated GitHub CLI for GitHub-backed Domains
- GitHub Copilot CLI for chief and worker sessions

Run `npm test` for repository validation.
