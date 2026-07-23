# PAN goals

PAN is a reusable personal chief-of-staff agent for a GitHub-backed domain of
work. It understands the domain's tasks and workstream narrative, maintains the
canonical queue for human and agent work, delegates compatible execution, and
explains its decisions.

## Product goals

### Make good next-work decisions

PAN considers every actionable task in its connected domain and the relevant
workstream markdown, comments, dates, commitments, dependencies, blockers, and
recent changes. It recommends what the human and available worker agents should
do next, with evidence and explicit uncertainty.

### Maintain one canonical queue

GitHub Issues, Project fields, and Project ordering are the source of truth.
PAN updates that Project directly. A person looking at the GitHub UI and a
person talking to PAN must see the same human queue, agent queue, and task state.

### Be a trusted advisor

PAN is:

- proactive about commitments, blockers, and opportunities;
- opinionated enough to make a clear recommendation;
- willing to challenge weak priorities or contradictions;
- concise and focused on decisions;
- warm and protective of the user's time and commitments; and
- transparent about facts, inference, confidence, and tradeoffs.

### Delegate without idle agents

Participating machines run lightweight pull-based runners, not idle agents in
every project context. A runner launches a worker session only after it finds
and atomically claims compatible work.

### Remain reusable

This public repository contains generic agents, runtime behavior, tools,
schemas, and protocols. User-specific workstreams, Issues, paths, credentials,
runner state, and machine configuration remain outside it.

## Non-goals

- PAN does not maintain a second queue that can disagree with GitHub.
- PAN does not silently combine knowledge from multiple domain repositories.
- PAN does not push work to a named machine.
- PAN does not keep an idle worker-agent session in every repository.
- PAN does not treat model conversation history as the only durable record of a
  commitment or decision.
- PAN does not let autonomous workers push, force-push, or bypass delivery
  policy. The runner may push to a default branch only when its playbook
  explicitly selects direct delivery.

## Success criteria

The first reasoning-focused release is successful when:

1. PAN considers every actionable item in one real domain repository.
2. It maintains the Project ordering for both human and agent work.
3. It explains a ranking using cited task and workstream evidence.
4. It identifies a high-confidence commitment in narrative and, with user
   approval, creates a sourced Issue without duplicating existing work.
5. The user can discuss and change the same queue through the PAN personality.
6. A compatible runner can claim ordered agent work, launch an isolated worker
   session, and report progress or a need for human input through GitHub.
