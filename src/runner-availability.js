export function buildRunnerAvailability(
  profiles,
  { activeLeaseCounts = {} } = {},
) {
  if (!Array.isArray(profiles)) {
    throw new TypeError("profiles must be an array");
  }
  const diagnostics = [];
  const runners = [];
  const seen = new Set();

  for (const profile of [...profiles].sort((left, right) =>
    String(left?.id ?? "").localeCompare(String(right?.id ?? "")),
  )) {
    let runner;
    try {
      let activeLeaseCount = readActiveCount(
        activeLeaseCounts,
        profile?.id,
      );
      const observed =
        activeLeaseCount === undefined
          ? profile?.activeLeaseCount
          : activeLeaseCount;
      if (
        observed !== undefined &&
        observed !== null &&
        (!Number.isInteger(observed) || observed < 0)
      ) {
        diagnostics.push({
          runnerId:
            typeof profile?.id === "string" ? profile.id : undefined,
          code: "invalid-active-count",
          message: `Runner ${profile?.id ?? "unknown"} active lease count is invalid; capacity is unknown`,
        });
        activeLeaseCount = null;
      }
      runner = normalizeRunnerAvailability(profile, {
        activeLeaseCount,
      });
    } catch (error) {
      diagnostics.push({
        runnerId:
          typeof profile?.id === "string" ? profile.id : undefined,
        code: "invalid-availability",
        message: error.message,
      });
      continue;
    }
    if (seen.has(runner.id)) {
      diagnostics.push({
        runnerId: runner.id,
        code: "duplicate-runner",
        message: `Runner ID ${runner.id} is advertised more than once`,
      });
      continue;
    }
    seen.add(runner.id);
    runners.push(runner);
  }

  return {
    complete: diagnostics.length === 0,
    runners,
    diagnostics,
  };
}

export function normalizeRunnerAvailability(
  profile,
  { activeLeaseCount } = {},
) {
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
    throw new TypeError("runner profile must be an object");
  }
  requireString(profile.id, "runner ID");
  if (typeof profile.online !== "boolean") {
    throw new TypeError(`Runner ${profile.id} online state must be boolean`);
  }
  if (
    !Array.isArray(profile.capabilities) ||
    profile.capabilities.length === 0 ||
    profile.capabilities.some(
      (capability) =>
        typeof capability !== "string" || !capability.trim(),
    )
  ) {
    throw new TypeError(
      `Runner ${profile.id} capabilities must be non-empty strings`,
    );
  }
  if (new Set(profile.capabilities).size !== profile.capabilities.length) {
    throw new TypeError(
      `Runner ${profile.id} capabilities must not contain duplicates`,
    );
  }
  if (
    !Number.isInteger(profile.maxConcurrentDaemons) ||
    profile.maxConcurrentDaemons < 1
  ) {
    throw new TypeError(
      `Runner ${profile.id} maximum capacity must be a positive integer`,
    );
  }

  const observed =
    activeLeaseCount === undefined
      ? profile.activeLeaseCount
      : activeLeaseCount;
  const capacityKnown =
    Number.isInteger(observed) && observed >= 0;
  if (
    observed !== undefined &&
    observed !== null &&
    !capacityKnown
  ) {
    throw new TypeError(
      `Runner ${profile.id} active lease count must be a non-negative integer`,
    );
  }

  return {
    id: profile.id,
    online: profile.online,
    capabilities: [...profile.capabilities].sort(),
    maximumCapacity: profile.maxConcurrentDaemons,
    activeLeaseCount: capacityKnown ? observed : null,
    freeCapacity:
      profile.online && capacityKnown
        ? Math.max(0, profile.maxConcurrentDaemons - observed)
        : 0,
    capacityKnown,
  };
}

function readActiveCount(activeLeaseCounts, runnerId) {
  if (!runnerId) {
    return undefined;
  }
  if (activeLeaseCounts instanceof Map) {
    return activeLeaseCounts.get(runnerId);
  }
  return activeLeaseCounts?.[runnerId];
}

function requireString(value, name) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
}
