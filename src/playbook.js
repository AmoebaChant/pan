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
        delivery: "pull-request",
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
  requireString(playbook.id, `${name}.id`);
  requireInteger(playbook.capacity, `${name}.capacity`, { minimum: 0 });
  requireStringArray(playbook.capabilities, `${name}.capabilities`, {
    nonEmpty: true,
  });
  requireStringArray(playbook.repositories, `${name}.repositories`, {
    nonEmpty: true,
  });
  requireStringArray(playbook.instructions ?? [], `${name}.instructions`);
  const delivery =
    playbook.delivery === undefined
      ? "pull-request"
      : playbook.delivery;
  if (!["pull-request", "direct", "report", "playbook"].includes(delivery)) {
    throw new TypeError(
      `${name}.delivery must be "pull-request", "direct", "report", or "playbook"`,
    );
  }
  if (delivery === "playbook") {
    requireString(playbook.workingDirectory, `${name}.workingDirectory`);
    if (!isAbsolutePath(playbook.workingDirectory)) {
      throw new TypeError(`${name}.workingDirectory must be an absolute path`);
    }
  } else if (playbook.workingDirectory !== undefined) {
    throw new TypeError(
      `${name}.workingDirectory is only valid for playbook delivery`,
    );
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
    delivery,
    ...(delivery === "playbook"
      ? { workingDirectory: playbook.workingDirectory.trim() }
      : {}),
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
        requirement.startsWith("delivery:")
          ? requirement === `delivery:${playbook.delivery}`
          : playbook.capabilities.includes(requirement),
      ),
  );
}

export function taskRepository(item) {
  const repositories = item.requirements
    .filter((requirement) => requirement.startsWith("repo:"))
    .map((requirement) => requirement.slice("repo:".length));
  return repositories.length === 1 ? repositories[0] : undefined;
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
