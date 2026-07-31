import { answerTexts, latestNeedsHuman } from "./needs-human.js";
import { parseWorkstreamIssueUrl } from "./workstream-issue-store.js";

const REQUIREMENT_PATTERN =
  /\b(?:repo|env|os|tool|needs):[A-Za-z0-9_.\/-]+/gi;
const DIRECTIVE_PATTERN =
  /^(?:[-*]\s*)?(owner|priority|workstream)\s*:\s*(.+)$/gim;

export function deriveTriage(item, comments = [], { workstreams = [] } = {}) {
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
  const fields = {
    owner,
    priority: directives.priority ?? current.priority ?? "normal",
    requirements,
    workstream: directives.workstream ?? current.workstream,
  };
  const missing = [];
  if (directives.invalidWorkstream || fields.workstream) {
    try {
      const parsed = parseWorkstreamIssueUrl(
        fields.workstream,
        item.repository,
      );
      const resolved = workstreams.find(
        (workstream) => workstream.url === parsed.url,
      );
      if (workstreams.length > 0 && !resolved) {
        missing.push("a valid Workstream Issue URL");
      }
    } catch {
      missing.push("a valid Workstream Issue URL");
    }
  }
  if (owner === "agent" && repositoryRequirements.length !== 1) {
    missing.push("exactly one repo:<owner/name> requirement");
  }
  if (owner === "agent" && !description) {
    missing.push("a task description or acceptance criteria");
  }

  const currentStatus = current.status || "untriaged";
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
    workstreamProposal:
      fields.workstream || workstreams.length === 0
        ? undefined
        : inferWorkstream(source, workstreams),
    prompt:
      missing.length > 0
        ? `Provide ${joinList(missing)}. You can answer with directives such as "workstream: https://github.com/owner/domain/issues/12" or "repo:owner/name".`
        : undefined,
  };
}

export function matchingRunner(requirements, profiles) {
  const repositories = requirements
    .filter((requirement) => requirement.startsWith("repo:"))
    .map((requirement) => requirement.slice("repo:".length));
  const repository = repositories.length === 1 ? repositories[0] : undefined;
  return profiles.find(
    (profile) =>
      profile.online &&
      (profile.playbooks
        ? profile.playbooks.some((playbook) =>
            (!repository ||
              !playbook.repositories ||
              playbook.repositories.includes(repository)) &&
            requirements.every((requirement) =>
              playbook.capabilities.includes(requirement),
            ),
          )
        : requirements.every((requirement) =>
            profile.capabilities.includes(requirement),
          )),
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
    } else if (key === "workstream") {
      if (validWorkstream(value)) {
        directives.workstream = value;
      } else {
        directives.invalidWorkstream = true;
      }
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
  try {
    parseWorkstreamIssueUrl(value);
    return true;
  } catch {
    return false;
  }
}

function inferWorkstream(source, workstreams) {
  const linked = workstreams.filter((workstream) =>
    source.includes(workstream.url),
  );
  if (linked.length === 1) {
    return linked[0];
  }
  const lowered = source.toLowerCase();
  const titled = workstreams.filter(
    (workstream) =>
      workstream.title.length >= 4 &&
      lowered.includes(workstream.title.toLowerCase()),
  );
  return titled.length === 1 ? titled[0] : undefined;
}

function stripTriageMetadata(text = "") {
  return text
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim();
      return (
        trimmed &&
        !trimmed.match(
          /^(?:[-*]\s*)?(?:owner|priority|workstream)\s*:/i,
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
