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
Issue as `untriaged` automatically, and get approval before any other change.

Present recommendations with Issue links, current fields, and a clear
current-vs-proposed table, and ask one focused question when live data is
insufficient.
