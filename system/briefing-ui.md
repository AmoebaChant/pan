# Daily Briefing review UI

The optional local review UI presents one complete proposal from the Pan chief.
It does not read or write the task backend and does not make planning
decisions.

The MCP service exposes:

- `publish_briefing` to replace the current complete proposal;
- `await_briefing_review` to wait for feedback on that exact revision; and
- `complete_briefing` to show the verified final result.

Each task row presents independent effects: work Status, human date,
planning/guidance changes, and
`agentAction=none|request-new|request-resume`. The request actions map to
`agentStatus=requested`; they never infer a work Status change or claim that a
process has launched.

Submitting feedback authorizes the user's clear instructions, including those
that override a proposal. The chief follows the reviewed Domain's feedback
policy and the [Daily Briefing review contract](daily-briefing.md#review-feedback),
re-reads live tasks, persists guidance before effects, applies only intended
fields through `pan-task`, and verifies them. Unanswered items stay unchanged;
unclear instructions need clarification and new alternatives need approval.
Rendered outcomes must distinguish confirmed effects, unprocessed instructions,
and genuinely unapplied alternatives rather than treating every disagreement
as unchanged.

The service keeps only the current proposal and pending review in memory. It
has no task database. Demo mode uses invented fixtures and cannot access live
backends:

```sh
node bin/pan-briefing-mcp.js --demo
```

The MCP-backed service binds loopback by default:

```json
{
  "mcpServers": {
    "pan-briefing": {
      "type": "stdio",
      "command": "node",
      "args": ["bin/pan-briefing-mcp.js"],
      "tools": ["*"],
      "timeout": 43200000
    }
  }
}
```
