---
name: pan-daily-briefing
description: Build and agree a daily plan from live Pan Domain state.
---

# Pan Daily Briefing

Use this for a Daily Briefing or when the user asks Pan to plan their day.

Follow [`system/daily-briefing.md`](../../system/daily-briefing.md) end to end.
Read `pan.md` first to detect a Domain-configured external human task manager.
Read the complete live Domain Issue and Project state, canonical Project order,
the entire authoritative human queue, every workstream README, and any optional
`## Daily Briefing` guidance. If the external contract is incomplete or any
required queue cannot be read completely, stop without presenting a complete
briefing or changing planning dates. Apply existing automatic reconciliations
before planning.

Recurring human tasks follow the authoritative system selected by the Domain
contract. External ownership requires complete cadence, completion,
cancellation, history, planning-field, and verification semantics. For a
GitHub-authoritative recurring task, require and verify its valid occurrence
marker before proposing a date change. After a live re-read, automatically add
only a missing first-line marker when the recurrence contract infers the
nominal date unambiguously from still-intact evidence, preserving
`next-action-date`; otherwise ask and leave the date unchanged. An unusable
existing marker and an explicit adoption whose nominal date was not stated
require user confirmation.

Before recommending the plan, automatically repair an already-terminal Project
item with a stale date by re-reading it, clearing only `next-action-date`, and
verifying it is empty. Never change terminal Status or Issue closure during
that repair.

Recommend a ranked, realistically sized plan without making discretionary date
changes. Explain the relevant human work, agent work affecting the day,
decisions, dates, dependencies, opportunities, and Domain considerations.
Iterate as the user steers, show all proposed date changes, and wait for explicit
agreement.

Only then re-read affected tasks and update human-owned tasks'
`next-action-date` values or the external system's mapped equivalent, verifying
each write. Finish only when nonterminal human dates are empty, today, or
future, and all terminal human dates are empty. Agent tasks never receive a
planning date.
