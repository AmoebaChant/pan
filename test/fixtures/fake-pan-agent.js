function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const prompt = argument("-p");
if (prompt) {
  const request = JSON.parse(
    prompt
      .split("\n")
      .find((line) => line.trim().startsWith('{"version":1,"type":"request"')),
  );
  const scenario = process.env.PAN_FAKE_SCENARIO ?? "success";
  const leakedCredential = [
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "SSH_AUTH_SOCK",
    "GIT_ASKPASS",
  ].find((name) => process.env[name]);

  if (leakedCredential) {
    console.error(`Credential leaked: ${leakedCredential}`);
    process.exitCode = 9;
  } else if (scenario === "timeout" || scenario === "cancel") {
    console.log(
      JSON.stringify({ type: "fixture.pid", data: { pid: process.pid } }),
    );
    setInterval(() => {}, 60_000);
  } else if (scenario === "malformed") {
    console.log("{not-json");
  } else if (scenario === "output-limit") {
    console.log("x".repeat(100_000));
  } else {
    if (
      scenario === "tools" ||
      scenario === "unknown-tool" ||
      scenario === "nonzero"
    ) {
      const operations =
        scenario === "unknown-tool"
          ? ["delete_everything"]
          : request.toolChannel.allowedOperations.slice(0, 2);
      for (const [index, operation] of operations.entries()) {
        const requestId = `request-${index + 1}`;
        emit("tool.execution_start", {
          version: 1,
          type: "tool-request",
          requestId,
          turnId: request.turnId,
          operation,
          arguments: { index },
        });
        emit("tool.execution_complete", {
          version: 1,
          type: "tool-result",
          requestId,
          turnId: request.turnId,
          operation,
          status: "confirmed",
          confirmedEffects:
            scenario === "nonzero" && index === 0
              ? [{ actionId: "action-1", summary: "Fixture mutation confirmed." }]
              : [],
          incompleteEffects: [],
        });
      }
    }

    if (scenario === "nonzero") {
      console.error("Fixture process failed after a confirmed tool effect.");
      process.exitCode = 7;
    } else {
      const response = finalResponse(request);
      if (scenario === "wrong-identity") {
        response.snapshotId = "wrong-snapshot";
      }
      if (scenario === "invalid-citation") {
        response.facts = [
          {
            statement: "Unsupported claim.",
            citations: [{ kind: "made-up", locator: "" }],
          },
        ];
      }
      if (scenario === "missing-action-evidence") {
        response.proposedActions = [
          {
            version: 1,
            actionId: "unsafe-action",
            kind: "canonical-reorder",
            rationale: "Reorder the queue based on an unsupported assertion.",
            confidence: 0.9,
            evidence: [],
            idempotencyKey: "unsafe-reorder",
            expectedState: { snapshotId: request.snapshot.id },
            target: { orderedItemIds: ["item-1"] },
          },
        ];
      }
      emit("assistant.message", response);
      emit("result", {
        sessionId:
          argument("--session-id") ??
          process.argv.find((value) => value.startsWith("--resume="))?.slice(9),
        exitCode: 0,
        arguments: process.argv.slice(2),
      });
    }
  }
}

function emit(type, value) {
  console.log(
    JSON.stringify({
      type,
      data:
        type === "assistant.message"
          ? { content: JSON.stringify(value) }
          : type === "result"
            ? value
            : { message: value },
    }),
  );
}

function finalResponse(turn) {
  return {
    version: 1,
    type: "final-response",
    turnId: turn.turnId,
    mode: turn.mode,
    timestamp: "2026-07-20T22:00:00.000Z",
    snapshotId: turn.snapshot.id,
    recommendation: "Keep the current fixture order.",
    facts: [],
    interpretations: [],
    assumptions: [],
    uncertainties: [],
    citations: [],
    proposedActions: [],
    appliedActions: [],
    rejectedActions: [],
    effects: { confirmed: [], incomplete: [] },
  };
}
