export const COPILOT_SCHEDULING_CONTRACT_VERSION = 1;
export const MAX_NATIVE_SCHEDULE_INTERVAL_SECONDS = 3_600;

const REQUIRED_SESSION_OPTIONS = [
  "--agent",
  "--add-dir",
  "--model",
  "--no-auto-update",
  "--interactive",
];
const REQUIRED_SCHEDULING_COMMANDS = ["/every", "/after"];

/**
 * Verifies the documented Copilot CLI features that PAN relies on.
 */
export async function verifyCopilotInvocationContract({
  executable = "copilot",
  commands,
  requireScheduling = false,
  scheduling,
} = {}) {
  if (!commands?.run) {
    throw new TypeError("commands with run() are required");
  }
  const help = await commands.run(executable, ["--help"], {
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  const required = [
    ...REQUIRED_SESSION_OPTIONS,
    ...(requireScheduling ? REQUIRED_SCHEDULING_COMMANDS : []),
  ];
  const missing = required.filter((option) => !help.includes(option));
  if (missing.length > 0) {
    const manual = requireScheduling
      ? ` Upgrade Copilot CLI or start without scheduling, then create the schedule manually with ${manualScheduleCommand({
          intervalSeconds: scheduling?.reviewIntervalSeconds
            ? nativeScheduleIntervalSeconds(scheduling.reviewIntervalSeconds)
            : MAX_NATIVE_SCHEDULE_INTERVAL_SECONDS,
        })}.`
      : "";
    throw new Error(
      `Copilot CLI does not support the required PAN session options: ${missing.join(", ")}.${manual}`,
    );
  }
}

/**
 * Creates the initial session request that delegates scheduling to Copilot.
 */
export function buildScheduleBootstrapPrompt({
  scheduling,
  dueStatePath,
} = {}) {
  if (!scheduling?.enabled) {
    return undefined;
  }
  if (!dueStatePath) {
    throw new TypeError("dueStatePath is required when scheduling is enabled");
  }

  const intervalSeconds = nativeScheduleIntervalSeconds(scheduling.reviewIntervalSeconds);
  const reviewPrompt = buildScheduledReviewPrompt({ dueStatePath });
  const startup = startupInstruction({
    startup: scheduling.startup,
    intervalSeconds,
  });
  return [
    "Establish exactly one native session-scoped recurring schedule; do not create a Node timer, detached process, or external queue.",
    `Use ${manualScheduleCommand({ intervalSeconds, prompt: reviewPrompt })}.`,
    startup,
    "The Copilot session queue is the only non-overlap mechanism. Keep failed or incomplete reviews visible in this session.",
  ].join("\n\n");
}

export function buildScheduledReviewPrompt({ dueStatePath } = {}) {
  if (!dueStatePath) {
    throw new TypeError("dueStatePath is required");
  }
  return [
    "Run the scheduled PAN portfolio review in this session.",
    `Read the launch-local due metadata at ${dueStatePath}. If its nextReviewAt is still in the future, report that no review is due and make no portfolio decision or mutation.`,
    "When due, read the configured Project and current Issue state directly from GitHub. Never import unrelated Issues, resurrect closed Issues, or alter active runner lease fields.",
    "Discuss recommendations before mutation unless the user has already granted specific approval. Re-read each target immediately before an approved write and verify it afterward.",
    "After a completed review attempt, update the due metadata with the review time and next configured due time. Follow the configured bounded retry and rate-limit guidance; never busy-loop or create another schedule.",
    "Report failed or incomplete reviews accurately in this session.",
  ].join(" ");
}

export function nativeScheduleIntervalSeconds(reviewIntervalSeconds) {
  if (!Number.isInteger(reviewIntervalSeconds) || reviewIntervalSeconds <= 0) {
    throw new TypeError("reviewIntervalSeconds must be a positive integer");
  }
  return Math.min(reviewIntervalSeconds, MAX_NATIVE_SCHEDULE_INTERVAL_SECONDS);
}

export function manualScheduleCommand({
  intervalSeconds,
  prompt = "Run the scheduled PAN portfolio review.",
} = {}) {
  if (!Number.isInteger(intervalSeconds) || intervalSeconds <= 0) {
    throw new TypeError("intervalSeconds must be a positive integer");
  }
  return `/every ${formatScheduleInterval(intervalSeconds)} ${prompt}`;
}

function startupInstruction({ startup, intervalSeconds }) {
  switch (startup) {
    case "immediate":
      return `Run one fresh startup review now, then record its next due time. Do not create an additional startup schedule.`;
    case "after-interval":
      return `Do not review at startup. The recurring schedule's first turn after ${formatScheduleInterval(intervalSeconds)} performs the first due check.`;
    case "manual":
      return "Do not run a startup review. The recurring schedule remains the only automatic review trigger.";
    default:
      throw new TypeError(`Unsupported PAN scheduling startup policy: ${startup}`);
  }
}

function formatScheduleInterval(seconds) {
  return `${seconds}s`;
}
