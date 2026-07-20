import { answerTexts, latestNeedsHuman } from "./needs-human.js";

const REQUIREMENT_PATTERN =
  /\b(?:repo|env|os|tool|needs):[A-Za-z0-9_.\/-]+/gi;
const DIRECTIVE_PATTERN =
  /^(?:[-*]\s*)?(owner|priority|autonomy|workstream)\s*:\s*(.+)$/gim;

export function deriveTriage(item, comments = []) {
  const answers = answerTexts(comments);
  const source = [item.body, ...answers].filter(Boolean).join("\n");
  const description = [item.body, ...answers]
    .map(stripTriageMetadata)
    .filter(Boolean)
    .join("\n");
  const directives = parseDirectives(source);
  const parsedRequirements = parseRequirements(source);
  const current = item.fields;
  const requirements = unique([...item.requirements, ...parsedRequirements]);
  const repositoryRequirements = requirements.filter((requirement) =>
    requirement.toLowerCase().startsWith("repo:"),
  );
  const inferredAgent = repositoryRequirements.length > 0;
  const owner =
    directives.owner ??
    (current.owner === "unassigned" || !current.owner
      ? inferredAgent
        ? "agent"
        : "human"
      : current.owner);
  const autonomy =
    directives.autonomy ??
    (current.owner === "unassigned" && owner === "agent"
      ? "full-auto"
      : current.autonomy || (owner === "agent" ? "full-auto" : "manual"));
  const fields = {
    owner,
    priority: directives.priority ?? current.priority ?? "normal",
    requirements,
    autonomy,
    workstream: directives.workstream ?? current.workstream,
  };
  const missing = [];
  if (!fields.workstream) {
    missing.push("a workstream path");
  }
  if (owner === "agent" && repositoryRequirements.length !== 1) {
    missing.push("exactly one repo:<owner/name> requirement");
  }
  if (owner === "agent" && !description) {
    missing.push("a task description or acceptance criteria");
  }

  const currentStatus = current.status;
  let status = currentStatus;
  if (["untriaged", "needs-detail"].includes(currentStatus)) {
    status = missing.length > 0 ? "needs-detail" : "ready";
  }
  const pending = latestNeedsHuman(comments);
  if (
    currentStatus === "blocked" &&
    pending?.source === "pan" &&
    pending.reason === "missing-detail"
  ) {
    status = missing.length > 0 ? "needs-detail" : "ready";
  }

  return {
    fields: { ...fields, status },
    missing,
    prompt:
      missing.length > 0
        ? `Provide ${joinList(missing)}. You can answer with directives such as "workstream: path" or "repo:owner/name".`
        : undefined,
  };
}

export function matchingRunner(requirements, profiles) {
  return profiles.find(
    (profile) =>
      profile.online &&
      requirements.every((requirement) =>
        profile.capabilities.includes(requirement),
      ),
  );
}

export function compareBacklogItems(left, right) {
  const priority = { urgent: 0, high: 1, normal: 2, low: 3 };
  const status = {
    "in-review": 0,
    ready: 1,
    "needs-detail": 2,
    blocked: 3,
    "in-progress": 4,
    untriaged: 5,
    done: 6,
  };
  return (
    (priority[left.fields.priority] ?? 2) -
      (priority[right.fields.priority] ?? 2) ||
    (status[left.fields.status] ?? 5) - (status[right.fields.status] ?? 5) ||
    (left.number ?? Number.MAX_SAFE_INTEGER) -
      (right.number ?? Number.MAX_SAFE_INTEGER)
  );
}

function parseDirectives(text) {
  const directives = {};
  for (const match of text.matchAll(DIRECTIVE_PATTERN)) {
    const key = match[1].toLowerCase();
    const value = match[2].trim();
    if (key === "owner" && ["unassigned", "human", "agent"].includes(value)) {
      directives.owner = value;
    } else if (
      key === "priority" &&
      ["urgent", "high", "normal", "low"].includes(value)
    ) {
      directives.priority = value;
    } else if (
      key === "autonomy" &&
      ["manual", "full-auto", "agent-reviewer"].includes(value)
    ) {
      directives.autonomy = value;
    } else if (key === "workstream" && validWorkstream(value)) {
      directives.workstream = value.replaceAll("\\", "/");
    }
  }
  return directives;
}

function parseRequirements(text) {
  return unique(
    [...text.matchAll(REQUIREMENT_PATTERN)].map((match) => match[0]),
  );
}

function validWorkstream(value) {
  return (
    !value.startsWith("/") &&
    !value.endsWith("/") &&
    !value.includes("..") &&
    /^[A-Za-z0-9_.\/-]+$/.test(value)
  );
}

function stripTriageMetadata(text = "") {
  return text
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim();
      return (
        trimmed &&
        !trimmed.match(
          /^(?:[-*]\s*)?(?:owner|priority|autonomy|workstream)\s*:/i,
        ) &&
        !trimmed.match(
          /^(?:[-*]\s*)?(?:(?:repo|env|os|tool|needs):[A-Za-z0-9_.\/-]+\s*)+$/i,
        )
      );
    })
    .join("\n")
    .trim();
}

function unique(values) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function joinList(values) {
  if (values.length === 1) {
    return values[0];
  }
  return `${values.slice(0, -1).join(", ")}, and ${values.at(-1)}`;
}
