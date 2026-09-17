# Pan chief instruction evaluation

`pan-chief-eval` exercises the packaged `pan-chief` instructions against a
wholly synthetic Domain. It is a development and release-confidence tool, not
a production planner, benchmark service, scheduler, or alternate task backend.

## What it tests

The reusable fixture covers complete-backlog opportunity discovery, playbook
reads before classification, standing versus approval-required authority,
future and undated agent candidates, imported work, missing required
identifiers, saved-session resume, active and waiting workers, human-only work,
holds, external waits, unsupported recurrence, completed activity, and
out-of-scope assignments.

The chief must submit one structured assessment through the fixture MCP. Hard
assertions check complete task accounting, concrete omission reasons,
candidate coverage, checked backend writes, exact new/resume consistency for
every candidate, valid non-duplicated human-attention membership,
worker-terminal routing, and forbidden mutations. Task lists omit
native reports as the production adapter does; the chief must read reports
through the separate operation.

Observable ordering is part of the hard evidence. The complete task list,
runner state, playbook inventory and definitions, and required native reports
must be read before checked writes or final assessment submission. Every write
also requires a preceding live task and report read for that task. The harness
does not claim visibility into private model reasoning; it checks the tool
sequence at the first externally observable decision.
A separate fresh GPT-5.6 Sol evaluator reviews the transcript, operations, and
assessment as untrusted evidence against the generic contracts and rubric. It
does not receive the deterministic verdict, failure text, or fixture answer
key. Hard checks are combined only after that independent opinion, and an
evaluator PASS cannot override a hard assertion.

Machine results and notes distinguish output-schema failures (for example, a
terminal task placed in the nonterminal disposition ledger) from substantive
behavior failures. Both remain nonzero failures; the distinction is diagnostic
and never relaxes a check.

Any timeout, incomplete chief run, MCP/tool error, missing assessment,
malformed evaluator verdict, evaluator process error, or insufficient evidence
is an ERROR or FAIL. There is no success-shaped fallback.

## Isolation

Each trial creates fresh chief and evaluator `COPILOT_HOME` directories and a
fresh session id. The chief working directory contains no repository, private
binding, credentials, or user task data. Only the packaged chief agent and
allowlisted Pan contract text are copied into the fixture state. The synthetic
MCP exposes fixture Domain reads, production-shaped task operations, runner
state, and assessment submission. Built-in GitHub MCP tools are disabled and
the chief's available-tool list contains only the fixture MCP tools.

The evaluator receives the recorded evidence, has no MCP server, and receives
an empty available-tool list. Environment construction omits task tokens and
GitHub tokens. Existing Copilot authentication may still be resolved by the
CLI's approved host authentication mechanism; the harness does not copy user
configuration, memories, sessions, or credentials.

Artifacts contain synthetic data plus model output and are written only to the
explicit output directory, which must be absolute and outside the Pan
repository. Interrupted runs retain per-trial state, JSONL operations,
transcripts, evidence, and partial aggregate results. The harness terminates
only its owned process group on timeout.

## Commands

Deterministic preparation, with no model calls:

```sh
npm run eval:chief -- prepare \
  --output /absolute/private/path/pan-chief-eval
```

One explicit chief/evaluator smoke trial:

```sh
npm run eval:chief -- run \
  --output /absolute/private/path/pan-chief-eval \
  --trials 1 \
  --timeout-seconds 180
```

A repeated campaign uses the same command with a larger `--trials` value.
Every trial is fresh. `results.json` is the machine-readable aggregate;
`trial-N/evidence.json`, `result.json`, transcripts, and `operations.jsonl`
provide review evidence. The command exits nonzero unless every trial passes
both hard assertions and the evaluator.

The normal `npm test` suite never launches Copilot or consumes AI credits.
