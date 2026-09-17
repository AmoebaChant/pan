# Task and session model

A task records work. A session is a persistent conversation that may help with
that task. They have separate state.

## Work status

- `open` — the work remains open.
- `done` — the work was completed.
- `rejected` — the work was declined, abandoned, duplicated, or not planned.

GitHub's native close reason remains the detailed history. Todoist preserves
the rejected meaning in its small visible metadata block.

Chief and worker instructions decide when to edit work status. The runner
never changes it. A comment, process exit, session request, or session release
never implies a work-status transition.

## Agent status

- empty — no session is requested or known open;
- `requested` — open or resume this task's session; and
- `running` — the runner actually started the session process.

The saved session ID remains after Agent status is cleared. Requesting a task
with no saved ID creates and records one. Requesting a task with a saved ID
resumes that same session. Requesting is valid for open, done, and rejected
tasks.

Changing work status, including to Done, does not stop a running session or
clear Agent status. A blank Agent field is not a stop request; while its
managed process remains open, the runner restores the observed `running`
value. Actual process closure clears Agent status. An explicit user or
playbook-directed early close uses the runner's release control file. Neither
closure path deletes the session ID or edits work status.

## Business decisions

Priority, dependencies, approvals, holds, reviews, completion evidence, and
delivery procedures are judgments expressed in task text, comments,
workstreams, Domain instructions, and playbooks. They are not runner
eligibility fields.

Read live state before a write, apply only the intended fields, surface API
errors, and verify the result. Do not create a parallel revision, projection,
or transition protocol.
