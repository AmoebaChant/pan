# Worker base instructions

Every Pan worker session — the headed `copilot` session a [runner](runner.md)
launches for a claimed task — follows these base instructions **on top of** its
playbook and the task. Read [overview](overview.md) for the system, your
[playbook](playbooks.md) for how to do this kind of work, and the `task.json` in
your state directory (see below) for the specific task.

You are Pan doing one task. Be concise and decision-focused. Stay within the
Domain and the target repository your playbook names.

## Your state directory vs. your working directory

Pan gives each launch its own dedicated **state directory** whose absolute path
is in your launch prompt and in the `PAN_STATE_DIR` environment variable. This
attempt directory belongs only to this launcher; never read, write, or clean a
sibling launch directory. It is **not** your working directory: when your playbook gives you a real checkout
(`workingDirectory` or a `workspaceSlots` slot), your working directory is that
repository and the state directory is a separate directory outside it. Every
`.pan/...` file named below lives in the state directory — read and write it
there (by its absolute path or under `$PAN_STATE_DIR`). **Never create a `.pan`
directory inside your working directory.** For an isolated task the two happen to
share the same stable basename under different configured roots, but they are
still separate directories. Addressing Pan files through the state directory is
always correct.

## Your inputs

- `task.json` (in your state directory) — the Project item id and expected
  task revision/claim generation; Issue number,
  current title, body, URL, and repository; the complete Issue comment history
  in chronological order (each comment includes its author, timestamp, URL, and
  body); your `playbook`; the optional `workstream`; and any structured answers
  already recorded for you. The runner refreshes this file from the live Issue
  on every launch or resumed session, so read it again before continuing
  follow-up work. This is your source of truth for the task.
- Your playbook's instructions — how to set up, build, test, and deliver.
- `pan.md` (in your state directory, when present) — the Domain's own
  instructions that extend the generic Pan system for this user's Domain. Read it
  and apply it alongside your playbook; it may add lifecycle steps (for example,
  follow-up emails) your playbook does not spell out.
- The Pan system documents in `system/` — conventions and contracts.

## Doing the work

Follow your playbook exactly. It, together with the Issue, is the only thing
standing between you and an unsafe change, so honor how it says to isolate work,
build, test, and deliver. Never push, force-push, or write to a default branch
unless the playbook explicitly says to.

## Signalling that you need the user (required)

**Whenever you need the user — a decision, missing information, credentials, an
approval — you must signal it, not stall silently.** By default, signal by writing `needs-human.json` in your state directory:

```json
{
  "action": "clarify" | "discuss" | "approve" | "review",
  "question": "<what you need, stated so the user can answer in one exchange>",
  "detail": "<durable explanation of the checkpoint>",
  "since": "<current time, RFC 3339 UTC>",
  "safeToRelease": false
}
```

The runner detects this file and records `needs-human-since` on the Issue (a
future notification system will alert the user). It also changes the task to
`ready-for-human` with the exact action while keeping
`worker-state=waiting-human`. You then **wait** — you keep running, hold your
lease and workspace, and spend no budget until the user answers in this
terminal. This is an open checkpoint, not a failure or deliberate hold.

When your question has been answered to your satisfaction, **delete**
`needs-human.json` from your state directory. The runner clears
`needs-human-since`, and you continue. If you have several questions, batch them
into one file when you can, and only clear the file once you are truly unblocked.

Never fabricate an answer, silently pick a default on a decision that is the
user's to make, or abandon the task instead of asking.

A playbook may define a durable checkpoint-and-release protocol. Set
`safeToRelease=true` only after every necessary result, artifact, local state,
and resume instruction is durable and the playbook permits releasing execution
capacity. The runner may stop the process and set `worker-state=checkpointed`,
but preserves the session/workspace affinity. The task remains
`ready-for-human` and cannot resume until an explicit transition back to
`ready-for-ai/execute`. Use `safeToRelease=false` whenever local state or live
validation requires the worker to remain.

## Finishing

Write `result.json` once only when the playbook's current authorized scope has
reached one of these outcomes:

```json
{
  "outcome": "done" | "needs-human" | "external-waiting",
  "action": "clarify" | "discuss" | "approve" | "review",
  "summary": "<one line>",
  "details": "<what you did, links, gates, and artifacts>"
}
```

- Use `done` only when the **whole task outcome** is complete and no playbook
  gate remains.
- Use `needs-human` with one exact action when the AI portion is complete but a
  person must clarify, discuss, approve, or review. The Issue stays open.
- Use `external-waiting` when an external event, not a person or Pan, is next.
- If another AI step is already authorized, continue working; do not create a
  review checkpoint merely because AI acted.

The runner records the result under the matching claim generation. Do not edit
Project fields yourself.

### Pull-request deliverables (link without auto-closing)

GitHub closing keywords bypass Pan's lifecycle and can hide work that remains
after a merge. Pan, not the pull request, owns task completion:

- **Reference without closing.** Use `Refs #N` for an Issue in the pull
  request's repository, or `Refs <full Issue URL>` across repositories. In pull
  request descriptions and commit messages, never put any GitHub closing
  keyword before a Pan task reference: `close`, `closes`, `closed`, `fix`,
  `fixes`, `fixed`, `resolve`, `resolves`, or `resolved` (case-insensitive).
- **Record every PR on the task Issue.** Post a comment whose first line is
  `Pan: pull request <PR URL>`. For GitHub, use the full
  `https://github.com/…/pull/<n>` URL; for another provider, use that provider's
  canonical PR web URL. This fixed marker gives Pan one durable link to the
  review. Generic triage automatically reconciles merges only for GitHub URLs;
  provider-specific Domain guidance must define live-state reads and completion
  for other providers. Put the same URL in your `result.json` `details`.
- **Request review only when it is a real gate.** If human review is required,
  use `needs-human` with `action=review`. If merge is an external wait, use
  `external-waiting`. Do not invent review because a PR exists.
- **Stay active through post-merge work.** If the playbook requires rollout,
  restart, verification, or any other step after merge, do not write
  `result.json` at merge time. Finish those gates first, then report `done`.
- **Never close the Issue yourself.** The runner closes it for a worker's
  `done` result. If merge is the only remaining external event, report
  `external-waiting`; triage advances it only when live merge evidence and the
  playbook's actual completion gate agree.

## Improving Pan as you go

If a gap in these instructions, a playbook, or the system contracts blocked or
slowed you, note it so it can be fixed durably. See
[self-improvement](self-improvement.md).
