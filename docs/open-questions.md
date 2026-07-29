# Pan open questions

Design decisions that are genuinely unresolved. Each one blocks or shapes a
[product goal](goals.md). This file is for questions Pan's own design has to
answer, not for backlog items — those are Issues in a domain.

## 1. How does Pan reach the user when it is not running?

*Blocks: goal 4 (unblock agents fast), and the always-on ambition.*

**Today.** Pan is a foreground session. A worker that needs an answer posts it
to its Issue, sets `needs-human-since`, and then waits in its own terminal,
holding its lease and its concurrency slot until someone walks to that machine.
Nothing pages them. An agent blocked at 9am is still blocked at 5pm, and its
slot is unavailable for that whole day.

**Undecided.** Who owns the notification channel — Pan, the runner, or GitHub's
own notifications? What is urgent enough to interrupt a human, versus what waits
for the next session? The intended direction is a Teams connector that both
notifies the user and lets them answer the waiting worker without going to its
machine, which makes the channel bidirectional rather than a notifier. A
previous design used a resident host service and was deliberately removed, so
restoring always-on behavior needs a different answer rather than a revival of
that one.

A related unknown: a waiting worker currently holds its slot indefinitely by
design. That is correct while the human is the bottleneck, but nothing yet
decides when an unanswered question should stop consuming capacity.

## 2. What may Pan change without asking?

*Shapes: goal 2 (reason about what is next).*

**Today.** Every mutation requires approval unless the user asked for that
specific change. A chief of staff that asks permission for each field write adds
friction to exactly the work it is meant to absorb.

**Undecided.** Is there an allow-list of low-risk changes — reordering within a
priority, filling an empty workstream field — that Pan applies and reports
afterward? Is trust granted per session, per field, or per confidence level?
Silent reordering of the user's own precedence is the failure mode to avoid.

## 3. How does workstream narrative actually influence ranking?

*Shapes: goal 5 (keep knowledge current and use it).*

**Today.** The Project's `workstream` field holds a path. The narrative itself is
Markdown that Pan may read. Nothing says when Pan must read it, or what weight
it carries against an explicit priority.

**Undecided.** Can narrative evidence override a stated priority, or only
explain one? How should Pan treat narrative that has not been updated in weeks —
as current state, or as a stale claim to re-verify?

## 4. How does Pan help the human execute, not just rank?

*Shapes: goal 1 (track all the work).*

**Today.** Runners consume the agent queue end to end. The human queue gets
ordered and then nothing happens to it. Pan produces a recommendation and the
user is on their own.

**Undecided.** Does Pan follow up on human work — reminders, time blocking,
noticing an item that has been top-ranked and untouched for a week? Or is
ranking the whole job, and follow-through belongs to the human?

## 5. How do runners coordinate beyond leases?

*Shapes: goal 3 (keep runners supplied).*

**Today.** Leases stop two runners from claiming the same task, and capacity is
configured per profile. That is the whole coordination model.

**Undecided.** What happens to ready work that no online machine has a playbook
for — does it stall silently, or become human attention? Should a task type with
expensive setup get affinity to the machine that already has it warm? How does
the user see fleet state at all?

## 6. What does explicit cross-domain work look like?

*Shapes: the multi-domain ambition.*

**Today.** One session, one domain. Work and personal backlogs cannot be seen
together, even though the user is a single person with one finite week.

**Undecided.** Is a second domain attached read-only for context, is there a
combined view above both Projects, or does Pan simply answer questions about the
other domain on request? Implicit blending stays a non-goal in every option.

## 7. How do we protect invariants a refactor can silently rewrite?

*Shapes: delivery confidence.*

**Today.** Automated tests are maintained again. `npm test` runs before a
change, an assertion is updated in the same change that invalidates it, and the
suite favors contracts over exact prose. All 206 active tests run in under seven
seconds, so cost is not the constraint.

**Undecided.** Some invariants live on both sides of a mechanical edit and so
survive no test. A repository-wide rename recently rewrote
`legacyNames: ["Start PAN Chat.lnk"]` into the very name it exists to clean up,
and repointed `%LOCALAPPDATA%\PAN\` at a fresh directory that would have orphaned
every runner profile and session file. Both passed the suite, because the sweep
edited the assertion and the code together; a human reading the diff caught
them. What guards this class — compatibility fixtures pinned to literal legacy
values, a golden list of on-disk paths, or something else?

The same hazard reaches test doubles. When the store's attention transition was
rewritten, the runner's `FakeStore` still implemented the old one, so two tests
kept passing while asserting field changes the real store no longer made. A fake
that encodes a contract is a second copy of it, and nothing checks the two
agree.
