# Pan goals

Pan is a personal chief of staff. It holds everything you and your agents owe,
decides what should happen next, keeps always-on runners supplied with work, and
gets blocked agents back in front of you quickly.

Pan operates on one **domain** at a time: one private GitHub repository plus one
GitHub Project. Issues and Project fields are the only task state. Workstream
Markdown in the same repository is the narrative record. Someone reading the
GitHub UI and someone talking to Pan see the same queue.

## Product goals

Each goal states the outcome that proves it.

### 1. Track all the work, human and agent

One backlog holds both what the human will do and what agents will do. The
`owner` field separates the two queues; nothing else does. Work that exists only
in a conversation is not tracked.

**Done when** every commitment the user is accountable for is an Issue on the
Project with an owner, and Pan can enumerate both queues completely.

### 2. Reason about what should happen next

Pan weighs priority, dates, dependencies, blockers, recent activity, comments,
and workstream narrative, then makes a call. It is opinionated enough to
recommend, and honest enough to show its evidence and its uncertainty.

**Done when** Pan produces an ordered recommendation for both queues, cites the
specific Issues and narrative behind the order, and names what it is unsure of.

### 3. Keep always-on runners supplied

Each participating machine runs one lightweight, pull-based runner configured
with a set of **playbooks**. A playbook declares a kind of task that machine can
take on, the instructions to give an agent working it, and how the result is
delivered. A runner claims compatible ready work from the prioritized backlog,
leases it, and executes it the way its playbook specifies. Work is never pushed
at a named machine; machines pull only what their playbooks cover.

**Done when** a runner on any participating machine can take the highest-priority
item its playbooks cover and deliver it without the human routing it there.

### 4. Get blocked agents unblocked fast

A worker's question is an interrupt, not a backlog item. An idle agent is wasted
time, so questions surface with urgency proportional to what they block, and
answering one costs the human no reconstruction of context.

A question is a pause, not a failure. The worker stays alive holding its lease
and its slot, spends no budget while it waits, and continues the moment it is
answered. Discarding a waiting worker and launching a fresh instance throws away
everything that worker had established, so the answer reaches the original
session rather than a replacement. When a machine restarts, its waiting task is
rehydrated on that same machine and the question is re-posed there.

**Done when** a worker question reliably reaches the human, and answering it in
one exchange continues the original worker with its context intact.

### 5. Keep workstream knowledge current, and use it

Findings, decisions, data, and state for every workstream live in committed
Markdown, not in chat history. That narrative is an input to prioritization, not
just documentation.

**Done when** Pan can update a workstream from a conversation and later cite
that narrative as a reason for a priority decision.

### 6. Improve itself

When Pan's durable guidance is insufficient to finish a task, the gap is a
defect in Pan, not a one-off. Pan may diagnose it and repair its own
instructions, schema, or helpers in the Pan tool repository under normal
branch-and-review policy, then resume.

Pan also reflects on how efficiently it worked, not only on whether it
succeeded. Consulting documentation to correct a tool-call parameter, retrying a
command that failed for a knowable reason, or rediscovering something it had
already established are acceptable once and defects when they recur. Pan
captures the lesson so the next attempt costs less.

This authority is scoped to the Pan tool repository. It never extends to another
product-context root and never bypasses domain, live-state, or approval rules.

**Done when** Pan turns both a guidance gap that blocked it and a recurring
inefficiency that merely slowed it into durable instruction changes.

## How Pan behaves

Pan is proactive about commitments and blockers, willing to challenge weak
priorities or contradictions, concise and decision-focused, protective of the
user's time, and transparent about what is fact, what is inference, and how
confident it is.

Pan stays reusable. This public repository holds generic agents, behavior,
tools, schemas, and protocols. Workstreams, Issues, paths, credentials, runner
state, and machine configuration live outside it.

## Non-goals

These are permanent. Pan does not:

- maintain a second queue that can disagree with GitHub;
- treat conversation history as the durable record of a commitment or decision;
- combine knowledge from multiple domains without being asked to;
- push work at a named machine;
- keep an idle worker agent sitting in every repository; or
- let autonomous workers push, force-push, or bypass their playbook. A runner
  may write to a default branch only when its playbook instructions say so.

## Not yet

These are deferred, not rejected. They are the two most likely expansions of
Pan's scope.

- **Always-on operation.** Today Pan runs only in the foreground and nothing
  continues after its session exits, so its proactivity reaches the user only
  while they are already talking to it. The intent is for Pan to notice and
  raise things without being opened first.
- **Multiple domains at once.** Today one session serves one domain, so work and
  personal domains cannot be reasoned about together. The intent is explicit,
  user-directed cross-domain views, never implicit blending.

## Open questions

The unresolved design decisions behind these goals are tracked in
[open questions](open-questions.md).
