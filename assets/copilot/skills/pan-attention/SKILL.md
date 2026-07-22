---
name: pan-attention
description: List PAN attention, record durable answers, and create Issue-backed tasks through bounded helpers.
---

# PAN attention

Use this skill when the user asks what needs attention, answers a PAN question,
or requests a new task.

List attention in either writing or read-only mode:

```text
pan attention list --schema-version 1 --config <config> --json
```

Attention includes unresolved human questions and in-review work. Use its
durable Issue identity, priority, prompt, and available resume details; do not
turn operational launch or worker failures into false urgent human attention.

To record an answer, first confirm the target has unresolved attention and that
the session holds leadership:

```text
pan attention answer <issue-id-or-url> <answer> --schema-version 1 --config <config> --json
```

To add an Issue-backed untriaged task, use the bounded options needed for the
request:

```text
pan attention add <title> --body <body> --workstream <path> --owner <owner> --priority <priority> --autonomy <mode> --requirement <requirement> --schema-version 1 --config <config> --json
```

Use repeated `--requirement` or `--repo` options when needed. Read the result
envelope and report confirmed, rejected, incomplete, or failed status exactly
as returned. Answers and tasks are durable only after the helper confirms them.
