import { createHash } from "node:crypto";

import { answerTexts, latestNeedsHuman } from "./needs-human.js";
import { latestAppliedTriageDecision } from "./triage-audit.js";

const REQUIREMENT_PATTERN =
  /\b[A-Za-z][A-Za-z0-9-]*:[A-Za-z0-9_.\/-]+/g;
const DIRECTIVE_PATTERN =
  /^(?:[-*]\s*)?(owner|priority|autonomy|workstream)\s*:\s*(.+)$/gim;
const VALID_REQUIREMENT_PATTERN =
  /^[A-Za-z][A-Za-z0-9-]*:[A-Za-z0-9_.\/-]+$/;
const FIELD_OPTIONS = Object.freeze({
  owner: ["unassigned", "human", "agent"],
  priority: ["urgent", "high", "normal", "low"],
  autonomy: ["manual", "full-auto", "agent-reviewer"],
});
const PROTECTED_STATUSES = new Set(["in-progress", "in-review", "done"]);

export function deriveTriage(item, comments = [], context = {}) {
  const current = item.fields ?? {};
  const sources = evidenceSources(item, comments);
  const directives = parseDirectiveEvidence(sources);
  const decisions = [];
  const questions = [];
  const conflicts = [...directives.conflicts];
  const fields = {};
  const knownWorkstreams = normalizeWorkstreams(context.workstreams);
  const runners = context.runners ?? [];
  const runnerEvidenceAvailable = Array.isArray(context.runners);
  const humanQuestion = looksLikeHumanQuestion(item.title);
  const description = [item.title, item.body, ...answerTexts(comments)]
    .map(stripTriageMetadata)
    .filter(Boolean)
    .join("\n");

  fields.workstream = resolveWorkstream({
    current: current.workstream,
    directive: directives.values.workstream,
    sources,
    knownWorkstreams,
    decisions,
    questions,
  });

  fields.requirements = resolveRequirements({
    item,
    sources,
    runners,
    workstream: fields.workstream,
    humanQuestion,
    humanOwned:
      current.owner === "human" ||
      directives.values.owner?.value === "human",
    decisions,
    questions,
    conflicts,
  });

  fields.owner = resolveEnumField({
    field: "owner",
    current: current.owner,
    currentIsExplicit: current.owner !== "unassigned",
    directive: directives.values.owner,
    infer: () => {
      if (humanQuestion) {
        return inferred(
          "human",
          "The Issue title is a directly answerable question for a human.",
          issueEvidence(item, "title"),
        );
      }
      if (repositoryRequirements(fields.requirements).length === 1) {
        return inferred(
          "agent",
          "The task has one repository requirement and can be routed to an agent.",
          requirementEvidence(item, fields.requirements, sources),
        );
      }
      return undefined;
    },
    decisions,
    questions,
  });

  fields.priority = resolveEnumField({
    field: "priority",
    current: current.priority,
    currentIsExplicit:
      current.status !== "untriaged" || current.priority !== "normal",
    directive: directives.values.priority,
    infer: () => inferPriority(item),
    decisions,
    questions,
  });

  fields.autonomy = resolveEnumField({
    field: "autonomy",
    current: current.autonomy,
    currentIsExplicit:
      current.owner !== "unassigned" ||
      current.autonomy !== "manual",
    directive: directives.values.autonomy,
    infer: () => {
      if (fields.owner === "human") {
        return inferred(
          "manual",
          "Human-owned work remains manual.",
          fieldEvidence(item, "owner", fields.owner),
        );
      }
      if (fields.owner === "agent") {
        return inferred(
          "full-auto",
          "Agent-owned work uses the default autonomous execution policy.",
          fieldEvidence(item, "owner", fields.owner),
        );
      }
      return undefined;
    },
    decisions,
    questions,
  });

  if (!fields.workstream) {
    addQuestion(
      questions,
      "workstream",
      'Which workstream path should this use? Reply with "workstream: path".',
    );
  }
  if (!fields.owner || fields.owner === "unassigned") {
    addQuestion(
      questions,
      "owner",
      'Should this be owned by a human or an agent? Reply with "owner: human" or "owner: agent".',
    );
  }
  if (!fields.priority) {
    addQuestion(
      questions,
      "priority",
      "What priority should this have: urgent, high, normal, or low?",
    );
  }
  if (!fields.autonomy) {
    addQuestion(
      questions,
      "autonomy",
      "What autonomy should this use: manual, full-auto, or agent-reviewer?",
    );
  }
  if (fields.owner === "human" && fields.autonomy && fields.autonomy !== "manual") {
    addQuestion(
      questions,
      "autonomy",
      'Human-owned work must use manual autonomy. Should the owner or autonomy change?',
      [
        fieldEvidence(item, "owner", fields.owner),
        fieldEvidence(item, "autonomy", fields.autonomy),
      ],
    );
  }
  if (fields.owner === "agent" && fields.autonomy === "manual") {
    addQuestion(
      questions,
      "autonomy",
      'Agent-owned work must use full-auto or agent-reviewer autonomy. Which should this use?',
      [
        fieldEvidence(item, "owner", fields.owner),
        fieldEvidence(item, "autonomy", fields.autonomy),
      ],
    );
  }

  const repositories = repositoryRequirements(fields.requirements);
  if (fields.owner === "agent" && repositories.length !== 1) {
    addQuestion(
      questions,
      "requirements",
      "Which repository should the agent change? Reply with exactly one repo:owner/name requirement.",
    );
  }
  if (fields.owner === "agent" && !description) {
    addQuestion(
      questions,
      "description",
      "What outcome or acceptance criteria should the agent implement?",
    );
  }

  const runner =
    runnerEvidenceAvailable &&
    fields.owner === "agent" &&
    repositories.length === 1
      ? matchingRunner(fields.requirements, runners)
      : undefined;
  const currentStatus = current.status;
  let status = currentStatus;
  const pending = latestNeedsHuman(comments);
  const priorStatusDecision = latestAppliedTriageDecision(comments, "status");
  const triageControlled =
    ["", "untriaged", "needs-detail"].includes(currentStatus ?? "") ||
    (currentStatus === "blocked" &&
      ((pending?.source === "pan" &&
        ["missing-detail", "triage-metadata"].includes(pending.reason)) ||
        (priorStatusDecision?.value === "blocked" &&
          priorStatusDecision.reason === "runner-unavailable")));

  if (!PROTECTED_STATUSES.has(currentStatus)) {
    if (currentStatus === "blocked" && !triageControlled) {
      status = "blocked";
    } else if (questions.length > 0 || conflicts.length > 0) {
      status = "needs-detail";
    } else if (
      runnerEvidenceAvailable &&
      fields.owner === "agent" &&
      !runner
    ) {
      status = "blocked";
    } else if (triageControlled || !validStatus(currentStatus)) {
      status = "ready";
    }
  }
  fields.status = status;

  if (status !== currentStatus) {
    decisions.push({
      field: "status",
      value: status,
      ...(status === "blocked" ? { reason: "runner-unavailable" } : {}),
      rationale:
        status === "needs-detail"
          ? "The item is not actionable until the listed metadata questions are answered."
          : status === "blocked"
            ? "No currently online runner can satisfy the complete task requirements."
            : "All required metadata is valid and the item is actionable.",
      evidence: [
        ...questions.flatMap((question) => question.evidence ?? []),
        ...(runner ? [{ kind: "runner", locator: runner.id }] : []),
        issueEvidence(item),
      ],
    });
  }

  const missing = questions.map((question) => legacyMissingName(question.field));
  const prompt = [...questions, ...conflicts]
    .map((entry) => entry.prompt)
    .filter(Boolean)
    .join(" ") || undefined;

  return {
    fields,
    missing: unique(missing),
    questions,
    conflicts,
    decisions: decisions.filter(
      (decision) =>
        serializedField(current[decision.field]) !==
        serializedField(decision.value),
    ),
    prompt,
    runner,
    evidenceFingerprint: triageEvidenceFingerprint(item, sources, context),
  };
}

export function matchingRunner(requirements, profiles) {
  const repositories = repositoryRequirements(requirements);
  const repository =
    repositories.length === 1 ? repositories[0].slice("repo:".length) : undefined;
  return profiles.find(
    (profile) =>
      profile.online &&
      (profile.playbooks
        ? profile.playbooks.some((playbook) =>
            (!repository ||
              !playbook.repositories ||
              playbook.repositories.includes(repository)) &&
            requirements.every((requirement) =>
              playbookSupports(requirement, playbook),
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

function resolveWorkstream({
  current,
  directive,
  sources,
  knownWorkstreams,
  decisions,
  questions,
}) {
  if (directive?.answer && directive.value) {
    const normalized = directive.value.replaceAll("\\", "/");
    if (validWorkstream(normalized) && knownWorkstream(normalized, knownWorkstreams)) {
      if (normalized !== current) {
        decisions.push({
          field: "workstream",
          value: normalized,
          rationale: "A marked PAN answer corrects the workstream.",
          evidence: directive.evidence,
        });
      }
      return normalized;
    }
  }
  if (current && validWorkstream(current) && knownWorkstream(current, knownWorkstreams)) {
    return current.replaceAll("\\", "/");
  }
  if (directive?.conflict) {
    return current || "";
  }
  if (directive?.value) {
    const normalized = directive.value.replaceAll("\\", "/");
    if (validWorkstream(normalized) && knownWorkstream(normalized, knownWorkstreams)) {
      decisions.push({
        field: "workstream",
        value: normalized,
        rationale: "An explicit Issue directive names a known workstream.",
        evidence: directive.evidence,
      });
      return normalized;
    }
    addQuestion(
      questions,
      "workstream",
      `"${directive.value}" is not a known workstream. Which workstream path should this use?`,
      directive.evidence,
    );
    return current || "";
  }
  if (current) {
    addQuestion(
      questions,
      "workstream",
      `"${current}" is not a known workstream. Which workstream path should this use?`,
      [{ kind: "project-field", locator: "workstream" }],
    );
    return current;
  }

  const candidates = workstreamCandidates(sources, knownWorkstreams);
  if (candidates.length === 1) {
    const value = candidates[0];
    decisions.push({
      field: "workstream",
      value,
      rationale: "The Issue text uniquely identifies a known workstream.",
      evidence: [
        ...matchingSourceEvidence(sources, workstreamTerms(value)),
        { kind: "workstream", locator: value },
      ],
    });
    return value;
  }
  if (candidates.length > 1) {
    addQuestion(
      questions,
      "workstream",
      `Which workstream should this use: ${candidates.join(", ")}?`,
      candidates.map((path) => ({ kind: "workstream", locator: path })),
    );
  }
  return "";
}

function resolveRequirements({
  item,
  sources,
  runners,
  workstream,
  humanQuestion,
  humanOwned,
  decisions,
  questions,
  conflicts,
}) {
  const current = currentRequirements(item);
  const latestAnswerSource = sources.filter((source) => source.answer).at(-1);
  const answerRequirements = unique(
    latestAnswerSource ? parseRequirements(latestAnswerSource.text) : [],
  );
  if (current.length > 0) {
    const currentRepositories = repositoryRequirements(current);
    const answerRepositories = repositoryRequirements(answerRequirements);
    if (answerRepositories.length === 1) {
      const corrected = unique([
        ...current.filter(
          (requirement) =>
            !requirement.startsWith("repo:") &&
            VALID_REQUIREMENT_PATTERN.test(requirement),
        ),
        ...answerRequirements,
      ]);
      if (
        repositoryRequirements(corrected).length === 1 &&
        serializedField(corrected) !== serializedField(current)
      ) {
        decisions.push({
          field: "requirements",
          value: corrected,
          rationale:
            "A marked PAN answer selects the authoritative repository requirement.",
          evidence: matchingSourceEvidence(
            latestAnswerSource ? [latestAnswerSource] : [],
            answerRequirements,
          ),
        });
        return corrected;
      }
    }
    if (currentRepositories.length > 1) {
      addQuestion(
        questions,
        "requirements",
        `The item has multiple repository requirements (${currentRepositories.join(", ")}). Which one is authoritative?`,
        [{ kind: "project-field", locator: "requirements" }],
      );
      return current;
    }
    const invalid = current.filter(
      (requirement) => !VALID_REQUIREMENT_PATTERN.test(requirement),
    );
    if (invalid.length > 0) {
      if (
        answerRequirements.length > 0 &&
        answerRequirements.every((requirement) =>
          VALID_REQUIREMENT_PATTERN.test(requirement),
        )
      ) {
        const corrected = unique([
          ...current.filter((requirement) =>
            VALID_REQUIREMENT_PATTERN.test(requirement),
          ),
          ...answerRequirements,
        ]);
        if (repositoryRequirements(corrected).length <= 1) {
          decisions.push({
            field: "requirements",
            value: corrected,
            rationale:
              "A marked PAN answer corrects invalid capability requirements.",
            evidence: matchingSourceEvidence(
              sources.filter((source) => source.answer),
              answerRequirements,
            ),
          });
          return corrected;
        }
      }
      addQuestion(
        questions,
        "requirements",
        `These requirements are invalid: ${invalid.join(", ")}. What capability requirements should this use?`,
        [{ kind: "project-field", locator: "requirements" }],
      );
      return current;
    }
    if (answerRequirements.length > 0) {
      const completed = unique([...current, ...answerRequirements]);
      if (repositoryRequirements(completed).length > 1) {
        conflicts.push({
          field: "requirements",
          prompt: `The answer conflicts with the existing repository requirement. Which repository is authoritative?`,
        });
        return current;
      }
      if (completed.length !== current.length) {
        decisions.push({
          field: "requirements",
          value: completed,
          rationale:
            "A marked PAN answer supplies the missing capability requirement.",
          evidence: matchingSourceEvidence(
            sources.filter((source) => source.answer),
            answerRequirements,
          ),
        });
        return completed;
      }
    }
    return current;
  }

  const allExplicit = unique(
    sources.flatMap((source) => parseRequirements(source.text)),
  );
  const explicit =
    repositoryRequirements(answerRequirements).length === 1
      ? unique([
          ...allExplicit.filter(
            (requirement) => !requirement.startsWith("repo:"),
          ),
          ...answerRequirements,
        ])
      : allExplicit;
  if (repositoryRequirements(explicit).length > 1) {
    conflicts.push({
      field: "requirements",
      prompt: `The Issue names multiple repositories: ${repositoryRequirements(explicit).join(", ")}. Which one should the agent change?`,
    });
    return [];
  }
  if (explicit.length > 0) {
    decisions.push({
      field: "requirements",
      value: explicit,
      rationale: "The Issue explicitly names capability requirements.",
      evidence: matchingSourceEvidence(sources, explicit),
    });
    return explicit;
  }
  if (humanQuestion || humanOwned || !workstream) {
    return [];
  }

  const route = inferRunnerRoute(item, workstream, runners);
  if (!route) {
    return [];
  }
  const requirements = [
    `repo:${route.repository}`,
    ...(route.delivery ? [`delivery:${route.delivery}`] : []),
  ];
  decisions.push({
    field: "requirements",
    value: requirements,
    rationale:
      "The workstream and Issue text identify one repository route advertised by available runners.",
    evidence: [
      issueEvidence(item, "title"),
      { kind: "workstream", locator: workstream },
      ...route.runners.map((runner) => ({ kind: "runner", locator: runner })),
    ],
  });
  return requirements;
}

function resolveEnumField({
  field,
  current,
  currentIsExplicit = true,
  directive,
  infer,
  decisions,
  questions,
}) {
  const allowed = FIELD_OPTIONS[field];
  if (directive?.answer && directive.value) {
    if (allowed.includes(directive.value)) {
      if (directive.value !== current) {
        decisions.push({
          field,
          value: directive.value,
          rationale: `A marked PAN answer corrects the ${field}.`,
          evidence: directive.evidence,
        });
      }
      return directive.value;
    }
  }
  if (currentIsExplicit && allowed.includes(current)) {
    return current;
  }
  if (directive?.conflict) {
    return current || "";
  }
  if (directive?.value) {
    if (allowed.includes(directive.value)) {
      decisions.push({
        field,
        value: directive.value,
        rationale: `An explicit Issue directive supplies the ${field}.`,
        evidence: directive.evidence,
      });
      return directive.value;
    }
    addQuestion(
      questions,
      field,
      `"${directive.value}" is not a valid ${field}. Choose one of: ${allowed.join(", ")}.`,
      directive.evidence,
    );
    return current || "";
  }
  if (current && currentIsExplicit) {
    addQuestion(
      questions,
      field,
      `"${current}" is not a valid ${field}. Choose one of: ${allowed.join(", ")}.`,
      [{ kind: "project-field", locator: field }],
    );
    return current;
  }
  const result = infer();
  if (!result) {
    return "";
  }
  decisions.push({
    field,
    value: result.value,
    rationale: result.rationale,
    evidence: result.evidence,
  });
  return result.value;
}

function inferPriority(item) {
  const text = `${item.title ?? ""}\n${item.body ?? ""}`;
  if (/\b(?:urgent|asap|immediately|critical|blocker|today)\b/i.test(text)) {
    return inferred(
      "urgent",
      "The Issue contains an explicit urgency signal.",
      issueEvidence(item),
    );
  }
  if (/\b(?:high priority|soon|time-sensitive)\b/i.test(text)) {
    return inferred(
      "high",
      "The Issue contains a high-priority timing signal.",
      issueEvidence(item),
    );
  }
  return inferred(
    "normal",
    "The Issue contains no urgency signal, so the standard priority applies.",
    issueEvidence(item),
  );
}

function inferRunnerRoute(item, workstream, runners) {
  const text = normalizeSearchText(`${item.title ?? ""}\n${item.body ?? ""}`);
  const workstreamName = workstream.split("/").at(-1).toLowerCase();
  const routes = new Map();
  for (const runner of runners) {
    for (const playbook of runner.playbooks ?? []) {
      for (const repository of playbook.repositories ?? []) {
        const name = repository.split("/").at(-1).toLowerCase();
        const mentioned =
          containsRepository(text, repository) ||
          containsIdentifier(text, name) ||
          name === workstreamName;
        if (!mentioned) {
          continue;
        }
        const route = routes.get(repository) ?? {
          repository,
          deliveries: new Set(),
          runners: new Set(),
        };
        if (playbook.delivery) {
          route.deliveries.add(playbook.delivery);
        }
        route.runners.add(runner.id);
        routes.set(repository, route);
      }
    }
  }
  if (routes.size !== 1) {
    return undefined;
  }
  const route = [...routes.values()][0];
  return {
    repository: route.repository,
    delivery:
      route.deliveries.size === 1 ? [...route.deliveries][0] : undefined,
    runners: [...route.runners],
  };
}

function parseDirectiveEvidence(sources) {
  const values = {};
  const conflicts = [];
  for (const field of ["owner", "priority", "autonomy", "workstream"]) {
    const latestAnswer = sources.filter((source) => source.answer).at(-1);
    const answerCandidates = latestAnswer
      ? directiveCandidates([latestAnswer], field)
      : [];
    const candidates =
      answerCandidates.length > 0
        ? answerCandidates
        : directiveCandidates(sources, field);
    const distinct = unique(candidates.map((candidate) => candidate.value));
    if (distinct.length > 1) {
      conflicts.push({
        field,
        prompt: `The Issue contains conflicting ${field} values (${distinct.join(", ")}). Which value is authoritative?`,
      });
      values[field] = { conflict: true };
      continue;
    }
    if (candidates.length > 0) {
      values[field] = {
        value: candidates.at(-1).value,
        evidence: candidates.map((candidate) => candidate.evidence),
        answer: answerCandidates.length > 0,
      };
    }
  }
  return { values, conflicts };
}

function directiveCandidates(sources, expectedField) {
  const candidates = [];
  for (const source of sources) {
    for (const match of source.text.matchAll(DIRECTIVE_PATTERN)) {
      if (match[1].toLowerCase() !== expectedField) {
        continue;
      }
      candidates.push({
        value: match[2].trim().toLowerCase(),
        evidence: source.evidence,
      });
    }
  }
  return candidates;
}

function evidenceSources(item, comments) {
  const sources = [
    {
      text: item.title ?? "",
      evidence: issueEvidence(item, "title"),
    },
    {
      text: item.body ?? "",
      evidence: issueEvidence(item, "body"),
    },
  ];
  for (const comment of comments) {
    const body = comment.body ?? "";
    const answer = body.includes("<!-- pan:answer -->");
    if (
      (!answer && body.includes("<!-- pan:")) ||
      body.includes("<!-- pan:needs-human -->") ||
      body.includes("<!-- pan:needs-human-resolved -->") ||
      body.includes("<!-- pan:triage-decision:")
    ) {
      continue;
    }
    sources.push({
      text: answer
        ? answerTexts([comment])[0] ?? ""
        : stripPanMarkers(body),
      answer,
      evidence: {
        kind: "issue-comment",
        locator: comment.url ?? comment.id ?? item.url,
      },
    });
  }

  return sources;
}

function currentRequirements(item) {
  return unique([
    ...(item.requirements ?? []),
    ...String(item.fields?.requirements ?? "")
      .split(/\r?\n/)
      .map((requirement) => requirement.trim()),
  ]);
}

function stripPanMarkers(text) {
  return String(text)
    .replace(/<!--\s*pan:[^>]+-->/gi, "")
    .replace(/^###\s+(?:Answer|Needs human|Attention resolved)\s*$/gim, "")
    .trim();
}

function triageEvidenceFingerprint(item, sources, context) {
  const evidence = {
    item: {
      id: item.id,
      title: item.title,
      body: item.body,
      state: item.state,
      fields: item.fields,
      requirements: item.requirements,
    },
    sources: sources.map((source) => ({
      text: source.text,
      answer: source.answer === true,
      evidence: source.evidence,
    })),
    workstreams: normalizeWorkstreams(context.workstreams),
    runners: (context.runners ?? []).map((runner) => ({
      id: runner.id,
      online: runner.online,
      capabilities: runner.capabilities,
      playbooks: runner.playbooks,
    })),
  };
  return createHash("sha256")
    .update(stableStringify(evidence))
    .digest("hex");
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${stableStringify(value[key])}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function normalizeWorkstreams(workstreams = []) {
  return unique(
    workstreams
      .map((workstream) =>
        typeof workstream === "string" ? workstream : workstream?.path,
      )
      .filter(Boolean),
  );
}

function workstreamCandidates(sources, workstreams) {
  return workstreams.filter((workstream) =>
    matchingSourceEvidence(sources, workstreamTerms(workstream)).length > 0,
  );
}

function workstreamTerms(workstream) {
  const name = workstream.split("/").at(-1);
  return unique([workstream, name]).filter((term) => term.length >= 3);
}

function matchingSourceEvidence(sources, terms) {
  const normalizedTerms = terms.map((term) => term.toLowerCase());
  return uniqueEvidence(
    sources
      .filter((source) => {
        const text = normalizeSearchText(source.text);
        return normalizedTerms.some((term) => containsWord(text, term));
      })
      .map((source) => source.evidence),
  );
}

function knownWorkstream(value, knownWorkstreams) {
  return knownWorkstreams.length === 0 || knownWorkstreams.includes(value);
}

function validStatus(value) {
  return [
    "untriaged",
    "needs-detail",
    "ready",
    "in-progress",
    "in-review",
    "done",
    "blocked",
  ].includes(value);
}

function validWorkstream(value) {
  return (
    typeof value === "string" &&
    !value.startsWith("/") &&
    !value.endsWith("/") &&
    !value.includes("..") &&
    /^[A-Za-z0-9_.\/-]+$/.test(value)
  );
}

function parseRequirements(text) {
  return unique(
    [...String(text).matchAll(REQUIREMENT_PATTERN)]
      .map((match) => match[0])
      .filter(
        (requirement) =>
          !["owner", "priority", "autonomy", "workstream", "pan"].includes(
            requirement.split(":", 1)[0].toLowerCase(),
          ) &&
          !requirement.includes("://") &&
          !["http", "https"].includes(
            requirement.split(":", 1)[0].toLowerCase(),
          ),
      ),
  );
}

function repositoryRequirements(requirements) {
  return requirements.filter((requirement) =>
    requirement.toLowerCase().startsWith("repo:"),
  );
}

function playbookSupports(requirement, playbook) {
  if (requirement.startsWith("delivery:")) {
    return requirement === `delivery:${playbook.delivery}`;
  }
  if (requirement.startsWith("repo:")) {
    const repository = requirement.slice("repo:".length);
    return (
      playbook.capabilities.includes(requirement) ||
      playbook.repositories?.includes(repository)
    );
  }
  return playbook.capabilities.includes(requirement);
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
          /^(?:[-*]\s*)?(?:[A-Za-z][A-Za-z0-9-]*:[A-Za-z0-9_.\/-]+\s*)+$/i,
        )
      );
    })
    .join("\n")
    .trim();
}

function looksLikeHumanQuestion(title = "") {
  const trimmed = title.trim();
  return (
    trimmed.endsWith("?") ||
    /^(?:why|what|how|where|who|when|can|could|would|is|are|do|does|will)\b/i.test(
      trimmed,
    )
  );
}

function issueEvidence(item, label) {
  return {
    kind: "issue",
    locator: item.url ?? item.id ?? String(item.number),
    ...(label ? { label } : {}),
  };
}

function fieldEvidence(item, field, value) {
  return {
    kind: "project-field",
    locator: `${item.id ?? item.url}:${field}=${value}`,
  };
}

function requirementEvidence(item, requirements, sources) {
  const evidence = matchingSourceEvidence(sources, requirements);
  return evidence.length > 0 ? evidence : [issueEvidence(item)];
}

function inferred(value, rationale, evidence) {
  return { value, rationale, evidence: Array.isArray(evidence) ? evidence : [evidence] };
}

function addQuestion(questions, field, prompt, evidence = []) {
  if (questions.some((question) => question.field === field)) {
    return;
  }
  questions.push({
    field,
    prompt,
    evidence: Array.isArray(evidence) ? evidence : [evidence],
  });
}

function legacyMissingName(field) {
  return {
    workstream: "a workstream path",
    requirements: "exactly one repo:<owner/name> requirement",
    description: "a task description or acceptance criteria",
    owner: "an owner",
    priority: "a priority",
    autonomy: "an autonomy policy",
  }[field] ?? field;
}

function normalizeSearchText(value) {
  return String(value).toLowerCase().replaceAll("\\", "/");
}

function containsWord(text, word) {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`, "i").test(
    text,
  );
}

function containsRepository(text, repository) {
  const escaped = repository.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `(?:^|[^a-z0-9_./-])${escaped}(?:$|[^a-z0-9_./-])`,
    "i",
  ).test(text);
}

function containsIdentifier(text, identifier) {
  const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `(?:^|[^a-z0-9_.-])${escaped}(?:$|[^a-z0-9_.-])`,
    "i",
  ).test(text);
}

function serializedField(value) {
  return Array.isArray(value) ? value.join("\n") : value ?? "";
}

function unique(values) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function uniqueEvidence(values) {
  const seen = new Set();
  return values.filter((value) => {
    const key = `${value.kind}\0${value.locator}\0${value.label ?? ""}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}
