import { SESSION_REVIEW_DUE_TOLERANCE_SECONDS } from "./session-due-state.js";

export const COPILOT_SCHEDULING_CONTRACT_VERSION = 1;
export const MAX_NATIVE_SCHEDULE_INTERVAL_SECONDS = 3_600;

const REQUIRED_SESSION_OPTIONS = [
  "--agent",
  "--add-dir",
  "--model",
  "--no-auto-update",
  "--interactive",
];

/**
 * Verifies the documented Copilot CLI features that Pan relies on.
 *
 * Only command-line options are checked. Interactive slash commands such as
 * `/every` are absent from every help surface, so their support cannot be
 * probed; the session reports instead when it cannot establish its schedule.
 */
export async function verifyCopilotInvocationContract({
  executable = "copilot",
  commands,
} = {}) {
  if (!commands?.run) {
    throw new TypeError("commands with run() are required");
  }
  const help = await commands.run(executable, ["--help"], {
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  const missing = REQUIRED_SESSION_OPTIONS.filter((option) => !help.includes(option));
  if (missing.length > 0) {
    throw new Error(
      `Copilot CLI does not support the required Pan session options: ${missing.join(", ")}.`,
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
  const reviewPrompt = buildScheduledReviewPrompt({
    dueStatePath,
    triageAuthority: scheduling.triageAuthority,
  });
  const startup = startupInstruction({
    startup: scheduling.startup,
    intervalSeconds,
  });
  return [
    "Establish exactly one native session-scoped recurring schedule; do not create a Node timer, detached process, or external queue.",
    `Use ${manualScheduleCommand({ intervalSeconds, prompt: reviewPrompt })}.`,
    startup,
    "The Copilot session queue is the only non-overlap mechanism. Keep failed or incomplete reviews visible in this session. If the schedule cannot be created, say so immediately and continue without one rather than substituting another mechanism.",
  ].join("\n\n");
}

export function buildScheduledReviewPrompt({ dueStatePath, triageAuthority = "report" } = {}) {
  if (!dueStatePath) {
    throw new TypeError("dueStatePath is required");
  }
  return [
    "Run the scheduled Pan portfolio review in this session.",
    `Read the launch-local due metadata at ${dueStatePath}. Treat the review as due when nextReviewAt is in the past or within the next ${SESSION_REVIEW_DUE_TOLERANCE_SECONDS} seconds, because the recurring tick and the due time drift against each other; a near-miss otherwise costs a full interval. If nextReviewAt is further out than that, report that no review is due and make no portfolio decision or mutation.`,
    "When due, read the configured Project and current Issue state directly from GitHub. Never import unrelated Issues, resurrect closed Issues, or alter active runner lease fields.",
    mutationPolicyInstruction(triageAuthority),
    "Re-read each target immediately before an approved write and verify it afterward.",
    "After a completed review attempt, update the due metadata with the review time and next configured due time. Follow the configured bounded retry and rate-limit guidance; never busy-loop or create another schedule.",
    "Report failed or incomplete reviews accurately in this session.",
  ].join(" ");
}

function mutationPolicyInstruction(triageAuthority) {
  switch (triageAuthority) {
    case "report":
      return "Discuss recommendations before mutation unless the user has already granted specific approval.";
    case "triage-fields":
      return "You have a standing policy to triage untriaged items without asking, where untriaged means the item has no Status. Triage means setting every field needed to make the item actionable: owner, Status, priority, workstream, and the requirements that select a playbook. Never leave an item owner agent and Status ready with empty requirements, because no runner can claim it. Leave every already-triaged item to an explicit approval.";
    default:
      throw new TypeError(`Unsupported Pan scheduling triage authority: ${triageAuthority}`);
  }
}

export function nativeScheduleIntervalSeconds(reviewIntervalSeconds) {
  if (!Number.isInteger(reviewIntervalSeconds) || reviewIntervalSeconds <= 0) {
    throw new TypeError("reviewIntervalSeconds must be a positive integer");
  }
  return Math.min(reviewIntervalSeconds, MAX_NATIVE_SCHEDULE_INTERVAL_SECONDS);
}

export function manualScheduleCommand({
  intervalSeconds,
  prompt = "Run the scheduled Pan portfolio review.",
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
      throw new TypeError(`Unsupported Pan scheduling startup policy: ${startup}`);
  }
}

function formatScheduleInterval(seconds) {
  return `${seconds}s`;
}
