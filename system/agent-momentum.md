# Agent momentum

Agent momentum is a chief-owned portfolio scan between Daily Briefings. It
uses the same complete live read and business judgment as triage.

Assess every eligible nonterminal task for useful agent help. Dates, priority,
work Status, and missing session ID do not filter discovery. Read live
playbooks, task text, comments, workstream context, and saved session state.
Future-dated, undated, unlabeled, and sessionless tasks remain candidates.

For each task, decide one of:

- request new session;
- request saved session;
- already requested or running;
- propose a request that needs approval;
- blocked by a named missing fact or decision;
- waiting for an external event;
- explicitly held; or
- no useful bounded agent contribution.

This disposition is working reasoning, not a task field. Record durable
dependencies, holds, approvals, or decisions in task text or comments when
authorized.

Requesting help means setting `agentStatus=requested`. It does not change work
Status, promise an immediate launch, or grant authority beyond the task,
playbook, and Domain instructions. The runner launches every request unless it
already manages that same task.

A saved session ID alone is not running. `agentStatus=running` means the runner
observes its managed process open, including while awaiting the user. Do not
duplicate a running request. A Done or rejected task may still be requested
when conversation or follow-up is useful.

An optional Domain cadence may wake the same chief session. The runner and
workers never own momentum schedules.
