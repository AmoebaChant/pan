---
name: pan-portfolio
description: Review and triage a Pan portfolio directly from live GitHub Issues and Project state.
---

# Pan portfolio review

Use this for portfolio review, next-work recommendations, Project triage,
ordering, or completion checks.

Follow [`system/triage.md`](../../system/triage.md) end to end, using
[`system/project-schema.md`](../../system/project-schema.md) for fields and
[`system/playbooks.md`](../../system/playbooks.md) to choose a `playbook` for
each agent task. Read live from GitHub with `gh`, read the complete Issue and
Project item sets (fail closed on possible truncation), register every missing
Issue as `untriaged` automatically except eligible human work whose
external-manager migration receipt and reciprocal live record verify under the
Domain contract. Classify conclusive agent ownership and mandatory
GitHub-retained classes before consulting receipts; always register those
tasks. Recurring human tasks follow the authority selected by the Domain
contract; keep them in GitHub when external recurrence semantics are incomplete.
Fail closed on ambiguous migration evidence only for work that could
legitimately have migrated. Complete only `in-review` tasks whose recorded PR
is confirmed merged, and reconcile closed GitHub-authoritative recurring Domain
Issues from their live closure reason and occurrence markers. Also clear only
a stale `next-action-date` from an already-terminal item after a live re-read,
and add only an unambiguous missing first-line marker to an open recurring
Issue while preserving its date; verify both automatic repairs and ask on
ambiguous marker inference. For every terminal transition, clear and verify
`next-action-date` first, verify the matching Issue closure, and make terminal
`Status` the final Project write of the transition. Always target the Project
item's content repository, and get approval before any other change.

Present recommendations with Issue links, current fields, and a clear
current-vs-proposed table, and ask one focused question when live data is
insufficient.
