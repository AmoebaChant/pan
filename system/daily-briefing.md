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

Follow [Triage's efficient live review](triage.md#efficient-live-review).
Complete-backlog consideration must remain thorough, but evidence gathering
should be limited to what supports the day's human plan and agent recommendations.

## Proposal

Present the first useful proposal promptly once the complete portfolio has been
considered and its recommendations are supported. Do not turn a briefing into an
exhaustive audit, worker implementation, or investigation of every blocker before
showing the plan. Keep uncertain outcomes explicitly unresolved instead of
delaying the whole proposal or making unsupported completion claims.

Describe proposed worker requests in terms of the task outcome and scope, not
just "research." Distinguish investigation, implementation, human review, and
publication or delivery approval. When the user wants progress or completion,
explain what the proposed worker would advance and where it must stop.

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

Approval of the human plan is not approval to start agents. If the user excludes
agent starts, apply only approved planning changes and guidance; do not write
`agentStatus=requested`, launch workers, or replace an existing session.

After agreement:

1. re-read the complete task set and each affected task;
2. write durable guidance/comments first;
3. apply only the agreed task fields and Agent status;
4. leave every `keep` and omitted task unchanged; and
5. re-read and report confirmed results.

If a write fails, stop and report the confirmed partial result. Do not add a
recovery state or return a success-shaped fallback.

## Review feedback

Submitted feedback is direct user instruction, like chat. Interpret the full
feedback, not just the binary selection. Clear instructions require no second
approval; explicit dates take precedence over a binary scheduling choice.
Resolve relative dates in the briefing's local timezone and review context.
The reviewed Domain instructions may define binary defaults (for example,
where to move an occurrence when Today is declined); do not impose a personal
Domain's defaults on all Domains. Ask for clarification when the intended
effect is genuinely unclear, not for justification of a clear choice.

Binary scheduling choices alone change only scheduling. They do not authorize
worker requests or session closure. Explicit work outcomes are independent of
Agent status. "Mark done" authorizes done; a request to discard unneeded work
may use a supported history-preserving rejected outcome rather than destructive
deletion. Record the user's instruction without claiming the work was executed.
Preserve native recurrence when moving an occurrence; never clear recurring
dates. Unanswered cards remain unchanged.

Use the dedicated review tool for supported effects. If it cannot express a
clear authorized effect, persist guidance first, then use normal common task
tools with live scope checks, intended-field-only writes, and verification.
Record the actual confirmed result in the review; tool limitations do not
remove user authorization. Save interpreted effects and confirmed partial
results for idempotent retry, and stop on failure. Do not replay historical
reviews automatically. Only genuinely new alternatives require fresh approval
and remain unapplied.
