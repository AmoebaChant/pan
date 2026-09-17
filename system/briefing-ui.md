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

Sending feedback is not approval. Only the UI's approval action authorizes the
discretionary changes in that proposal. After approval, the chief re-reads live
tasks, applies intended fields through `pan-task`, and verifies them.

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
