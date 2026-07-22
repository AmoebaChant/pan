const NEEDS_HUMAN_MARKER = "<!-- pan:needs-human -->";
const ANSWER_MARKER = "<!-- pan:answer -->";
const RESOLVED_MARKER = "<!-- pan:needs-human-resolved -->";
const RUNNER_RESULT_MARKER = "<!-- pan:runner-result -->";

export function formatNeedsHuman(record) {
  validateNeedsHuman(record);
  return [
    NEEDS_HUMAN_MARKER,
    "### Needs human",
    "",
    "```json",
    JSON.stringify(record, null, 2),
    "```",
  ].join("\n");
}

export function formatAnswer(text) {
  if (!text?.trim()) {
    throw new TypeError("answer text is required");
  }
  return [ANSWER_MARKER, "### Answer", "", text.trim()].join("\n");
}

export function formatNeedsHumanResolved(reason) {
  if (!reason?.trim()) {
    throw new TypeError("resolution reason is required");
  }
  return [RESOLVED_MARKER, "### Attention resolved", "", reason.trim()].join(
    "\n",
  );
}

export function latestNeedsHuman(comments) {
  const attention = latestAttention(comments);
  return attention && !attention.answer && !attention.resolved
    ? attention.request
    : undefined;
}

export function latestAttention(comments) {
  let attention;
  for (const comment of comments) {
    const body = comment.body ?? "";
    if (body.includes(NEEDS_HUMAN_MARKER)) {
      attention = {
        request: {
          ...parseNeedsHuman(body),
          commentUrl: comment.url,
          createdAt: comment.createdAt,
        },
        answer: undefined,
        resolved: false,
      };
    } else if (body.includes(ANSWER_MARKER) && attention && !attention.resolved) {
      attention.answer = {
        text: answerTexts([comment])[0],
        commentUrl: comment.url,
        createdAt: comment.createdAt,
      };
    } else if (
      (body.includes(RESOLVED_MARKER) ||
        body.includes(RUNNER_RESULT_MARKER)) &&
      attention
    ) {
      attention.resolved = true;
    }
  }
  return attention;
}

export function answerTexts(comments) {
  return comments
    .filter((comment) => (comment.body ?? "").includes(ANSWER_MARKER))
    .map((comment) => {
      const body = comment.body;
      const heading = body.indexOf("### Answer");
      return body.slice(heading === -1 ? ANSWER_MARKER.length : heading + 10).trim();
    })
    .filter(Boolean);
}

export function latestAnswer(comments) {
  let answer;
  for (const comment of comments) {
    const body = comment.body ?? "";
    if (body.includes(ANSWER_MARKER)) {
      answer = {
        text: answerTexts([comment])[0],
        commentUrl: comment.url,
        createdAt: comment.createdAt,
      };
    } else if (
      body.includes(NEEDS_HUMAN_MARKER) ||
      body.includes(RESOLVED_MARKER) ||
      body.includes(RUNNER_RESULT_MARKER)
    ) {
      answer = undefined;
    }
  }
  return answer;
}

export function pullRequestUrl(comments) {
  for (const comment of [...comments].reverse()) {
    if (!(comment.body ?? "").includes(RUNNER_RESULT_MARKER)) {
      continue;
    }
    const match = comment.body.match(
      /Pull request:\s*(https:\/\/github\.com\/[^\s]+\/pull\/\d+)/i,
    );
    if (match) {
      return match[1];
    }
  }
  return undefined;
}

function parseNeedsHuman(body) {
  const fence = body.match(/```json\s*([\s\S]*?)\s*```/i);
  if (!fence) {
    throw new Error("PAN needs-human comment has no JSON record");
  }
  let record;
  try {
    record = JSON.parse(fence[1]);
  } catch (error) {
    throw new Error("PAN needs-human comment contains invalid JSON", {
      cause: error,
    });
  }
  validateNeedsHuman(record);
  return record;
}

function validateNeedsHuman(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new TypeError("needs-human record must be an object");
  }
  if (!["question", "approval", "local-ui"].includes(record.kind)) {
    throw new TypeError("needs-human kind must be question, approval, or local-ui");
  }
  if (!record.prompt?.trim()) {
    throw new TypeError("needs-human prompt is required");
  }
  if (
    record.locator !== undefined &&
    (!record.locator ||
      typeof record.locator !== "object" ||
      Array.isArray(record.locator))
  ) {
    throw new TypeError("needs-human locator must be an object");
  }
  if (record.priorState !== undefined) {
    if (
      !record.priorState ||
      typeof record.priorState !== "object" ||
      Array.isArray(record.priorState) ||
      typeof record.priorState.priority !== "string"
    ) {
      throw new TypeError("needs-human priorState must include priority");
    }
  }
  if (
    record.resume !== undefined &&
    (!record.resume ||
      typeof record.resume !== "object" ||
      Array.isArray(record.resume) ||
      (record.resume.affinity !== undefined &&
        !String(record.resume.affinity).startsWith("resume:")))
  ) {
    throw new TypeError("needs-human resume state is invalid");
  }
}
