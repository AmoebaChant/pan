# Recurring tasks

Use the selected backend's native recurrence semantics when available. Todoist
completion advances its native occurrence.

For GitHub, each occurrence is an Issue. A `## Recurrence` section states the
cadence and the first body line records:

```text
Pan: recurrence occurrence YYYY-MM-DD
```

Closing an occurrence as completed creates or reconciles exactly one successor.
Closing it as not planned ends the series. The successor starts with
`status=open`, preserves priority and workstream, and has blank session and
Agent status. Its planned date is the next nominal occurrence unless the user
chooses another human-attention date.

Recurrence is business logic owned by chief/worker Markdown. It is not a runner
eligibility gate. A recurring task may request a session like any other task.
Changing work Status does not close that session.

Use durable predecessor/successor comments to avoid duplicates. Re-read native
Issue state, close reason, rule, marker, and existing links before creating a
successor. If the nominal date or prior linkage is ambiguous, ask one focused
question rather than inventing another state or recovery system.
