import { spawn } from "node:child_process";

import { PanAssetService } from "./pan-assets.js";
import { verifyCopilotInvocationContract } from "./copilot-contract.js";
import { ProcessClient } from "./process-client.js";

const ONBOARDING_PROMPT = "Hi Pan";

/** Starts the conversational setup experience after installing its Copilot assets. */
export async function startPanOnboarding({
  env = process.env,
  cwd = process.cwd(),
  executable = env.PAN_COPILOT_EXECUTABLE ?? "copilot",
  assetService = new PanAssetService({ env }),
  commands = new ProcessClient(),
  spawnProcess = spawn,
} = {}) {
  const assets = await assetService.install();
  await verifyCopilotInvocationContract({
    executable,
    commands,
    requireScheduling: false,
  });
  const child = spawnProcess(
    executable,
    buildOnboardingCopilotArgs(),
    {
      cwd,
      env,
      stdio: "inherit",
      windowsHide: false,
    },
  );
  const exit = await waitForExit(child);
  return {
    status: exit.code === 0 && !exit.signal ? "completed" : "exited",
    exitCode: exit.code,
    signal: exit.signal,
    assets,
  };
}

export function buildOnboardingCopilotArgs() {
  return [
    "--agent",
    "pan-setup",
    "--no-auto-update",
    "--interactive",
    ONBOARDING_PROMPT,
  ];
}

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}
