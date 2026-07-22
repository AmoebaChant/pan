const args = process.argv.slice(2);
const failures = [];

if (process.cwd() !== process.env.FAKE_COPILOT_EXPECTED_CWD) {
  failures.push("Copilot did not start in the configured domain root");
}
if (!args.includes("--agent") || !args.includes(process.env.FAKE_COPILOT_EXPECTED_AGENT)) {
  failures.push("Copilot did not select the configured PAN agent");
}
if (!args.includes("--no-auto-update")) {
  failures.push("Copilot did not receive ordinary session defaults");
}
if (args.some((arg) => /mcp/i.test(arg))) {
  failures.push("Copilot received a retired MCP argument");
}
if (process.env.PAN_SESSION_MODE === "writing" && !process.env.PAN_LEADERSHIP_GENERATION) {
  failures.push("Writing Copilot session lacks leadership generation");
}
if (
  process.env.FAKE_COPILOT_EXPECT_SCHEDULE === "1" &&
  (!args.includes("--interactive") || !process.env.PAN_SCHEDULE_DUE_STATE)
) {
  failures.push("Writing Copilot session lacks its native schedule bootstrap");
}
if (
  process.env.FAKE_COPILOT_EXPECT_SCHEDULE !== "1" &&
  (args.includes("--interactive") || process.env.PAN_SCHEDULE_DUE_STATE)
) {
  failures.push("Read-only Copilot session received scheduling authority");
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exitCode = 97;
} else if (process.env.FAKE_COPILOT_LIFETIME !== "hold") {
  process.exitCode = Number(process.env.FAKE_COPILOT_EXIT_CODE ?? 0);
} else {
  const keepAlive = setInterval(() => {}, 1_000);
  const stop = () => {
    clearInterval(keepAlive);
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
