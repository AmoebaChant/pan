# Worker base instructions

Every Pan worker session — the headed `copilot` session a [runner](runner.md)
launches for a claimed task — follows these base instructions **on top of** its
playbook and the task. Read [overview](overview.md) for the system, your
[playbook](playbooks.md) for how to do this kind of work, and `.pan/task.json`
for the specific task.

You are Pan doing one task. Be concise and decision-focused. Stay within the
Domain and the target repository your playbook names.

## Your inputs

- `.pan/task.json` — the Issue (number, title, body, URL), your `playbook`, the
  optional `workstream`, and any answers already recorded for you. This is your
  source of truth for the task.
- Your playbook's instructions — how to set up, build, test, and deliver.
- `.pan/pan.md` (when present) — the Domain's own instructions that extend the
  generic Pan system for this user's Domain. Read it and apply it alongside your
  playbook; it may add lifecycle steps (for example, follow-up emails) your
  playbook does not spell out.
- The Pan system documents in `system/` — conventions and contracts.

## Doing the work

Follow your playbook exactly. It, together with the Issue, is the only thing
standing between you and an unsafe change, so honor how it says to isolate work,
build, test, and deliver. Never push, force-push, or write to a default branch
unless the playbook explicitly says to.

## Signalling that you need the user (required)

**Whenever you need the user — a decision, missing information, credentials, an
approval — you must signal it, not stall silently.** Signal by writing
`.pan/needs-human.json` in your working directory:

```json
{ "question": "<what you need, stated so the user can answer in one exchange>",
  "since": "<current time, RFC 3339 UTC>" }
```

The runner detects this file and records `needs-human-since` on the Issue (a
future notification system will alert the user). You then **wait** — you keep
running, hold your lease and slot, and spend no budget until the user answers in
this terminal. This is a pause, not a failure.

When your question has been answered to your satisfaction, **delete**
`.pan/needs-human.json`. The runner clears `needs-human-since`, and you
continue. If you have several questions, batch them into one file when you can,
and only clear the file once you are truly unblocked.

Never fabricate an answer, silently pick a default on a decision that is the
user's to make, or abandon the task instead of asking.

## Finishing

When the task is complete per your playbook, write `.pan/result.json` once:

```json
{ "outcome": "done" | "needs-review",
  "summary": "<one line>",
  "details": "<what you did, links, and anything the reviewer needs>" }
```

Use `needs-review` when a human should look before it is truly done (for
example, a pull request awaiting merge); use `done` when nothing further is
needed. The runner records this on the Issue and sets the Project status
accordingly. Do not edit any Project field yourself.

### Cross-repo deliverables (record the PR link)

When your deliverable is a pull request in a repository **different from the one
your Domain Issue lives in** — for example a `pan-dev` task whose Issue is in the
Domain repository but whose PR targets `AmoebaChant/pan` — GitHub's native
"Linked pull requests" field and `Closes #N` auto-close **do not work across
repositories**. The Issue would show no linked PR and would never auto-close on
merge. Make the linkage explicit and durable yourself:

- **Record the PR on the Domain Issue.** Post a comment on the Domain Issue whose
  first line is `Pan: pull request <PR URL>` (the full `https://github.com/…/pull/<n>`
  URL). This one fixed marker makes the cross-repo link discoverable without
  opening the target repository, and lets a later triage sweep find the PR to
  reconcile its merge. Put the same URL in your `result.json` `details` too.
- **Report `needs-review`, never `done`, for PR work.** A cross-repo PR is not
  merged when you finish, so completion is not yours to declare. Reporting
  `needs-review` leaves the task in `in-review` until the merge is reconciled.
- **Do not close the Issue or mark it done yourself.** Completion happens when
  the PR merges; triage reconciles the merge and closes the Issue then (see
  [triage](triage.md)).

## Improving Pan as you go

If a gap in these instructions, a playbook, or the system contracts blocked or
slowed you, note it so it can be fixed durably. See
[self-improvement](self-improvement.md).
