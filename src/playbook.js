const LEGACY_PLAYBOOK_ID = "legacy";

export function normalizePlaybooks(profile) {
  if (profile.playbooks === undefined) {
    return [
      {
        id: LEGACY_PLAYBOOK_ID,
        capacity: profile.maxConcurrentDaemons,
        capabilities: [...profile.capabilities],
        repositories: Object.keys(profile.repositories),
        instructions: [],
        legacy: true,
      },
    ];
  }
  if (!Array.isArray(profile.playbooks) || profile.playbooks.length === 0) {
    throw new TypeError("playbooks must be a non-empty array");
  }

  const playbooks = profile.playbooks.map((playbook, index) =>
    validatePlaybook(playbook, {
      name: `playbooks[${index}]`,
      capabilities: profile.capabilities,
      repositories: profile.repositories,
    }),
  );
  const ids = playbooks.map((playbook) => playbook.id);
  if (new Set(ids).size !== ids.length) {
    throw new TypeError("playbook IDs must not contain duplicates");
  }
  return playbooks;
}

export function validatePlaybook(
  playbook,
  { name = "playbook", capabilities, repositories } = {},
) {
  if (!playbook || typeof playbook !== "object" || Array.isArray(playbook)) {
    throw new TypeError(`${name} must be an object`);
  }
  if (playbook.delivery !== undefined) {
    throw new TypeError(
      `${name}.delivery is retired: describe how to deliver in ${name}.instructions instead`,
    );
  }
  requireString(playbook.id, `${name}.id`);
  requireInteger(playbook.capacity, `${name}.capacity`, { minimum: 0 });
  requireStringArray(playbook.capabilities, `${name}.capabilities`, {
    nonEmpty: true,
  });
  requireStringArray(playbook.repositories, `${name}.repositories`, {
    nonEmpty: true,
  });
  requireStringArray(playbook.instructions ?? [], `${name}.instructions`);
  if (playbook.workingDirectory !== undefined) {
    requireString(playbook.workingDirectory, `${name}.workingDirectory`);
    if (!isAbsolutePath(playbook.workingDirectory)) {
      throw new TypeError(`${name}.workingDirectory must be an absolute path`);
    }
  }

  if (new Set(playbook.capabilities).size !== playbook.capabilities.length) {
    throw new TypeError(`${name}.capabilities must not contain duplicates`);
  }
  if (new Set(playbook.repositories).size !== playbook.repositories.length) {
    throw new TypeError(`${name}.repositories must not contain duplicates`);
  }
  for (const repository of playbook.repositories) {
    if (repositories && !repositories[repository]) {
      throw new TypeError(
        `${name}.repositories contains unconfigured repository ${repository}`,
      );
    }
    if (!playbook.capabilities.includes(`repo:${repository}`)) {
      throw new TypeError(
        `${name}.capabilities must include repo:${repository}`,
      );
    }
  }
  if (capabilities) {
    for (const capability of playbook.capabilities) {
      if (!capabilities.includes(capability)) {
        throw new TypeError(
          `${name}.capabilities contains unavailable capability ${capability}`,
        );
      }
    }
  }

  return {
    id: playbook.id.trim(),
    capacity: playbook.capacity,
    capabilities: [...playbook.capabilities],
    repositories: [...playbook.repositories],
    instructions: [...(playbook.instructions ?? [])],
    ...(playbook.workingDirectory === undefined
      ? {}
      : { workingDirectory: playbook.workingDirectory.trim() }),
    legacy: false,
  };
}

export function matchingPlaybook(item, profile, activeCounts = new Map()) {
  const repository = taskRepository(item);
  if (!repository || !profile.repositories[repository]) {
    return undefined;
  }
  return profile.playbooks.find(
    (playbook) =>
      playbook.repositories.includes(repository) &&
      (activeCounts.get(playbook.id) ?? 0) < playbook.capacity &&
      item.requirements.every((requirement) =>
        playbook.capabilities.includes(requirement),
      ),
  );
}

export function taskRepository(item) {
  const repositories = repositoryRequirements(item);
  return repositories.length === 1 ? repositories[0] : undefined;
}

/** Requirements no playbook serving this task's repository can ever provide. */
export function unsatisfiableRequirements(item, profile) {
  const repository = taskRepository(item);
  if (!repository) {
    return [];
  }
  const serving = profile.playbooks.filter((playbook) =>
    playbook.repositories.includes(repository),
  );
  if (serving.length === 0) {
    return [];
  }
  const provided = new Set(
    serving.flatMap((playbook) => playbook.capabilities),
  );
  return (item.requirements ?? []).filter(
    (requirement) => !provided.has(requirement),
  );
}

export function dispatchBlocker(item) {
  if (item.fields?.owner !== "agent") {
    return {
      code: "owner-not-agent",
      message: `owner is ${item.fields?.owner ?? "unset"}, not agent`,
    };
  }
  const repositories = repositoryRequirements(item);
  if (repositories.length === 0) {
    return {
      code: "repository-requirement-missing",
      message:
        "requirements have no repo: entry, so no playbook can be selected",
    };
  }
  if (repositories.length > 1) {
    return {
      code: "repository-requirement-ambiguous",
      message: `requirements name ${repositories.length} repositories (${repositories.join(", ")}); exactly one repo: entry is required`,
    };
  }
  return undefined;
}

export function playbookBlocker(item, profile, activeCounts = new Map()) {
  const blocker = dispatchBlocker(item);
  if (blocker) {
    return blocker;
  }
  const repository = taskRepository(item);
  if (!profile.repositories[repository]) {
    return {
      code: "repository-unconfigured",
      message: `runner has no repository entry for ${repository}`,
    };
  }
  const serving = profile.playbooks.filter((playbook) =>
    playbook.repositories.includes(repository),
  );
  if (serving.length === 0) {
    return {
      code: "no-playbook-for-repository",
      message: `no playbook serves ${repository}`,
    };
  }
  const unsatisfiable = unsatisfiableRequirements(item, profile);
  if (unsatisfiable.length > 0) {
    const advertised = [
      ...new Set(serving.flatMap((playbook) => playbook.capabilities)),
    ].sort();
    return {
      code: "requirements-unsatisfiable",
      requirements: unsatisfiable,
      message: `no playbook for ${repository} can ever satisfy ${unsatisfiable.join(", ")}; playbooks serving it advertise ${advertised.join(", ")}`,
    };
  }
  const reasons = serving.map(
    (playbook) =>
      `${playbook.id} (${explainPlaybookRejection(item, playbook, activeCounts)})`,
  );
  return {
    code: "no-compatible-playbook",
    message: `no playbook for ${repository} can take it: ${reasons.join("; ")}`,
  };
}

function explainPlaybookRejection(item, playbook, activeCounts) {
  if (playbook.capacity === 0) {
    return "disabled";
  }
  const active = activeCounts.get(playbook.id) ?? 0;
  if (active >= playbook.capacity) {
    return `at capacity ${active}/${playbook.capacity}`;
  }
  const missing = item.requirements.filter(
    (requirement) => !playbook.capabilities.includes(requirement),
  );
  if (missing.length > 0) {
    return `missing ${missing.join(", ")}`;
  }
  return "eligible";
}

function repositoryRequirements(item) {
  return (item.requirements ?? [])
    .filter((requirement) => requirement.startsWith("repo:"))
    .map((requirement) => requirement.slice("repo:".length));
}

function requireString(value, name) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
}

function requireStringArray(value, name, { nonEmpty = false } = {}) {
  if (
    !Array.isArray(value) ||
    (nonEmpty && value.length === 0) ||
    value.some((entry) => typeof entry !== "string" || !entry.trim())
  ) {
    throw new TypeError(`${name} must be an array of non-empty strings`);
  }
}

function requireInteger(value, name, { minimum = 1 } = {}) {
  if (!Number.isInteger(value) || value < minimum) {
    throw new TypeError(`${name} must be an integer >= ${minimum}`);
  }
}

function isAbsolutePath(value) {
  return /^([a-zA-Z]:[\\/]|[\\/])/.test(value.trim());
}
