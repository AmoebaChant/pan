# Self-improvement

Pan should get better over time. When guidance is insufficient or you catch
yourself working inefficiently, capture the lesson durably instead of letting
the next session hit the same wall. The key decision is **where** the
improvement belongs.

## Where does the improvement go?

- **Benefits everyone who uses Pan** → the **Pan tool repository** (this repo).
  Generic behavior, contracts, conventions, the runner, agents, skills, and the
  system documents in `system/`. This is public and holds no user data.
- **Specific to this user's data or workflow** → the **Domain** repository. A
  workstream's narrative, a playbook definition, a machine's playbook list, or
  the Domain's `pan.md` instructions.

If unsure which applies, ask the user.

## Improving the Pan tool repository

When a gap in the generic system blocked or slowed a task, that gap is a defect
in Pan, not a one-off. Propose the fix to the user and offer to spin up an agent
to open a pull request. Follow the repository's normal branch-and-review policy
(see `CONTRIBUTING.md`): work on a feature branch, never the default branch, and
open a PR for review. Do not commit user data.

This authority is scoped to the Pan tool repository. It never extends to a
product-context repository and never bypasses the Domain boundary, live-state
reads, user approval, or runner-owned fields.

## Improving the Domain

When the lesson is about the user's own work — a decision, a datum, a better way
to route or triage something — record it in the right workstream README,
playbook, machine list, or `pan.md`, with the user's approval, so future
sessions in this Domain benefit.

## Efficiency, not just correctness

Reflect on how efficiently you worked, not only whether you succeeded. Consulting
docs to fix a tool-call parameter, retrying a knowably-failed command, or
rediscovering something already established is acceptable once and a defect when
it recurs. Turn a recurring inefficiency into a durable instruction change in
the appropriate place.
