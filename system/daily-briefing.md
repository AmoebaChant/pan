# Daily Briefing

The Daily Briefing turns complete live Domain state into one agreed human plan
and one explicit agent-session plan.

## Complete review

Fully paginate the selected backend, read optional Domain instructions,
workstreams, comments, saved session IDs, Agent status, and live playbooks.
Consider every eligible task deeply enough to decide whether it should receive
human attention or agent help.

Dates, priority, current Status, and missing session ID may affect the
recommendation but never define the candidate set. Future-dated and unscheduled
tasks must be reconsidered alongside today and overdue work.

## Proposal

For each surfaced task, distinguish independent effects:

- work Status change, if any;
- `humanDateAction=keep|set|clear`;
- planning fields or durable guidance;
- `agentAction=none|request-new|request-resume`; and
- the business reason recorded in task text or a comment.

`request-new` and `request-resume` both write `agentStatus=requested`; the saved
session ID determines which occurs. A queued request is not a launch.
`agentStatus=running` means the session process is open, including while it
awaits the user.

Do not infer a permanent human/agent owner. A task may need human work while
its agent session remains open. A Done task may still benefit from reopening
its saved session. Completing a task never implies session closure. When the
user wants an active session closed, direct that session explicitly rather than
using blank Agent metadata as a command.

## Agreement and apply

The first proposal is read-only except standing-authorized objective
reconciliation. Obtain explicit agreement for discretionary date, status, guidance, and
session-request effects.

After agreement:

1. re-read the complete task set and each affected task;
2. write durable guidance/comments first;
3. apply only the agreed task fields and Agent status;
4. leave every `keep` and omitted task unchanged; and
5. re-read and report confirmed results.

If a write fails, stop and report the confirmed partial result. Do not add a
recovery state or return a success-shaped fallback.
