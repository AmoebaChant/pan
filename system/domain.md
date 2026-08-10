# The Pan Domain

A **Domain** is the user's private data for Pan: one private GitHub repository
plus one GitHub Project connected to it. Pan operates on exactly one Domain at a
time. The Pan tool repository holds no user data; everything user-specific lives
in the Domain.

## What the Domain repository contains

```text
<domain-repo>/
  workstreams/<path>/README.md   durable narrative per area of work
  playbooks/<machine>/<name>.md  playbook definitions (per machine)
  machines/<machine>.md          which playbooks a machine runs, and capacity
  pan.md                         domain-specific Pan instructions (optional)
```

- **Issues** in this repository are the tasks. Every Issue is a task and belongs
  to the connected Project.
- **The Project** holds each task's lifecycle and fields. See
  [project schema](project-schema.md).
- **Workstreams** are the durable narrative for each area of work. See
  [workstreams](workstreams.md).
- **Playbooks** define kinds of work and the instructions for doing them. See
  [playbooks](playbooks.md).
- **Machine lists** (`machines/<machine>.md`) declare which playbooks a given
  machine's runner may run and its capacity. See [playbooks](playbooks.md).
- **`pan.md`** (optional) holds domain-specific instructions that extend the
  generic system — for example, "during triage, also add any new open Issues
  from `owner/other-repo` to the backlog." Pan reads it at the start of a
  session and applies it alongside the generic system.

## How Pan reaches the Domain

Pan uses the GitHub API through `gh`, always against the configured Domain
repository and Project. The Domain is **never** required as a local checkout:
read and write workstreams, playbooks, and machine lists through the GitHub
Contents API, and read and write tasks through Issues and the Project.

The runner is the exception that may keep a local checkout, because a worker
edits code on disk — but that is the *target* repository named by a playbook,
not the Domain. See [playbooks](playbooks.md) and [runner](runner.md).

## Configuration

Onboarding records, per machine, which Domain this machine is bound to (the
repository and the Project). Keep that binding in a small local config the
runner and sessions read; it names the Domain repository and the Project
(`<owner>/<number>`) and nothing sensitive beyond what `gh` already holds. The
canonical Domain data always lives in GitHub, not in local config.

## Boundaries

- Operate only within the configured Domain. Do not blend data from other
  Domains unless the user explicitly asks.
- Product-context repositories a session may be pointed at are read-only
  reference. They grant no authority to modify anything.
- The one exception is the Pan tool repository itself, for self-improvement
  under its normal review policy. See [self-improvement](self-improvement.md).
